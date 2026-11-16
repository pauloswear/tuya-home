"""Integração com a nuvem Tuya via a API de compartilhamento (QR code).

O app Tuya Smart (com.tuya.smart 7.12.6) registra o esquema ``tuyaSmart`` e,
ao ler um QR code, troca ``xSmart--rota`` por ``xSmart://rota``; a rota
``qrLogin?token=...`` abre ``QRCodeAuthActivity``, que autoriza um terminal
externo. É o mesmo fluxo usado pela integração oficial do Home Assistant, e a
biblioteca ``tuya-device-sharing-sdk`` implementa o lado do cliente.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

from tuya_sharing import (
    CustomerDevice,
    LoginControl,
    Manager,
    SharingDeviceListener,
    SharingTokenListener,
)

from .energy import EnergyStore

log = logging.getLogger("tuya-dash")

# Credenciais públicas da integração Smart Life do Home Assistant (o endpoint
# de QR só aceita client ids cadastrados). Podem ser trocadas por variáveis de
# ambiente se você tiver outro client id.
CLIENT_ID = "HA_3y9q4ak7g4ephrvke"
SCHEMA = "haauthorize"
QR_PREFIX = "tuyaSmart--qrLogin?token="

STATUS_POLL_S = 5       # status leve (1 requisição para todas as tomadas)
MAX_BACKOFF_S = 60      # em erro, o intervalo dobra até este limite
FULL_REFRESH_S = 1800   # recarga completa (especificações, nomes, cômodos)

CATEGORY_LABELS = {
    "cz": "Tomada",
    "pc": "Filtro de linha",
    "kg": "Interruptor",
    "tdq": "Disjuntor",
    "dlq": "Disjuntor",
    "zndb": "Medidor de energia",
    "dj": "Lâmpada",
    "dd": "Fita LED",
    "xdd": "Luz de teto",
    "fwd": "Luz ambiente",
    "dc": "Cordão de luz",
    "tgq": "Dimmer",
    "tgkg": "Dimmer",
    "fs": "Ventilador",
    "kt": "Ar-condicionado",
    "wsdcg": "Sensor temp./umidade",
    "pir": "Sensor de presença",
    "mcs": "Sensor de porta",
    "cl": "Cortina",
    "sp": "Câmera",
    "wg2": "Gateway",
}
LIGHT_CATEGORIES = {"dj", "dd", "xdd", "fwd", "dc", "tgq", "tgkg", "fsd", "gyd", "sxd"}
PLUG_CATEGORIES = {"cz", "pc", "kg", "tdq", "dlq", "zndb", "znrb"}

POWER_CODES = ("cur_power", "power", "phase_a_power")
VOLTAGE_CODES = ("cur_voltage", "voltage")
CURRENT_CODES = ("cur_current", "current")
ENERGY_CODES = ("add_ele", "total_forward_energy", "forward_energy_total")


def _parse_values(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except (TypeError, json.JSONDecodeError):
        return {}


class TuyaService:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.config_path = data_dir / "config.json"
        self.energy = EnergyStore(data_dir)
        self.manager: Manager | None = None
        self.rooms: dict[str, str] = {}
        self.loop: asyncio.AbstractEventLoop | None = None
        self.subscribers: set[asyncio.Queue] = set()
        self._login = LoginControl()
        self._pending: dict[str, str] = {}  # qr token -> user_code
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._kick = threading.Event()  # pede uma leitura imediata (ex.: logo após um comando)
        self.last_error: str | None = None

    # ------------------------------------------------------------ persistência
    def _load(self) -> dict | None:
        if self.config_path.exists():
            return json.loads(self.config_path.read_text())
        return None

    def _save(self, cfg: dict):
        tmp = self.config_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(cfg, indent=2))
        tmp.chmod(0o600)
        tmp.replace(self.config_path)

    @property
    def connected(self) -> bool:
        return self.manager is not None

    # ------------------------------------------------------------------- login
    def start_qr(self, user_code: str) -> str:
        resp = self._login.qr_code(CLIENT_ID, SCHEMA, user_code)
        if not resp.get("success"):
            raise RuntimeError(resp.get("msg") or f"Falha ao gerar QR: {resp}")
        token = resp["result"]["qrcode"]
        self._pending[token] = user_code
        return token

    def poll_qr(self, token: str) -> bool:
        user_code = self._pending.get(token)
        if not user_code:
            raise KeyError("token desconhecido")
        ok, info = self._login.login_result(token, CLIENT_ID, user_code)
        if not ok:
            return False
        cfg = {
            "user_code": user_code,
            "terminal_id": info["terminal_id"],
            "endpoint": info["endpoint"],
            "username": info.get("username"),
            "token": {
                "t": info["t"],
                "uid": info["uid"],
                "expire_time": info["expire_time"],
                "access_token": info["access_token"],
                "refresh_token": info["refresh_token"],
            },
        }
        self._save(cfg)
        self._pending.pop(token, None)
        self.connect()
        return True

    def logout(self):
        with self._lock:
            if self.manager:
                try:
                    if self.manager.mq:
                        self.manager.mq.stop()
                    self.manager.unload()
                except Exception:  # noqa: BLE001
                    log.exception("erro ao encerrar sessão")
            self.manager = None
            if self.config_path.exists():
                self.config_path.unlink()
        self._broadcast({"type": "auth", "connected": False})

    # --------------------------------------------------------------- conexão
    def connect(self):
        cfg = self._load()
        if not cfg:
            return
        service = self

        class TokenListener(SharingTokenListener):
            def update_token(self, token_info: dict[str, Any]):
                cur = service._load() or cfg
                cur["token"] = token_info
                service._save(cur)

        class DeviceListener(SharingDeviceListener):
            def update_device(self, device, updated_status_properties=None, dp_timestamps=None):
                service._on_update(device, updated_status_properties or [], dp_timestamps or {})

            def add_device(self, device):
                service._broadcast({"type": "reload"})

            def remove_device(self, device_id):
                service._broadcast({"type": "reload"})

        with self._lock:
            mgr = Manager(
                CLIENT_ID,
                cfg["user_code"],
                cfg["terminal_id"],
                cfg["endpoint"],
                cfg["token"],
                TokenListener(),
            )
            mgr.update_device_cache()
            mgr.add_device_listener(DeviceListener())
            mgr.refresh_mq()
            self.manager = mgr
            self._load_rooms()
            self._record_all_samples()
            self.last_error = None
        log.info("conectado: %d dispositivos", len(mgr.device_map))
        self._broadcast({"type": "reload"})

    def _load_rooms(self):
        self.rooms = {}
        for dev_id in list(self.manager.device_map):
            try:
                room = self.manager.query_room_by_device(dev_id)
                if room:
                    self.rooms[dev_id] = room.name
            except Exception:  # noqa: BLE001
                pass

    def poll_forever(self):
        """Lê o status de todas as tomadas a cada STATUS_POLL_S segundos.

        Medido em 15/11/2026: a nuvem atualiza cur_power a cada ~10 s, mas o MQTT da API de
        compartilhamento não repassa essas leituras. Uma consulta leve resolve.
        """
        last_full = time.time()
        delay = STATUS_POLL_S
        while not self._stop.is_set():
            self._kick.wait(delay)
            self._kick.clear()
            if self._stop.is_set():
                break
            if not self.manager:
                continue
            self._broadcast({"type": "poll", "state": "start"})
            started = time.time()
            try:
                if time.time() - last_full > FULL_REFRESH_S:
                    with self._lock:
                        ids = list(self.manager.device_map)
                        if ids:
                            self.manager._update_device_list_info_cache(ids)
                    last_full = time.time()
                    self._record_all_samples()
                    self._broadcast({"type": "reload"})
                else:
                    self.refresh_status()
                self.last_error = None
                # mantém o ritmo: desconta o tempo que a requisição levou
                delay = max(0.5, STATUS_POLL_S - (time.time() - started))
            except Exception as e:  # noqa: BLE001
                self.last_error = str(e)
                delay = min(max(delay, STATUS_POLL_S) * 2, MAX_BACKOFF_S)
                log.warning("falha ao ler status (próxima em %ss): %s", delay, e)
            self._broadcast({"type": "poll", "state": "end", "ok": self.last_error is None,
                             "at": time.time(), "next_s": delay})

    def refresh_status(self):
        """Uma requisição traz status e online de todas as tomadas; só o que mudou é enviado à tela."""
        ids = list(self.manager.device_map)
        if not ids:
            return
        resp = self.manager.customer_api.get("/v1.0/m/life/ha/devices/detail", {"devIds": ",".join(ids)})
        if not resp.get("success"):
            raise RuntimeError(resp.get("msg") or "falha ao consultar status")
        for item in resp.get("result", []):
            dev = self.manager.device_map.get(item.get("id"))
            if not dev:
                continue
            new = {s["code"]: s["value"] for s in item.get("status", []) if "code" in s}
            changed = [c for c, v in new.items() if dev.status.get(c) != v]
            online_changed = bool(item.get("online")) != bool(dev.online)
            dev.online = bool(item.get("online"))
            dev.status.update(new)
            # a cada leitura grava a potência (mesmo sem mudança), como batimento para a integração
            if not dev.online and self.metering(dev):
                self.energy.add_sample(dev.id, 0.0, None, None)
            else:
                self._record_sample(dev)
            if changed or online_changed:
                # add_ele vindo do polling não é somado (seria contado duas vezes com o MQTT)
                self._broadcast({"type": "device", "device": self.serialize(dev)})

    def refresh_soon(self, *delays: float):
        """Agenda leituras extras (em segundos a partir de agora)."""
        for d in delays:
            t = threading.Timer(d, self._kick.set)
            t.daemon = True
            t.start()

    def stop(self):
        self._stop.set()
        self._kick.set()
        if self.manager and self.manager.mq:
            self.manager.mq.stop()

    # ---------------------------------------------------------------- eventos
    def _on_update(self, device: CustomerDevice, updated: list[str], dp_ts: dict):
        if any(c in updated for c in POWER_CODES + VOLTAGE_CODES + CURRENT_CODES):
            self._record_sample(device)
        for code in ENERGY_CODES:
            if code in updated:
                ts = dp_ts.get(code)
                ts = ts / 1000 if ts else time.time()
                val = self._scaled(device, code)
                if isinstance(val, (int, float)):
                    self.energy.add_energy(device.id, float(val), ts)
        self._broadcast({"type": "device", "device": self.serialize(device)})

    def _broadcast(self, event: dict):
        if not self.loop:
            return
        for q in list(self.subscribers):
            self.loop.call_soon_threadsafe(q.put_nowait, event)

    def _record_sample(self, device: CustomerDevice):
        m = self.metering(device)
        if m:
            self.energy.add_sample(device.id, m.get("power_w"), m.get("voltage_v"), m.get("current_a"))

    def _record_all_samples(self):
        for dev in list(self.manager.device_map.values()):
            # potência 0 quando offline, para não "segurar" a última leitura
            if not dev.online and self.metering(dev):
                self.energy.add_sample(dev.id, 0.0, None, None)
            else:
                self._record_sample(dev)

    # -------------------------------------------------------------- serializar
    def _scaled(self, device: CustomerDevice, code: str):
        value = device.status.get(code)
        spec = device.status_range.get(code) or device.function.get(code)
        if spec is None or not isinstance(value, (int, float)) or isinstance(value, bool):
            return value
        scale = _parse_values(spec.values).get("scale", 0) or 0
        return value / (10**scale) if scale else value

    def _unit(self, device: CustomerDevice, code: str) -> str:
        spec = device.status_range.get(code) or device.function.get(code)
        return _parse_values(spec.values).get("unit", "") if spec else ""

    def metering(self, device: CustomerDevice) -> dict | None:
        out: dict[str, float] = {}
        for code in POWER_CODES:
            if code in device.status:
                v = self._scaled(device, code)
                if isinstance(v, (int, float)):
                    out["power_w"] = (v * 1000) if self._unit(device, code).lower() == "kw" else v
                break
        for code in VOLTAGE_CODES:
            if code in device.status:
                v = self._scaled(device, code)
                if isinstance(v, (int, float)):
                    out["voltage_v"] = v
                break
        for code in CURRENT_CODES:
            if code in device.status:
                v = self._scaled(device, code)
                if isinstance(v, (int, float)):
                    out["current_a"] = v / 1000 if self._unit(device, code) == "mA" else v
                break
        return out or None

    def serialize(self, device: CustomerDevice, include_key: bool = False) -> dict:
        codes = list(dict.fromkeys([*device.status.keys(), *device.function.keys()]))
        dps = []
        for code in codes:
            fn = device.function.get(code)
            st = device.status_range.get(code)
            spec = fn or st
            dps.append(
                {
                    "code": code,
                    "name": getattr(fn, "name", None) or code,
                    "type": getattr(spec, "type", None),
                    "values": _parse_values(getattr(spec, "values", None)),
                    "writable": fn is not None,
                    "value": device.status.get(code),
                    "report_type": getattr(st, "report_type", None),
                }
            )
        icon = device.icon or ""
        if icon and not icon.startswith("http"):
            icon = f"https://images.tuyaus.com/{icon}"
        data = {
            "id": device.id,
            "name": device.name,
            "category": device.category,
            "category_label": CATEGORY_LABELS.get(device.category, device.category),
            "kind": "light" if device.category in LIGHT_CATEGORIES
            else "plug" if device.category in PLUG_CATEGORIES else "other",
            "product_name": device.product_name,
            "online": bool(device.online),
            "icon": icon,
            "room": self.rooms.get(device.id),
            "metering": self.metering(device),
            "parent_id": self.energy.parents().get(device.id),
            "dps": dps,
            "update_time": getattr(device, "update_time", None),
        }
        if include_key:
            data.update(
                {
                    "local_key": device.local_key,
                    "ip": device.ip,
                    "uuid": device.uuid,
                    "product_id": device.product_id,
                    "time_zone": device.time_zone,
                    "active_time": device.active_time,
                    "create_time": device.create_time,
                    "sub": device.sub,
                }
            )
        return data

    # --------------------------------------------------------------- comandos
    def devices(self) -> list[dict]:
        if not self.manager:
            return []
        return [self.serialize(d) for d in self.manager.device_map.values()]

    def device(self, device_id: str) -> CustomerDevice:
        if not self.manager or device_id not in self.manager.device_map:
            raise KeyError(device_id)
        return self.manager.device_map[device_id]

    def send(self, device_id: str, commands: list[dict]) -> dict:
        self.device(device_id)
        # chamada direta (o send_commands da SDK descarta a resposta e filtra repetições)
        resp = self.manager.customer_api.post(
            f"/v1.1/m/thing/{device_id}/commands", None, {"commands": commands}
        )
        if not resp.get("success"):
            raise RuntimeError(resp.get("msg") or str(resp))
        # aplica otimisticamente; o MQTT confirma logo depois
        dev = self.manager.device_map[device_id]
        for c in commands:
            dev.status[c["code"]] = c["value"]
        self._broadcast({"type": "device", "device": self.serialize(dev)})
        # o estado chega em ~1-3 s, mas a potência leva mais: a carga sobe e a nuvem
        # só atualiza cur_power a cada ~10 s. Relê ao longo de ~15 s para pegar a subida.
        self.refresh_soon(1.0, 3.5, 8.0, 13.0)
        return resp

    def homes(self) -> list[dict]:
        if not self.manager:
            return []
        return [{"id": h.id, "name": h.name} for h in self.manager.user_homes]

    def scenes(self) -> list[dict]:
        if not self.manager:
            return []
        return [
            {"id": s.scene_id, "home_id": s.home_id, "name": s.name, "enabled": s.enabled}
            for s in self.manager.query_scenes()
        ]

    def trigger_scene(self, home_id: str, scene_id: str):
        self.manager.trigger_scene(home_id, scene_id)
        self.refresh_soon(1.5, 4.0, 8.0, 13.0)

    def new_subscriber(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self.subscribers.add(q)
        return q


def qr_payload(token: str) -> str:
    return QR_PREFIX + token

