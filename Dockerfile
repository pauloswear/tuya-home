# Tuya Dash — imagem do painel (FastAPI + SPA)
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TUYA_DASH_DATA=/app/data

WORKDIR /app

# dependências primeiro (cache de camada)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# código da aplicação (segredos NÃO entram na imagem; vêm do .env em runtime)
COPY app/ ./app/
COPY static/ ./static/
COPY migrations/ ./migrations/
COPY alembic.ini .

RUN mkdir -p /app/data
EXPOSE 8765

# o servidor aplica as migrações (alembic) ao iniciar
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8765"]
