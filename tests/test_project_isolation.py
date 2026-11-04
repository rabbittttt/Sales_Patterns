"""Tests for the standalone project path contract.

These checks use temporary directories only.  They never open or copy the
business workbook and they are deliberately independent of the IDE cwd.
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


PROJECT = Path(__file__).resolve().parents[1]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


paths = load_module("sales_pattern_data_paths", PROJECT / "core" / "data_paths.py")


class StandaloneProjectTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {"SHARED_DATA_ROOT": ""})
        environment.start()
        self.addCleanup(environment.stop)

    def test_default_shared_root_is_sibling_of_project(self):
        with tempfile.TemporaryDirectory() as folder:
            project = Path(folder) / "销量规律"
            self.assertEqual(
                paths.shared_data_root(project), (Path(folder) / "共享数据").resolve()
            )
            self.assertEqual(
                paths.orders_input_directory(project),
                (Path(folder) / "共享数据" / "订单汇总").resolve(),
            )

    def test_relative_configured_root_is_project_relative_not_cwd_relative(self):
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as cwd:
            project = Path(folder) / "销量规律"
            with patch.dict(os.environ, {"SHARED_DATA_ROOT": "company-data"}):
                with patch("os.getcwd", return_value=cwd):
                    self.assertEqual(
                        paths.shared_data_root(project), (project / "company-data").resolve()
                    )

    def test_absolute_configured_root_overrides_sibling(self):
        with tempfile.TemporaryDirectory() as folder:
            configured = Path(folder) / "external-inputs"
            with patch.dict(os.environ, {"SHARED_DATA_ROOT": str(configured)}):
                self.assertEqual(paths.orders_input_directory(PROJECT), configured.resolve() / "订单汇总")

    def test_missing_shared_root_has_no_output_file_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            project = Path(folder) / "销量规律"
            (project / "output_file").mkdir(parents=True)
            stale = project / "output_file" / "鸿蒙智行销量数据汇总.xlsx"
            stale.write_bytes(b"stale workbook must not be selected")
            resolved = paths.orders_input_directory(project) / "鸿蒙智行销量数据汇总.xlsx"
            self.assertFalse(resolved.exists())
            self.assertNotEqual(resolved.parent, project / "output_file")

    def test_temporary_project_uses_only_its_local_modules(self):
        with tempfile.TemporaryDirectory() as folder:
            project = Path(folder) / "销量规律"
            (project / "core").mkdir(parents=True)
            for relative in (Path("analyze_sales_patterns.py"), Path("core/data_paths.py"), Path("core/china_calendar.py")):
                shutil.copy2(PROJECT / relative, project / relative)
            analyzer = load_module("temporary_sales_analyzer", project / "analyze_sales_patterns.py")
            with patch.dict(os.environ, {"SHARED_DATA_ROOT": ""}):
                self.assertEqual(analyzer.ROOT, project.resolve())
                self.assertEqual(
                    analyzer.default_input_path(),
                    (project.parent / "共享数据" / "订单汇总" / "鸿蒙智行销量数据汇总.xlsx").resolve(),
                )
                calendar = analyzer.load_calendar()
                self.assertIn(2025, calendar["years"])


if __name__ == "__main__":
    unittest.main()
