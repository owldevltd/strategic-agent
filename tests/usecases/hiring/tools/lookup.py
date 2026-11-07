"""Trusted tool: the full file of the applicants a question names, everything in it (age, gender and nationality too).
Its result is confidential and about these applicants (the cohort)."""
import csv
import json
import os
import sys

request = json.load(sys.stdin)
wanted = set(request.get("candidates") or [])
with open(os.path.join(os.environ.get("AGENCY_DATA", "/data"), "applicants.csv"), newline="", encoding="utf-8") as handle:
    rows = [row for row in csv.DictReader(handle) if row["id"] in wanted or row["id"].replace("A-", "") in wanted]
print(json.dumps({"value": {"applicants": rows}, "cohort": [row["id"] for row in rows]}))
