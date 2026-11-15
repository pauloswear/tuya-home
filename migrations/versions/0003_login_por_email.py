"""login por e-mail em vez de nome de usuário

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-15
"""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as b:
        b.alter_column("username", new_column_name="email",
                       existing_type=sa.String(64), type_=sa.String(254), existing_nullable=False)


def downgrade() -> None:
    with op.batch_alter_table("users") as b:
        b.alter_column("email", new_column_name="username",
                       existing_type=sa.String(254), type_=sa.String(64), existing_nullable=False)
