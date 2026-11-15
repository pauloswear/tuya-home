"""usuários do painel (senha em bcrypt) e sessões

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-15
"""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("password_hash", sa.String(100), nullable=False),
        sa.Column("created_at", sa.Double(), nullable=False),
        sa.Column("last_login_at", sa.Double()),
        sa.UniqueConstraint("username"),
    )
    op.create_table(
        "sessions",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.Double(), nullable=False),
        sa.Column("expires_at", sa.Double(), nullable=False),
        sa.Column("user_agent", sa.String(255)),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_sessions_user_id", table_name="sessions")
    op.drop_table("sessions")
    op.drop_table("users")
