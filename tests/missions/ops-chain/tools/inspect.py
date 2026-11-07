"""Trusted check of one service in the inventory (read only): its host and status. The restart that follows takes
the service and the host from here, never from a message. Input JSON on stdin: {"service": "checkout"}."""
import csv
import json
import os
import sys

request = json.load(sys.stdin)
data_dir = os.environ.get("AGENCY_DATA", "/data")
with open(os.path.join(data_dir, "services.csv"), newline="", encoding="utf-8") as handle:
    services = {row["service"]: row for row in csv.DictReader(handle)}

row = services.get(request.get("service", ""))
if not row:
    print(json.dumps({"value": None, "wall": {"cause": "move_failed", "reason": "the service is not in the inventory"}}))
    sys.exit(0)
print(json.dumps({"value": {"service": row["service"], "host": row["host"], "status": row["status"]}}))
