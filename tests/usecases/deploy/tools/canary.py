"""Trusted tool: the canary's error rates the monitoring reported (stored by trusted code as they came in). A wall when
fewer than the needed reports are there, or when any of them is above the limit (in percent)."""
import csv
import json
import os
import sys

request = json.load(sys.stdin)
limit, need = float(request.get("limit", 2)), int(request.get("need", 2))
with open(os.path.join(os.environ.get("AGENCY_DATA", "/data"), "metrics.csv"), newline="", encoding="utf-8") as handle:
    rates = [(int(row["minute"]), float(row["rate"])) for row in csv.DictReader(handle) if row.get("rate")]
rates.sort()
value = {"reports": [{"minute": minute, "rate": rate} for minute, rate in rates], "limit": limit}
if len(rates) < need:
    print(json.dumps({"value": value, "wall": {"cause": "move_failed", "reason": f"only {len(rates)} of {need} canary reports"}}))
elif any(rate > limit for _, rate in rates):
    worst = max(rate for _, rate in rates)
    print(json.dumps({"value": value, "wall": {"cause": "move_failed", "reason": f"the canary's error rate reached {worst} %, above {limit} %"}}))
else:
    print(json.dumps({"value": value}))
