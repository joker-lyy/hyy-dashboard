"""定向生成视频巡检趋势 JSON（8 个文件），用于快速补数据，无需跑全量。"""
import os
import sys
import json

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)
import server  # noqa: E402
import fetch_data as fd  # noqa: E402

OUT_DIR = fd.OUT_DIR
os.makedirs(OUT_DIR, exist_ok=True)

start_date, end_date = fd.default_range()
print(f"区间：{start_date} ~ {end_date}")

for period in fd.TREND_PERIODS:
    p_start, p_end = fd.period_range(period, start_date, end_date)
    for group_by in fd.TREND_GROUP_BYS:
        name = f"trends_video_{period}_{group_by}.json"
        try:
            trends = server._fetch_video_trends(p_start, p_end, group_by=group_by)
            fd.write_json(name, {"success": True, "data": trends, "error": None})
            print(f"  OK  {name}  dates={len(trends.get('dates', []))} series={len(trends.get('series', []))}")
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"  FAIL {name}: {e}")

print("done")
