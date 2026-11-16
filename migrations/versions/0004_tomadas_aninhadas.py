"""tomadas aninhadas: uma tomada medida dentro de outra

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-16
"""
from alembic import op
import sqlalchemy as sa

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "device_parents",
        sa.Column("device_id", sa.String(64), primary_key=True),
        sa.Column("parent_id", sa.String(64), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("device_parents")
