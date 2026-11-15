"""Caminhos e variáveis de ambiente (.env), sem efeitos colaterais na importação."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("TUYA_DASH_DATA", ROOT / "data"))


def load_env(path: Path = ROOT / ".env"):
    """Lê .env (KEY=valor) sem sobrescrever variáveis já definidas no ambiente."""
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
