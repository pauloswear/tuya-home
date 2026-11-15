"""Login do painel: usuários no banco (senha em bcrypt) e sessões por cookie.

* Sem nenhum usuário cadastrado, o painel pede para criar o primeiro (``/api/setup``).
* O cookie guarda um token aleatório; o banco guarda só o SHA-256 dele, então um
  vazamento da tabela ``sessions`` não permite entrar.
* Tentativas erradas são limitadas por IP e por usuário.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import threading
import time

import bcrypt
from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

from .db import sessions, users

COOKIE = "td_session"
SESSION_TTL_S = 7 * 86400
MIN_PASSWORD = 8
MAX_PASSWORD_BYTES = 72  # limite do bcrypt
EMAIL_RE = r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$"

# bloqueio após falhas: 5 erros em 15 min bloqueiam por 15 min
MAX_FAILS, FAIL_WINDOW_S, LOCK_S = 5, 900, 900

# hash fixo para comparar quando o usuário não existe (tempo de resposta igual)
_DUMMY_HASH = bcrypt.hashpw(b"tuya-dash-dummy-password", bcrypt.gensalt())


class AuthError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def normalize_email(email: str) -> str:
    email = (email or "").strip().lower()
    if len(email) > 254 or not re.match(EMAIL_RE, email):
        raise AuthError(400, "Informe um e-mail válido.")
    return email


def validate_password(password: str):
    if len(password) < MIN_PASSWORD:
        raise AuthError(400, f"A senha precisa ter pelo menos {MIN_PASSWORD} caracteres.")
    if len(password.encode()) > MAX_PASSWORD_BYTES:
        raise AuthError(400, f"A senha pode ter no máximo {MAX_PASSWORD_BYTES} bytes.")


class AuthStore:
    def __init__(self, engine: Engine, available: bool = True):
        self.engine = engine
        # False quando o MySQL configurado caiu e o painel está no SQLite de reserva:
        # aí não se cria usuário (senão qualquer um criaria um admin no banco errado)
        self.available = available
        self._fails: dict[str, list[float]] = {}
        self._locked: dict[str, float] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------ usuários
    def has_users(self) -> bool:
        with self.engine.connect() as c:
            return bool(c.execute(select(func.count()).select_from(users)).scalar())

    def create_first_user(self, email: str, password: str) -> int:
        if not self.available:
            raise AuthError(503, "Banco de usuários indisponível. Verifique a conexão com o MySQL.")
        email = normalize_email(email)
        validate_password(password)
        pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()
        with self.engine.begin() as c:
            # a verificação e a inserção ficam na mesma transação
            if c.execute(select(func.count()).select_from(users)).scalar():
                raise AuthError(409, "Já existe um usuário. Entre com ele.")
            try:
                res = c.execute(insert(users).values(email=email, password_hash=pw_hash, created_at=time.time()))
            except IntegrityError as e:
                raise AuthError(409, "Esse e-mail já está cadastrado.") from e
            return res.inserted_primary_key[0]

    def change_password(self, user_id: int, current: str, new: str):
        validate_password(new)
        with self.engine.begin() as c:
            row = c.execute(select(users.c.password_hash).where(users.c.id == user_id)).first()
            if not row or not bcrypt.checkpw(current.encode(), row[0].encode()):
                raise AuthError(400, "A senha atual não confere.")
            c.execute(update(users).where(users.c.id == user_id)
                      .values(password_hash=bcrypt.hashpw(new.encode(), bcrypt.gensalt(rounds=12)).decode()))

    # ---------------------------------------------------------------- login
    def _check_lock(self, *keys: str):
        now = time.time()
        with self._lock:
            for k in keys:
                until = self._locked.get(k, 0)
                if until > now:
                    mins = int((until - now) // 60) + 1
                    raise AuthError(429, f"Muitas tentativas erradas. Tente de novo em {mins} min.")

    def _register_fail(self, *keys: str):
        now = time.time()
        with self._lock:
            for k in keys:
                hist = [t for t in self._fails.get(k, []) if now - t < FAIL_WINDOW_S] + [now]
                self._fails[k] = hist
                if len(hist) >= MAX_FAILS:
                    self._locked[k] = now + LOCK_S
                    self._fails[k] = []

    def login(self, email: str, password: str, ip: str, user_agent: str | None) -> tuple[str, dict]:
        email = (email or "").strip().lower()
        keys = (f"ip:{ip}", f"user:{email}")
        self._check_lock(*keys)
        with self.engine.connect() as c:
            row = c.execute(select(users.c.id, users.c.email, users.c.password_hash)
                            .where(users.c.email == email)).first()
        ok = bcrypt.checkpw(password.encode()[:MAX_PASSWORD_BYTES],
                            row.password_hash.encode() if row else _DUMMY_HASH)
        if not row or not ok:
            self._register_fail(*keys)
            raise AuthError(401, "E-mail ou senha incorretos.")
        with self._lock:
            for k in keys:
                self._fails.pop(k, None)
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self.engine.begin() as c:
            c.execute(delete(sessions).where(sessions.c.expires_at < now))
            c.execute(insert(sessions).values(
                token_hash=_token_hash(token), user_id=row.id, created_at=now,
                expires_at=now + SESSION_TTL_S, user_agent=(user_agent or "")[:255]))
            c.execute(update(users).where(users.c.id == row.id).values(last_login_at=now))
        return token, {"id": row.id, "email": row.email}

    def session_user(self, token: str | None) -> dict | None:
        if not token:
            return None
        with self.engine.connect() as c:
            row = c.execute(
                select(users.c.id, users.c.email, sessions.c.expires_at)
                .join(users, users.c.id == sessions.c.user_id)
                .where(sessions.c.token_hash == _token_hash(token))
            ).first()
        if not row or row.expires_at < time.time():
            return None
        return {"id": row.id, "email": row.email}

    def logout(self, token: str | None):
        if token:
            with self.engine.begin() as c:
                c.execute(delete(sessions).where(sessions.c.token_hash == _token_hash(token)))
