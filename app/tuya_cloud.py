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
    @staticmethod
    def _canonical_path(path: str) -> str:
        """A Tuya exige os parâmetros de query ordenados por chave na assinatura."""
        if "?" not in path:
            return path
        base, query = path.split("?", 1)
        parts = [p for p in query.split("&") if p]
        parts.sort(key=lambda kv: kv.split("=", 1)[0])
        return base + "?" + "&".join(parts)

    def _sign(self, method: str, path: str, token: str, body: str) -> dict[str, str]:
        t = str(int(time.time() * 1000))
        content_sha = hashlib.sha256(body.encode()).hexdigest() if body else _EMPTY_BODY_SHA
        string_to_sign = f"{method}\n{content_sha}\n\n{self._canonical_path(path)}"
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
    # Formatos confirmados ao vivo (API "Device Timing Management"):
    #   GET  /v1.0/devices/{id}/timers
    #     -> [ {category:{category,status}, groups:[{id, timers:[
    #            {timer_id, time, loops, date, functions:[{code,value}], status, alias_name, timezone_id} ]}]} ]
    #   POST /v1.0/devices/{id}/timers  (corpo abaixo)  -> {group_id}
    #   DELETE /v1.0/devices/{id}/timers  corpo {category, group_id}
    # loops: 7 dígitos seg..dom (índice 0 = segunda); "0100000" = terça.
    def list_timers(self, device_id: str) -> list:
        res = self.request("GET", f"/v1.0/devices/{device_id}/timers")
        return res if isinstance(res, list) else []

    def add_timer(self, device_id: str, category: str, *, time_hm: str, loops: str,
                  instruct: list[dict], timezone_id: str = "America/Sao_Paulo",
                  time_zone: str = "-03:00", alias_name: str = "") -> Any:
        body = {
            "category": category,
            "loops": loops,                 # 7 dígitos seg..dom
            "time_zone": time_zone,         # offset, ex.: "-03:00"
            "timezone_id": timezone_id,     # IANA, ex.: "America/Sao_Paulo"
            "instruct": [{"time": time_hm, "functions": instruct}],
        }
        if alias_name:
            body["alias_name"] = alias_name
        return self.request("POST", f"/v1.0/devices/{device_id}/timers", body)

    def delete_timer(self, device_id: str, category: str, group_id: str) -> Any:
        return self.request("DELETE", f"/v1.0/devices/{device_id}/timers",
                            {"category": category, "group_id": group_id})

    # ------------------------------------------------------- histórico (logs)
    def report_logs(self, device_id: str, codes: str, start_ms: int, end_ms: int,
                    max_pages: int = 60) -> list[dict]:
        """Histórico bruto dos DPs (a nuvem guarda ~7 dias). Pagina com last_row_key."""
        out: list[dict] = []
        key = None
        for _ in range(max_pages):
            path = (f"/v1.0/devices/{device_id}/report-logs?codes={codes}"
                    f"&end_time={end_ms}&size=100&start_time={start_ms}")
            if key:
                path += f"&last_row_key={key}"
            res = self.request("GET", path)
            out.extend(res.get("logs", []))
            key = res.get("last_row_key")
            if not res.get("has_more") or not key:
                break
        return out


def from_env(env: dict) -> TuyaCloud | None:
    if not env.get("TUYA_CLOUD_ACCESS_ID"):
        return None
    return TuyaCloud(
        env.get("TUYA_CLOUD_ENDPOINT", "https://openapi.tuyaus.com"),
        env["TUYA_CLOUD_ACCESS_ID"],
        env["TUYA_CLOUD_SECRET"],
    )
