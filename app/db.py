"""Esquema do banco (SQLAlchemy) e migrações automáticas (Alembic).

Para mudar o esquema: edite as tabelas abaixo e gere a migração com

    .venv/bin/alembic revision --autogenerate -m "descreva a mudança"

O servidor aplica as migrações pendentes (``upgrade head``) ao iniciar.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import (
    BigInteger, Column, Double, ForeignKey, Index, Integer, MetaData, PrimaryKeyConstraint, String, Table,
    create_engine, inspect, text,
)
from sqlalchemy.engine import URL, Engine

log = logging.getLogger("tuya-dash")
ROOT = Path(__file__).resolve().parent.parent

metadata = MetaData()

samples = Table(
    "samples", metadata,
    Column("id", BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True),
    Column("device_id", String(64), nullable=False),
    Column("ts", Double(), nullable=False),
    Column("power_w", Double()),
    Column("voltage_v", Double()),
    Column("current_a", Double()),
    Index("ix_samples", "device_id", "ts"),
)

energy_reports = Table(
    "energy_reports", metadata,
    Column("device_id", String(64), nullable=False),
    Column("ts", Double(), nullable=False),
    Column("kwh", Double(), nullable=False),
    PrimaryKeyConstraint("device_id", "ts"),
)


users = Table(
    "users", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("email", String(254), nullable=False, unique=True),  # sempre em minúsculas
    Column("password_hash", String(100), nullable=False),  # bcrypt
    Column("created_at", Double(), nullable=False),
    Column("last_login_at", Double()),
)

sessions = Table(
    "sessions", metadata,
    Column("token_hash", String(64), primary_key=True),  # sha256 do token do cookie
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
    Column("created_at", Double(), nullable=False),
    Column("expires_at", Double(), nullable=False),
    Column("user_agent", String(255)),
)


def database_url(data_dir: Path) -> tuple[URL, str]:
    """MySQL se MYSQL_HOST estiver definido (.env), senão SQLite em data/."""
    if os.environ.get("MYSQL_HOST"):
        url = URL.create(
            "mysql+pymysql",
            username=os.environ.get("MYSQL_USER", "root"),
            password=os.environ.get("MYSQL_PASSWORD", ""),
            host=os.environ["MYSQL_HOST"],
            port=int(os.environ.get("MYSQL_PORT", "3306")),
            database=os.environ.get("MYSQL_DATABASE", "tuya_dash"),
            query={"charset": "utf8mb4"},
        )
        return url, "mysql"
    return URL.create("sqlite", database=str(data_dir / "energy.db")), "sqlite"


def make_engine(url: URL) -> Engine:
    if url.get_backend_name() == "mysql":
        # cria o banco se ainda não existir
        server = create_engine(url.set(database=None), pool_pre_ping=True)
        with server.begin() as c:
            c.execute(text(f"CREATE DATABASE IF NOT EXISTS `{url.database}` CHARACTER SET utf8mb4"))
        server.dispose()
        return create_engine(url, pool_pre_ping=True, pool_recycle=1800)
    return create_engine(url, connect_args={"check_same_thread": False})


def alembic_config() -> Config:
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "migrations"))
    return cfg


BASELINE = "0001"


def migrate(engine: Engine):
    """Aplica as migrações pendentes. Um banco criado antes do Alembic é marcado na revisão base."""
    cfg = alembic_config()
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        tables = set(inspect(conn).get_table_names())
        if "alembic_version" not in tables and {"samples", "energy_reports"} <= tables:
            log.info("banco existente sem histórico de migrações: marcando a revisão %s", BASELINE)
            command.stamp(cfg, BASELINE)
        command.upgrade(cfg, "head")
