"""Trusted aggregation over survey answers. It never returns a single answer: only counts, averages and theme
counts for a group, together with the exact list of respondents the group consists of (the cohort). The gate
decides from that cohort whether the result may leave. Input JSON on stdin: {"teams": [...], "exclude": [...], "excludePeople": [...]}."""
import csv
import json
import os
import sys

request = json.load(sys.stdin)
data_dir = os.environ.get("AGENCY_DATA", "/data")
with open(os.path.join(data_dir, "answers.csv"), newline="", encoding="utf-8") as handle:
    rows = list(csv.DictReader(handle))

teams = set(request.get("teams") or [])
exclude = set(request.get("exclude") or [])
# People may be named (the question came in words); the roster maps names to respondents inside the sandbox,
# so the model never sees who is who.
if request.get("excludePeople"):
    with open(os.path.join(data_dir, "roster.csv"), newline="", encoding="utf-8") as handle:
        roster = {row["name"].lower(): row["respondent"] for row in csv.DictReader(handle)}
    exclude |= {roster[name.lower()] for name in request["excludePeople"] if name.lower() in roster}
group = [row for row in rows if (not teams or row["team"] in teams) and row["respondent"] not in exclude]

themes = {}
for row in group:
    themes[row["theme"]] = themes.get(row["theme"], 0) + 1

def mean(field):
    return round(sum(int(row[field]) for row in group) / len(group), 2) if group else None

print(json.dumps({
    "value": {
        "teams": sorted(teams),
        "n": len(group),
        "workload": mean("workload"),
        "manager": mean("manager"),
        "themes": dict(sorted(themes.items(), key=lambda item: -item[1])),
    },
    "cohort": sorted(row["respondent"] for row in group),
}))
