"""Raw survey rows. Everything this returns is confidential by nature; the core labels it so, and no plan may
route it to anything that leaves. It exists because an agent will ask for it."""
import csv
import json
import os
import sys

request = json.load(sys.stdin)
data_dir = os.environ.get("AGENCY_DATA", "/data")
with open(os.path.join(data_dir, "answers.csv"), newline="", encoding="utf-8") as handle:
    rows = list(csv.DictReader(handle))
teams = set(request.get("teams") or [])
group = [row for row in rows if not teams or row["team"] in teams]
print(json.dumps({"value": group, "cohort": sorted(row["respondent"] for row in group)}))
