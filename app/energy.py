"""Histórico de consumo (MySQL quando configurado, senão SQLite local).

A API de compartilhamento não expõe o histórico de energia da nuvem, então o
painel grava as leituras que recebe (MQTT em tempo real + polling periódico) e
calcula o consumo a partir delas:

* ``samples``: potência/tensão/corrente instantâneas.
* ``energy_reports``: incrementos de ``add_ele`` reportados pelo dispositivo
  (nas tomadas Tuya, cada relatório de ``add_ele`` é o delta desde o anterior).
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
from pathlib import Path

from sqlalchemy import delete, insert, select

from .db import database_url, energy_reports, make_engine, migrate, samples

log = logging.getLogger("tuya-dash")

MAX_HOLD_S = 30 * 60  # não estende uma leitura de potência por mais de 30 min


class EnergyStore:
    def __init__(self, data_dir: Path):
        self._lock = threading.Lock()
        self.error: str | None = None
        url, self.kind = database_url(data_dir)
        try:
            self.engine = make_engine(url)
            migrate(self.engine)
        except Exception as e:  # noqa: BLE001
            if self.kind != "mysql":
                raise
            self.error = f"MySQL indisponível ({e.__class__.__name__}); usando SQLite local"
            log.warning("%s: %s", self.error, e)
            from sqlalchemy.engine import URL
            self.kind = "sqlite"
            self.engine = make_engine(URL.create("sqlite", database=str(data_dir / "energy.db")))
            migrate(self.engine)
        log.info("histórico de energia em %s (%s)", self.kind, self.engine.url.render_as_string(hide_password=True))
        self._import_legacy(data_dir / "energy.sqlite3")

    def _import_legacy(self, path: Path):
        """Importa uma vez o SQLite da primeira versão do painel (sem migrações)."""
        if not path.exists():
            return
        src = sqlite3.connect(path)
        rows_s = src.execute("SELECT device_id, ts, power_w, voltage_v, current_a FROM samples").fetchall()
        rows_e = src.execute("SELECT device_id, ts, kwh FROM energy_reports").fetchall()
        src.close()
        keys_s = ("device_id", "ts", "power_w", "voltage_v", "current_a")
        with self.engine.begin() as c:
            if rows_s:
                c.execute(insert(samples), [dict(zip(keys_s, r)) for r in rows_s])
            for r in rows_e:
                c.execute(self._insert_ignore(energy_reports), dict(zip(("device_id", "ts", "kwh"), r)))
        path.rename(path.with_suffix(".migrated"))
        log.info("importadas %d leituras e %d relatórios do SQLite antigo", len(rows_s), len(rows_e))

    def _insert_ignore(self, table):
        return insert(table).prefix_with("OR IGNORE" if self.kind == "sqlite" else "IGNORE")

    def _q(self, stmt, params=None):
        with self._lock, self.engine.begin() as c:
            res = c.execute(stmt, params) if params is not None else c.execute(stmt)
            return [tuple(r) for r in res] if res.returns_rows else []

    def add_sample(self, device_id: str, power_w, voltage_v, current_a, ts: float | None = None):
        if power_w is None and voltage_v is None and current_a is None:
            return
        self._q(insert(samples).values(device_id=device_id, ts=ts or time.time(),
                                       power_w=power_w, voltage_v=voltage_v, current_a=current_a))

    def add_energy(self, device_id: str, kwh: float, ts: float):
        if kwh is None or kwh <= 0:
            return
        self._q(self._insert_ignore(energy_reports).values(device_id=device_id, ts=ts, kwh=kwh))

    # ------------------------------------------------------------------ leitura
    def series(self, device_id: str, since: float, buckets: int = 96, width: float | None = None) -> dict:
        """Série de potência agregada em ``buckets`` intervalos + kWh por intervalo."""
        now = time.time()
        width = width or max((now - since) / buckets, 1)
        rows = self._q(
            select(samples.c.ts, samples.c.power_w, samples.c.voltage_v, samples.c.current_a)
            .where(samples.c.device_id == device_id, samples.c.ts >= since - MAX_HOLD_S)
            .order_by(samples.c.ts)
        )
        reports = self._q(
            select(energy_reports.c.ts, energy_reports.c.kwh)
            .where(energy_reports.c.device_id == device_id, energy_reports.c.ts >= since)
            .order_by(energy_reports.c.ts)
        )

        power_rows = [(t, p) for t, p, _, _ in rows if p is not None]
        est = [0.0] * buckets
        covered = [0.0] * buckets  # segundos do intervalo cobertos por alguma leitura
        # integração "segura o último valor" (degrau), limitada a MAX_HOLD_S
        for i, (t, p) in enumerate(power_rows):
            end = power_rows[i + 1][0] if i + 1 < len(power_rows) else now
            end = min(end, t + MAX_HOLD_S)
            start = max(t, since)
            if end <= start:
                continue
            # distribui a energia pelos buckets atravessados
            b = int((start - since) // width)
            cur = start
            while cur < end and b < buckets:
                bend = min(end, since + (b + 1) * width)
                est[b] += p * (bend - cur) / 3_600_000  # W·s -> kWh
                covered[b] += bend - cur
                cur = bend
                b += 1

        measured = [0.0] * buckets
        for t, kwh in reports:
            b = min(int((t - since) // width), buckets - 1)
            measured[b] += kwh

        # média sobre o tempo coberto; None onde não há leitura (antes do painel rodar, lacunas)
        avg_power: list[float | None] = [
            round(est[b] * 3_600_000 / covered[b], 2) if covered[b] >= 1 else None
            for b in range(buckets)
        ]

        in_range = [r for r in rows if r[0] >= since]
        return {
            "since": since,
            "until": now,
            "bucket_seconds": width,
            "avg_power_w": avg_power,
            "kwh_estimated": [round(x, 5) if covered[i] >= 1 else None for i, x in enumerate(est)],
            "kwh_measured": [round(x, 5) for x in measured],
            "total_kwh_estimated": round(sum(est), 4),
            "coverage_s": round(sum(covered)),
            "total_kwh_measured": round(sum(measured), 4),
            "has_measured": bool(reports),
            "peak_power_w": max((p for _, p in power_rows if _ >= since), default=None),
            "samples": len(in_range),
            "last_voltage_v": next((v for _, _, v, _ in reversed(rows) if v is not None), None),
        }

    def totals(self, device_ids: list[str], since: float) -> dict[str, float]:
        out = {}
        for d in device_ids:
            s = self.series(d, since, buckets=24)
            out[d] = s["total_kwh_estimated"]
        return out

    def prune(self, keep_days: int = 400):
        cutoff = time.time() - keep_days * 86400
        self._q(delete(samples).where(samples.c.ts < cutoff))
