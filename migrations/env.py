"""Ambiente do Alembic: usa a conexão do servidor ou monta a URL a partir do .env."""
from alembic import context

from app.db import database_url, make_engine, metadata
from app.settings import DATA_DIR, load_env

config = context.config
target_metadata = metadata


def run(connection):
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        render_as_batch=connection.dialect.name == "sqlite",  # ALTER TABLE no SQLite
    )
    with context.begin_transaction():
        context.run_migrations()


conn = config.attributes.get("connection")
if conn is not None:          # chamado pelo servidor (app.db.migrate)
    run(conn)
else:                         # chamado pela CLI: alembic upgrade / revision --autogenerate
    load_env()
    url, _ = database_url(DATA_DIR)
    engine = make_engine(url)
    with engine.connect() as c:
        run(c)
        c.commit()
