from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any


SOURCE_URLS = {
    2022: "https://app.www.gov.cn/govdata/gov/202110/25/477434/article.html",
    2023: "https://app.www.gov.cn/govdata/gov/202212/08/495070/article.html",
    2024: "https://www.gov.cn/zhengce/content/202310/content_6911527.htm",
    2025: "https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm",
    2026: "https://www.gov.cn/gongbao/2025/issue_12406/material/gwygb202532.pdf",
}

# 记录国务院办公厅公布的完整放假区间，而不只记录单个法定假日，
# 供销量规律研究按实际消费和到店节奏分类。
HOLIDAY_PERIODS = {
    2022: (
        ("元旦", "2022-01-01", "2022-01-03"),
        ("春节", "2022-01-31", "2022-02-06"),
        ("清明节", "2022-04-03", "2022-04-05"),
        ("劳动节", "2022-04-30", "2022-05-04"),
        ("端午节", "2022-06-03", "2022-06-05"),
        ("中秋节", "2022-09-10", "2022-09-12"),
        ("国庆节", "2022-10-01", "2022-10-07"),
    ),
    2023: (
        ("元旦", "2022-12-31", "2023-01-02"),
        ("春节", "2023-01-21", "2023-01-27"),
        ("清明节", "2023-04-05", "2023-04-05"),
        ("劳动节", "2023-04-29", "2023-05-03"),
        ("端午节", "2023-06-22", "2023-06-24"),
        ("中秋国庆", "2023-09-29", "2023-10-06"),
    ),
    2024: (
        ("元旦", "2024-01-01", "2024-01-01"),
        ("春节", "2024-02-10", "2024-02-17"),
        ("清明节", "2024-04-04", "2024-04-06"),
        ("劳动节", "2024-05-01", "2024-05-05"),
        ("端午节", "2024-06-10", "2024-06-10"),
        ("中秋节", "2024-09-15", "2024-09-17"),
        ("国庆节", "2024-10-01", "2024-10-07"),
    ),
    2025: (
        ("元旦", "2025-01-01", "2025-01-01"),
        ("春节", "2025-01-28", "2025-02-04"),
        ("清明节", "2025-04-04", "2025-04-06"),
        ("劳动节", "2025-05-01", "2025-05-05"),
        ("端午节", "2025-05-31", "2025-06-02"),
        ("中秋国庆", "2025-10-01", "2025-10-08"),
    ),
    2026: (
        ("元旦", "2026-01-01", "2026-01-03"),
        ("春节", "2026-02-15", "2026-02-23"),
        ("清明节", "2026-04-04", "2026-04-06"),
        ("劳动节", "2026-05-01", "2026-05-05"),
        ("端午节", "2026-06-19", "2026-06-21"),
        ("中秋节", "2026-09-25", "2026-09-27"),
        ("国庆节", "2026-10-01", "2026-10-07"),
    ),
}

ADJUSTED_WORKDAYS = {
    2022: ("2022-01-29", "2022-01-30", "2022-04-02", "2022-04-24", "2022-05-07", "2022-10-08", "2022-10-09"),
    2023: ("2023-01-28", "2023-01-29", "2023-04-23", "2023-05-06", "2023-06-25", "2023-10-07", "2023-10-08"),
    2024: ("2024-02-04", "2024-02-18", "2024-04-07", "2024-04-28", "2024-05-11", "2024-09-14", "2024-09-29", "2024-10-12"),
    2025: ("2025-01-26", "2025-02-08", "2025-04-27", "2025-09-28", "2025-10-11"),
    2026: ("2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10"),
}


def _parse_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not value:
        return None
    try:
        return datetime.strptime(str(value).strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _date_range(start: str, end: str):
    current = datetime.strptime(start, "%Y-%m-%d").date()
    terminal = datetime.strptime(end, "%Y-%m-%d").date()
    while current <= terminal:
        yield current
        current += timedelta(days=1)


HOLIDAY_DATES: dict[str, str] = {}
for periods in HOLIDAY_PERIODS.values():
    for holiday_name, start, end in periods:
        for holiday_date in _date_range(start, end):
            HOLIDAY_DATES[holiday_date.isoformat()] = holiday_name

ADJUSTED_WORKDAY_DATES = {workday for workdays in ADJUSTED_WORKDAYS.values() for workday in workdays}
PUBLISHED_YEARS = tuple(sorted(SOURCE_URLS))


def classify_day(value: Any) -> dict[str, Any]:
    current = _parse_date(value)
    if current is None:
        return {"date": "", "type": "workday", "label": "工作日", "name": "", "official": False, "adjusted": False}
    date_text = current.isoformat()
    covered = current.year in SOURCE_URLS
    if date_text in ADJUSTED_WORKDAY_DATES:
        return {"date": date_text, "type": "workday", "label": "调休工作日", "name": "调休上班", "official": True, "adjusted": True}
    if date_text in HOLIDAY_DATES:
        return {"date": date_text, "type": "holiday", "label": HOLIDAY_DATES[date_text], "name": HOLIDAY_DATES[date_text], "official": True, "adjusted": False}
    if current.weekday() >= 5:
        return {"date": date_text, "type": "weekend", "label": "周末", "name": "", "official": covered, "adjusted": False}
    return {"date": date_text, "type": "workday", "label": "工作日", "name": "", "official": covered, "adjusted": False}


def window_profile(launch_date: Any, days: Any) -> dict[str, Any]:
    start = _parse_date(launch_date)
    try:
        span = max(1, min(int(float(days or 0)), 366))
    except (TypeError, ValueError):
        span = 35
    if start is None:
        return {"days": span, "workdays": 0, "weekends": 0, "holidays": 0, "adjusted_workdays": 0, "holiday_names": [], "early_types": [], "covered": False}
    rows = [classify_day(start + timedelta(days=index)) for index in range(span)]
    return {
        "days": span,
        "workdays": sum(row["type"] == "workday" for row in rows),
        "weekends": sum(row["type"] == "weekend" for row in rows),
        "holidays": sum(row["type"] == "holiday" for row in rows),
        "adjusted_workdays": sum(bool(row["adjusted"]) for row in rows),
        "holiday_names": sorted({row["name"] for row in rows if row["name"]}),
        "early_types": [row["type"] for row in rows[:14]],
        "covered": all((start + timedelta(days=index)).year in SOURCE_URLS for index in range(span)),
    }


def calendar_payload() -> dict[str, Any]:
    return {
        "holidays": HOLIDAY_DATES,
        "adjusted_workdays": sorted(ADJUSTED_WORKDAY_DATES),
        "published_years": list(PUBLISHED_YEARS),
        "sources": {str(year): url for year, url in SOURCE_URLS.items()},
        "source_label": "国务院办公厅年度节假日安排",
    }
