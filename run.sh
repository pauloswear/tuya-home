#!/usr/bin/env bash
# Sobe o painel em http://0.0.0.0:8765 (acessível na rede local)
cd "$(dirname "$0")"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -r requirements.txt; }
exec .venv/bin/uvicorn app.main:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8765}"
