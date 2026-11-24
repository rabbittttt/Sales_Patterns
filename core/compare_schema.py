"""Compare two workbook schemas without printing customer records or cell values."""
import argparse
from collections import Counter
from openpyxl import load_workbook


def schema(path):
    result = {}
    book = load_workbook(path, read_only=True)
    try:
        for sheet in book:
            rows = iter(sheet.rows)
            counts = Counter()
            fields = []
            for cell in next(rows, ()):
                name = str(cell.value).strip() if cell.value is not None else ""
                counts[name] += 1
                fields.append((name, counts[name]))
            columns = {key: set() for key in fields}
            for row in rows:
                for key, cell in zip(fields, row):
                    if cell.value is not None:
                        columns[key].add("date" if cell.is_date else cell.data_type)
            result[sheet.title] = columns
    finally:
        book.close()
    return result


def changes(old, new):
    for sheet in sorted(old.keys() | new.keys()):
        if sheet not in old or sheet not in new:
            yield f"{sheet} · " + ("新增工作表" if sheet in new else "移除工作表")
            continue
        before, after = old[sheet], new[sheet]
        for key in sorted(before.keys() | after.keys()):
            if before.get(key) != after.get(key):
                label, occurrence = key
                def types(columns):
                    return ",".join(sorted(columns[key])) or "空列" if key in columns else "缺列"
                yield f"{sheet} · {label or '无标题'}（第{occurrence}列同名字段） {types(before)} → {types(after)}"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before")
    parser.add_argument("after")
    args = parser.parse_args()
    print("\n".join(changes(schema(args.before), schema(args.after))) or "工作表、字段和观测类型一致")
