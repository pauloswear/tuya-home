"""histórico de energia: leituras e incrementos de add_ele

Revision ID: 0001
Revises:
Create Date: 2026-11-15
"""
from alembic import op
import sqlalchemy as sa

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "samples",
        sa.Column("id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), primary_key=True, autoincrement=True),
        sa.Column("device_id", sa.String(64), nullable=False),
        sa.Column("ts", sa.Double(), nullable=False),
        sa.Column("power_w", sa.Double()),
        sa.Column("voltage_v", sa.Double()),
        sa.Column("current_a", sa.Double()),
    )
    op.create_index("ix_samples", "samples", ["device_id", "ts"])
    op.create_table(
        "energy_reports",
        sa.Column("device_id", sa.String(64), nullable=False),
        sa.Column("ts", sa.Double(), nullable=False),
        sa.Column("kwh", sa.Double(), nullable=False),
        sa.PrimaryKeyConstraint("device_id", "ts"),
    )


def downgrade() -> None:
    op.drop_table("energy_reports")
    op.drop_index("ix_samples", table_name="samples")
    op.drop_table("samples")
