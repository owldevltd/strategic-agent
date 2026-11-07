"""Trusted tool: the alert and the disk usage of db-01 as the monitoring and du report them (read-only)."""
import json
import os

with open(os.path.join(os.environ.get("AGENCY_DATA", "/data"), "du.txt"), encoding="utf-8") as handle:
    print(json.dumps({"value": {"report": handle.read()}}))
