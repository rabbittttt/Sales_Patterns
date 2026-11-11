"""Compatibility launcher for the reorganized sales patterns project."""
from pathlib import Path
import runpy

if __name__ == "__main__":
    runpy.run_path(str(Path(__file__).resolve().parent / "static" / "analyze_sales_patterns.py"), run_name="__main__")
