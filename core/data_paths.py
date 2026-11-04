"""Resolve read-only shared inputs relative to this independent project."""
from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def shared_data_root(project_root: Path = PROJECT_ROOT) -> Path:
    """Explicit relative roots are relative to the project, never the IDE cwd."""
    project_root = Path(project_root).resolve()
    configured = os.environ.get("SHARED_DATA_ROOT", "").strip()
    if configured:
        candidate = Path(configured).expanduser()
        return (candidate if candidate.is_absolute() else project_root / candidate).resolve()
    return project_root.parent / "共享数据"


def orders_input_directory(project_root: Path = PROJECT_ROOT) -> Path:
    """Do not fall back to old workbooks when the shared directory is absent."""
    return shared_data_root(project_root) / "订单汇总"
