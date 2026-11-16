from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import qrcode
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .auth import COOKIE, SESSION_TTL_S, AuthError, AuthStore
from .tuya_cloud import TuyaCloudError, from_env
from .tuya_service import TuyaService, qr_payload

from .settings import DATA_DIR, ROOT, load_env

DATA_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("tuya-dash")


load_env()
service = TuyaService(DATA_DIR)
cloud = from_env(os.environ)  # API Cloud oficial (agendamentos); None se o .env não tiver credenciais
# usuários só podem ser criados no banco configurado (não no SQLite de reserva)
auth = AuthStore(service.energy.engine, available=service.energy.error is None)

RANGES = {"1h": 3600, "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400}
BUCKETS = {"1h": 60, "6h": 72, "24h": 96, "7d": 84, "30d": 60}


def window(range: str) -> tuple[float, int, float | None]:
    """Início, número de intervalos e largura fixa (s). "today" = desde 00:00 local, blocos de 15 min."""
    now = time.time()
    if range == "today":
        lt = time.localtime(now)
        since = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
        return since, int((now - since) // 900) + 1, 900.0
    if range == "1h":
        since = (now // 60) * 60 - 3540  # minutos cheios
        return since, 60, 60.0
    return now - RANGES.get(range, 86400), BUCKETS.get(range, 96), None


@asynccontextmanager
async def lifespan(app: FastAPI):
    service.loop = asyncio.get_running_loop()
    try:
        await run_in_threadpool(service.connect)
    except Exception as e:  # noqa: BLE001
        service.last_error = str(e)
        log.exception("não foi possível conectar com a sessão salva")
    threading.Thread(target=service.poll_forever, daemon=True).start()
    if cloud is not None:
        threading.Thread(target=backfill_cloud_history, daemon=True).start()
    yield
    service.stop()


# Escalas dos DPs de medição (valor bruto -> unidade)
_LOG_SCALE = {"add_ele": 1000.0, "cur_power": 10.0, "cur_voltage": 10.0, "cur_current": 1000.0}


def backfill_cloud_history(days: int = 7):
    """Puxa da nuvem (report-logs, ~7 dias) o histórico real de energia e potência.

    Energia (add_ele) é sempre reimportada — deduplicada por timestamp. A potência só
    preenche o período anterior ao que o painel já gravou, para não duplicar amostras.
    """
    if cloud is None or not service.connected:
        return
    now_ms = int(time.time() * 1000)
    start_ms = now_ms - days * 86400 * 1000
    for d in service.devices():
        if not d.get("metering"):
            continue
        did = d["id"]
        try:
            n_ele = 0
            for e in cloud.report_logs(did, "add_ele", start_ms, now_ms):
                try:
                    service.energy.add_energy(did, float(e["value"]) / _LOG_SCALE["add_ele"],
                                              int(e["event_time"]) / 1000.0)
                    n_ele += 1
                except (ValueError, KeyError, TypeError):
                    pass
            earliest = service.energy.earliest_sample(did)
            end_p = int((earliest - 1) * 1000) if earliest else now_ms
            n_s = 0
            if end_p > start_ms:
                by_ts: dict[int, dict] = {}
                for e in cloud.report_logs(did, "cur_power,cur_voltage,cur_current", start_ms, end_p):
                    try:
                        ts = int(e["event_time"]) / 1000.0
                        v = float(e["value"])
                    except (ValueError, KeyError, TypeError):
                        continue
                    row = by_ts.setdefault(round(ts), {"device_id": did, "ts": ts,
                                                       "power_w": None, "voltage_v": None, "current_a": None})
                    sc = _LOG_SCALE.get(e["code"])
                    if e["code"] == "cur_power":
                        row["power_w"] = v / sc
                    elif e["code"] == "cur_voltage":
                        row["voltage_v"] = v / sc
                    elif e["code"] == "cur_current":
                        row["current_a"] = v / sc
                rows = [r for r in by_ts.values() if r["power_w"] is not None or r["voltage_v"] is not None]
                service.energy.add_samples_bulk(rows)
                n_s = len(rows)
            log.info("backfill nuvem %s (%s): %d energia, %d potência", d["name"], did, n_ele, n_s)
        except Exception as e:  # noqa: BLE001
            log.warning("backfill da nuvem falhou para %s: %s", did, e)


app = FastAPI(title="Tuya Dash", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

PUBLIC_API = {"/api/session", "/api/session/login", "/api/session/setup"}


@app.middleware("http")
async def require_login(request: Request, call_next):
    """Toda a API exige sessão, exceto login e criação do primeiro usuário.
    Pedidos que alteram algo precisam vir do próprio site (Origin igual ao Host)."""
    path = request.url.path
    if path.startswith("/api/"):
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            if origin and origin.split("://", 1)[-1] != request.headers.get("host"):
                return JSONResponse({"detail": "Origem não permitida."}, status_code=403)
        if path not in PUBLIC_API:
            user = await run_in_threadpool(auth.session_user, request.cookies.get(COOKIE))
            if not user:
                return JSONResponse({"detail": "Faça login para continuar.", "code": "login"}, status_code=401)
            request.state.user = user
    response = await call_next(request)
    if path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def _require():
    if not service.connected:
        raise HTTPException(409, "não conectado à conta Tuya")


# ------------------------------------------------------------ login do painel
class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=200)


class PasswordChange(BaseModel):
    current: str = Field(min_length=1, max_length=200)
    new: str = Field(min_length=1, max_length=200)


def _set_cookie(response: JSONResponse, request: Request, token: str):
    response.set_cookie(
        COOKIE, token, max_age=SESSION_TTL_S, httponly=True, samesite="strict",
        secure=request.url.scheme == "https", path="/",
    )


def _auth_error(e: AuthError):
    return JSONResponse({"detail": e.message}, status_code=e.status)


@app.get("/api/session")
async def session_state(request: Request):
    user = await run_in_threadpool(auth.session_user, request.cookies.get(COOKIE))
    has_users = await run_in_threadpool(auth.has_users)
    return {
        "authenticated": bool(user),
        "email": user["email"] if user else None,
        "needs_setup": not has_users and auth.available,
        "available": auth.available,
    }


@app.post("/api/session/setup")
async def session_setup(body: Credentials, request: Request):
    try:
        await run_in_threadpool(auth.create_first_user, body.email, body.password)
        token, user = await run_in_threadpool(
            auth.login, body.email, body.password, request.client.host, request.headers.get("user-agent"))
    except AuthError as e:
        return _auth_error(e)
    log.info("primeiro usuário criado: %s", user["email"])
    resp = JSONResponse({"ok": True, "email": user["email"]})
    _set_cookie(resp, request, token)
    return resp


@app.post("/api/session/login")
async def session_login(body: Credentials, request: Request):
    try:
        token, user = await run_in_threadpool(
            auth.login, body.email, body.password, request.client.host, request.headers.get("user-agent"))
    except AuthError as e:
        return _auth_error(e)
    resp = JSONResponse({"ok": True, "email": user["email"]})
    _set_cookie(resp, request, token)
    return resp


@app.post("/api/session/logout")
async def session_logout(request: Request):
    await run_in_threadpool(auth.logout, request.cookies.get(COOKIE))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path="/")
    return resp


@app.post("/api/session/password")
async def session_password(body: PasswordChange, request: Request):
    try:
        await run_in_threadpool(auth.change_password, request.state.user["id"], body.current, body.new)
    except AuthError as e:
        return _auth_error(e)
    return {"ok": True}


# ---------------------------------------------------------------------- auth
class QrRequest(BaseModel):
    user_code: str = Field(min_length=3, max_length=64)


@app.get("/api/auth/status")
def auth_status():
    cfg = service._load() or {}
    return {
        "connected": service.connected,
        "username": cfg.get("username"),
        "endpoint": cfg.get("endpoint"),
        "error": service.last_error,
        "storage": service.energy.kind,
        "storage_error": service.energy.error,
        "schedules": cloud is not None,
    }


@app.post("/api/auth/qr")
async def auth_qr(body: QrRequest):
    try:
        token = await run_in_threadpool(service.start_qr, body.user_code.strip())
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, str(e)) from e
    img = qrcode.make(qr_payload(token), box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return {
        "token": token,
        "qr": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(),
    }


@app.get("/api/auth/poll/{token}")
async def auth_poll(token: str):
    try:
        ok = await run_in_threadpool(service.poll_qr, token)
    except KeyError as e:
        raise HTTPException(404, "token expirado") from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, str(e)) from e
    return {"connected": ok}


@app.post("/api/auth/logout")
async def auth_logout():
    await run_in_threadpool(service.logout)
    return {"ok": True}


# ------------------------------------------------------------------- devices
@app.get("/api/devices")
def list_devices():
    _require()
    return {"homes": service.homes(), "devices": service.devices()}


@app.post("/api/refresh")
async def refresh():
    _require()
    await run_in_threadpool(service.connect)
    return {"ok": True}


@app.get("/api/devices/{device_id}")
def device_detail(device_id: str):
    _require()
    try:
        return service.serialize(service.device(device_id), include_key=True)
    except KeyError as e:
        raise HTTPException(404, "dispositivo não encontrado") from e


class Command(BaseModel):
    code: str
    value: Any


class CommandBody(BaseModel):
    commands: list[Command]


@app.post("/api/devices/{device_id}/commands")
async def send_commands(device_id: str, body: CommandBody):
    _require()
    cmds = [c.model_dump() for c in body.commands]
    try:
        await run_in_threadpool(service.send, device_id, cmds)
    except KeyError as e:
        raise HTTPException(404, "dispositivo não encontrado") from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Tuya recusou o comando: {e}") from e
    return {"ok": True}


class ParentBody(BaseModel):
    parent_id: str | None = Field(default=None, max_length=64)


@app.post("/api/devices/{device_id}/parent")
async def set_parent(device_id: str, body: ParentBody):
    """Marca a tomada como ligada dentro de outra (ou de volta direto na parede)."""
    _require()
    try:
        dev = service.device(device_id)
        par = service.device(body.parent_id) if body.parent_id else None
    except KeyError as e:
        raise HTTPException(404, "dispositivo não encontrado") from e
    if not service.metering(dev) or (par and not service.metering(par)):
        raise HTTPException(400, "Só dá para aninhar tomadas que medem consumo.")
    if par and par.id == device_id:
        raise HTTPException(400, "Uma tomada não pode estar dentro dela mesma.")
    if par:
        # sem ciclos: a de fora não pode estar (direta ou indiretamente) dentro desta
        parents, cur = service.energy.parents(), par.id
        while cur:
            if cur == device_id:
                raise HTTPException(400, f"“{par.name}” já está ligada dentro de “{dev.name}”.")
            cur = parents.get(cur)
    await run_in_threadpool(service.energy.set_parent, device_id, par.id if par else None)
    service._broadcast({"type": "reload"})
    return {"ok": True, "parent_id": par.id if par else None}


# -------------------------------------------------------------------- energy
@app.get("/api/devices/{device_id}/energy")
def device_energy(device_id: str, range: str = "24h"):
    _require()
    since, buckets, width = window(range)
    return service.energy.series(device_id, since, buckets, width)


def _nesting(metered: list[dict]) -> tuple[dict[str, str], dict[str, list[str]]]:
    """Pais válidos (só entre tomadas com medição presentes) e filhos diretos de cada uma.
    Uma tomada cujo pai sumiu da conta volta a contar como de fora."""
    ids = {d["id"] for d in metered}
    parent = {d["id"]: d["parent_id"] for d in metered if d.get("parent_id") in ids}
    children: dict[str, list[str]] = {}
    for c, p in parent.items():
        children.setdefault(p, []).append(c)
    return parent, children


def _own(value: float | None, kids: list[float | None]) -> float | None:
    """Parte da medição que é só da tomada (sem as de dentro). Nunca negativa: as
    medições não são simultâneas, então a diferença pode oscilar um pouco abaixo de zero."""
    if value is None:
        return None
    return max(0.0, value - sum(k or 0 for k in kids))


@app.get("/api/energy/summary")
def energy_summary(range: str = "24h"):
    _require()
    since, _, _ = window(range)
    metered = [d for d in service.devices() if d["metering"]]
    parent, children = _nesting(metered)
    totals = service.energy.totals([d["id"] for d in metered], since)
    power = {d["id"]: (d["metering"] or {}).get("power_w") if d["online"] else None for d in metered}
    out = []
    for d in metered:
        kids = children.get(d["id"], [])
        kwh = totals.get(d["id"], 0)
        own_kwh = _own(kwh, [totals.get(k, 0) for k in kids])
        own_w = _own(power[d["id"]], [power[k] for k in kids])
        out.append({"id": d["id"], "name": d["name"], "kwh": kwh, "power_w": (d["metering"] or {}).get("power_w"),
                    "parent_id": parent.get(d["id"]), "children": kids,
                    "own_kwh": round(own_kwh, 4), "own_power_w": None if own_w is None else round(own_w, 1)})
    top = [d["id"] for d in metered if d["id"] not in parent]
    return {
        "range": range,
        "since": since,
        "devices": out,
        # só as tomadas de fora: o consumo das de dentro já está na medição delas
        "total_kwh": round(sum(totals.get(i, 0) for i in top), 4),
        "total_power_w": round(sum(power[i] or 0 for i in top), 1),
    }


@app.get("/api/energy/total")
def energy_total(range: str = "24h"):
    """Soma das séries das tomadas com medição (potência média e kWh por intervalo).
    Tomadas ligadas dentro de outra ficam de fora: já estão na medição da de fora."""
    _require()
    since, buckets, width = window(range)
    metered = [d for d in service.devices() if d["metering"]]
    parent, _ = _nesting(metered)
    ids = [d["id"] for d in metered if d["id"] not in parent]
    out = None
    for i in ids:
        s = service.energy.series(i, since, buckets, width)
        kwh = s["kwh_measured"] if s["has_measured"] else s["kwh_estimated"]
        if out is None:
            out = {"since": s["since"], "until": s["until"], "bucket_seconds": s["bucket_seconds"],
                   "avg_power_w": [None] * buckets, "kwh": [None] * buckets, "samples": 0}
        add = lambda a, b: b if a is None else a if b is None else a + b  # noqa: E731
        out["avg_power_w"] = [add(a, b) for a, b in zip(out["avg_power_w"], s["avg_power_w"])]
        out["kwh"] = [add(a, b) for a, b in zip(out["kwh"], kwh)]
        out["samples"] += s["samples"]
    if out is None:
        return {"since": since, "until": time.time(), "bucket_seconds": width or (time.time() - since) / buckets,
                "avg_power_w": [], "kwh": [], "samples": 0, "total_kwh": 0}
    out["avg_power_w"] = [None if v is None else round(v, 2) for v in out["avg_power_w"]]
    out["kwh"] = [None if v is None else round(v, 5) for v in out["kwh"]]
    out["total_kwh"] = round(sum(v or 0 for v in out["kwh"]), 4)
    return out


# -------------------------------------------------------------------- scenes
@app.get("/api/scenes")
async def scenes():
    _require()
    return await run_in_threadpool(service.scenes)


@app.post("/api/scenes/{home_id}/{scene_id}/trigger")
async def trigger(home_id: str, scene_id: str):
    _require()
    await run_in_threadpool(service.trigger_scene, home_id, scene_id)
    return {"ok": True}


# ------------------------------------------------------------- agendamentos
# API Cloud oficial da Tuya (Device Timing Management). loops: 7 dígitos seg..dom.
CATEGORY = "schedule"  # categoria dos agendamentos criados pelo painel


def _require_cloud():
    _require()
    if cloud is None:
        raise HTTPException(501, "Agendamentos exigem as credenciais da API Cloud da Tuya no .env.")


def _switch_code(device_id: str) -> str:
    """Código do DP de liga/desliga da tomada (switch_1/switch/switch_led)."""
    try:
        dev = service.device(device_id)
        for c in ("switch_led", "switch_1", "switch", "switch_2"):
            if c in dev.function:
                return c
    except KeyError:
        pass
    return "switch_1"


@app.get("/api/schedules/{device_id}")
async def list_schedules(device_id: str):
    """Lista todos os agendamentos da nuvem, achatando categoria→grupos→timers."""
    _require_cloud()
    code = _switch_code(device_id)
    try:
        cats = await run_in_threadpool(cloud.list_timers, device_id)
    except TuyaCloudError as e:
        raise HTTPException(502, e.msg) from e
    items = []
    for cat in cats or []:
        cname = (cat.get("category") or {}).get("category") if isinstance(cat.get("category"), dict) else cat.get("category")
        for grp in cat.get("groups", []):
            for t in grp.get("timers", []):
                value = next((f.get("value") for f in t.get("functions", []) if f.get("code") == code), None)
                items.append({
                    "group_id": grp.get("id"),
                    "category": cname,
                    "time": t.get("time"),
                    "loops": t.get("loops", "0000000"),
                    "value": value,
                    "action_code": code,
                    "enabled": t.get("status", 1) == 1,
                    "alias": t.get("alias_name", ""),
                    "editable": cname == CATEGORY and value is not None,
                })
    items.sort(key=lambda x: (x["time"] or ""))
    return {"device_id": device_id, "switch_code": code, "schedules": items}


class ScheduleBody(BaseModel):
    time: str = Field(pattern=r"^\d{2}:\d{2}$")
    loops: str = Field(pattern=r"^[01]{7}$")  # seg..dom
    value: bool
    alias: str = Field(default="", max_length=64)


@app.post("/api/schedules/{device_id}")
async def add_schedule(device_id: str, body: ScheduleBody):
    _require_cloud()
    if body.loops == "0000000":
        raise HTTPException(400, "Escolha pelo menos um dia da semana.")
    code = _switch_code(device_id)
    try:
        await run_in_threadpool(
            cloud.add_timer, device_id, CATEGORY,
            time_hm=body.time, loops=body.loops,
            instruct=[{"code": code, "value": body.value}], alias_name=body.alias,
        )
    except TuyaCloudError as e:
        raise HTTPException(502, e.msg) from e
    return {"ok": True}


@app.delete("/api/schedules/{device_id}/{group_id}")
async def remove_schedule(device_id: str, group_id: str, category: str = CATEGORY):
    _require_cloud()
    try:
        await run_in_threadpool(cloud.delete_timer, device_id, category, group_id)
    except TuyaCloudError as e:
        raise HTTPException(502, e.msg) from e
    return {"ok": True}


# -------------------------------------------------------------------- events
@app.get("/api/events")
async def events(request: Request):
    q = service.new_subscriber()

    async def gen():
        try:
            yield "retry: 3000\n\n"
            while not await request.is_disconnected():
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=20)
                    yield f"data: {json.dumps(ev, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            service.subscribers.discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------- SPA
STATIC = ROOT / "static"
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    return FileResponse(STATIC / "index.html")
