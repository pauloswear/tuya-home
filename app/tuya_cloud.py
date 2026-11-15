"""Cliente da API Cloud oficial da Tuya (OpenAPI).

Usado para os **agendamentos** (timers), que a API de compartilhamento não expõe
mas ficam na nuvem da Tuya e sincronizam com o app. Credenciais vêm do .env:

    TUYA_CLOUD_ENDPOINT=https://openapi.tuyaus.com   # Western America
    TUYA_CLOUD_ACCESS_ID=...
    TUYA_CLOUD_SECRET=...

Assinatura HMAC-SHA256 conforme developer.tuya.com/en/docs/iot/new-singnature.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import threading
import time
from typing import Any

import requests

log = logging.getLogger("tuya-dash")
_EMPTY_BODY_SHA = hashlib.sha256(b"").hexdigest()


class TuyaCloudError(RuntimeError):
    def __init__(self, code: int, msg: str):
        super().__init__(f"Tuya Cloud {code}: {msg}")
        self.code = code
        self.msg = msg


class TuyaCloud:
    def __init__(self, endpoint: str, access_id: str, secret: str):
        self.endpoint = endpoint.rstrip("/")
        self.access_id = access_id
        self.secret = secret
        self._session = requests.Session()
        self._lock = threading.Lock()
        self._token = ""
        self._token_exp = 0.0

    # ----------------------------------------------------------- assinatura
    def _sign(self, method: str, path: str, token: str, body: str) -> dict[str, str]:
        t = str(int(time.time() * 1000))
        content_sha = hashlib.sha256(body.encode()).hexdigest() if body else _EMPTY_BODY_SHA
        string_to_sign = f"{method}\n{content_sha}\n\n{path}"
        message = self.access_id + token + t + string_to_sign
        sign = hmac.new(self.secret.encode(), message.encode(), hashlib.sha256).hexdigest().upper()
        headers = {
            "client_id": self.access_id,
            "sign": sign,
            "t": t,
            "sign_method": "HMAC-SHA256",
            "Content-Type": "application/json",
        }
        if token:
            headers["access_token"] = token
        return headers

    def _token_valid(self) -> bool:
        return bool(self._token) and time.time() < self._token_exp - 60

    def _access_token(self) -> str:
        with self._lock:
            if self._token_valid():
                return self._token
            path = "/v1.0/token?grant_type=1"
            r = self._session.get(self.endpoint + path, headers=self._sign("GET", path, "", ""), timeout=15)
            data = r.json()
            if not data.get("success"):
                raise TuyaCloudError(data.get("code", -1), data.get("msg", "falha ao obter token"))
            res = data["result"]
            self._token = res["access_token"]
            self._token_exp = time.time() + res.get("expire_time", 7200)
            return self._token

    def request(self, method: str, path: str, body: dict | None = None) -> Any:
        import json as _json

        payload = _json.dumps(body, separators=(",", ":")) if body is not None else ""
        token = self._access_token()
        headers = self._sign(method, path, token, payload)
        r = self._session.request(method, self.endpoint + path, headers=headers,
                                  data=payload or None, timeout=20)
        data = r.json()
        if not data.get("success"):
            code = data.get("code", -1)
            # token expirado/invalidado: renova uma vez
            if code in (1010, 1011, 1004) and token:
                self._token = ""
                token = self._access_token()
                headers = self._sign(method, path, token, payload)
                r = self._session.request(method, self.endpoint + path, headers=headers,
                                          data=payload or None, timeout=20)
                data = r.json()
                if data.get("success"):
                    return data.get("result")
            raise TuyaCloudError(code, data.get("msg", "erro"))
        return data.get("result")

    # ------------------------------------------------------------- recursos
    def devices(self) -> list[dict]:
        res = self.request("GET", "/v1.0/iot-01/associated-users/devices?size=100")
        return res.get("devices", []) if isinstance(res, dict) else []

    # ------------------------------------------------------------- timers
    # Categoria = agrupador do app. Usamos uma por tomada+DP para isolar nossos
    # agendamentos; o app lista todas as categorias juntas, então sincroniza.
    def list_timers(self, device_id: str, category: str) -> dict:
        return self.request("GET", f"/v1.0/devices/{device_id}/timers/category?category={category}")

    def add_timer(self, device_id: str, category: str, *, time_hm: str, loops: str,
                  instruct: list[dict], timezone_id: str = "America/Sao_Paulo",
                  alias_name: str = "", is_appoint: bool = False) -> Any:
        body = {
            "category": category,
            "loops": loops,            # 7 bits dom..sáb, ex.: "0111110"
            "instruct": instruct,      # [{"code":"switch_1","value":True}]
            "time": time_hm,           # "HH:MM" 24h
            "timezone_id": timezone_id,
            "is_appoint": is_appoint,
        }
        if alias_name:
            body["alias_name"] = alias_name
        return self.request("POST", f"/v1.0/devices/{device_id}/timers", body)

    def set_timer_status(self, device_id: str, category: str, group_id: str | int, enable: bool) -> Any:
        body = {"category": category, "status": 1 if enable else 0}
        return self.request("PUT", f"/v1.0/devices/{device_id}/timers/{group_id}", body)

    def delete_timer(self, device_id: str, category: str, group_id: str | int) -> Any:
        return self.request("DELETE", f"/v1.0/devices/{device_id}/timers/groups/{group_id}?category={category}")


def from_env(env: dict) -> TuyaCloud | None:
    if not env.get("TUYA_CLOUD_ACCESS_ID"):
        return None
    return TuyaCloud(
        env.get("TUYA_CLOUD_ENDPOINT", "https://openapi.tuyaus.com"),
        env["TUYA_CLOUD_ACCESS_ID"],
        env["TUYA_CLOUD_SECRET"],
    )
