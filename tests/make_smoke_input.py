"""Create a synthetic input for the Windows delivery and browser checks."""
from datetime import date, timedelta
from pathlib import Path
import sys
from openpyxl import Workbook


def write_fixture(path):
    book = Workbook()
    small = book.active
    small.title = "小订及退订逐日"
    small.append(["日期","订单分析代际名","小订数量","小订来源","真实逐日","小订开始"])
    orders = book.create_sheet("当前订单逐日")
    orders.append(["日期","订单分析代际名","订单阶段","留存大定","留存大定来源","交车锁单","锁单来源"])
    for i in range(70):
        day = date(2025,1,1) + timedelta(days=i)
        if i < 7:
            small.append([day,"样例车型",i+1,"实测",True,date(2025,1,1)])
        orders.append([day,"样例车型","平销",i+3,"实测",i%8,"实测"])
    path.parent.mkdir(parents=True, exist_ok=True)
    book.save(path)
    book.close()


if __name__ == "__main__":
    write_fixture(Path(sys.argv[1]))
