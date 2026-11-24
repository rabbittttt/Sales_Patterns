import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from openpyxl import Workbook

path = Path(__file__).resolve().parents[1] / "core/compare_schema.py"
spec = importlib.util.spec_from_file_location("schema_diff", path)
schema_diff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(schema_diff)


class SchemaTests(unittest.TestCase):
    def test_preserves_duplicate_column_positions_without_exposing_records(self):
        with TemporaryDirectory() as temp:
            path = Path(temp) / "example.xlsx"
            wb = Workbook()
            ws = wb.active
            ws.append(["订单", "订单"])
            ws.append([17, "仅内网可见的值"])
            wb.save(path)
            old = schema_diff.schema(path)
            ws["B2"] = 3
            wb.save(path)
            wb.close()
            new = schema_diff.schema(path)
            self.assertEqual(len(list(schema_diff.changes(old, new))), 1)
            self.assertNotIn("仅内网可见的值", str(list(schema_diff.changes(old, new))))
