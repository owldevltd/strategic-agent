"""Trusted check before a report on a team: are there enough answers from it? If not, it reports a wall with
the missing precondition as a catalog criterion (number_in_range, 14.1), so the judgment can make it a child goal.
Input JSON on stdin: {"teams": [...], "min": 5}. Only counts leave, never an answer."""
import csv
import json
import os
import sys

request = json.load(sys.stdin)
data_dir = os.environ.get("AGENCY_DATA", "/data")
with open(os.path.join(data_dir, "answers.csv"), newline="", encoding="utf-8") as handle:
    rows = list(csv.DictReader(handle))

minimum = int(request.get("min") or 5)
counts = {team: sum(1 for row in rows if row["team"] == team) for team in (request.get("teams") or [])}
short = [team for team, n in counts.items() if n < minimum]
out = {"value": {"counts": counts, "min": minimum}}
if short:
    team = short[0]
    out["wall"] = {
        "cause": "precondition_missing",
        "reason": f"only {counts[team]} answers from {team}, at least {minimum} are needed",
        "precondition": {"id": f"answers-{team}", "type": "number_in_range", "values": {"quantity": f"answers:{team}", "min": minimum}},
    }
print(json.dumps(out))
