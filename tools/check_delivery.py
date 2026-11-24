"""Check the documented offline runtime file set in a clean directory."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory() as temp:
        project = Path(temp) / "测试交付" / "销量规律"
        project.mkdir(parents=True)
        for name in ("static", "dynamic", "core", "templates"):
            shutil.copytree(ROOT / name, project / name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        for name in ("启动静态销量规律.cmd", "启动动态销量规律.cmd", "requirements.txt"):
            shutil.copy2(ROOT / name, project / name)
        source = project.parent / "工作台数据/shared/订单汇总/鸿蒙智行销量数据汇总.xlsx"
        subprocess.run([sys.executable, ROOT / "tests/make_smoke_input.py", source], check=True)
        digest = hashlib.sha256(source.read_bytes()).digest()
        env = dict(os.environ, SALES_PATTERNS_PYTHON=sys.executable)
        for key in ("PLANHUB_DATA_ROOT", "SHARED_DATA_ROOT", "SALES_PATTERNS_SCHEMA_BASELINE"):
            env.pop(key, None)
        if os.name == "nt":
            command = [os.environ["COMSPEC"], "/d", "/c", "启动静态销量规律.cmd", "--no-open"]
        else:
            command = [sys.executable, "static/analyze_sales_patterns.py", "--no-open"]
        subprocess.run(command, cwd=project, env=env, check=True, stdin=subprocess.DEVNULL, timeout=90)
        output = project / "output_file"
        assert sorted(x.name for x in output.iterdir()) == ["鸿蒙智行销量规律分析.html"]
        assert digest == hashlib.sha256(source.read_bytes()).digest()
        assert digest.hex() in (output / "鸿蒙智行销量规律分析.html").read_text(encoding="utf-8")


if __name__ == "__main__":
    main()
