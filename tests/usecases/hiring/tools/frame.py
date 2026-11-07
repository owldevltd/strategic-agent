"""Trusted frame for the shortlisting code the agent writes (6.1, 7.1; the pattern of missions/survey/tools/analysis.py).
  phase "prepare"  with the vault: per applicant only the id, the years of experience and the skills. Name, email,
                   age, gender, nationality and the free CV text never reach the code: what the decision may not use,
                   it cannot see.
  phase "check"    without data: the shortlist against the stated criteria. The frame ranks by the same rule the
                   instructions give (must have python and sql; years + 2 per skill of go, kubernetes, postgres; ties
                   by the smaller id) and accepts only exactly those five, each with a reason.
Result of the agent's code: {"shortlist": [{"id": ..., "reason": "..."}]}."""
import csv
import json
import os
import random
import sys

SCHEMA = ["shortlist"]
PROBLEMS = {"no code", "no result", "result is not plain data", "the code did not finish within its limits"}


def fail(message, repair=None):
    wall = {"cause": "move_failed", "reason": message[:300]}
    if repair:
        wall["repair"] = repair
    print(json.dumps({"value": None, "wall": wall}))
    sys.exit(0)


def score(row):
    skills = set(row["skills"])
    return row["years"] + 2 * len(skills & {"go", "kubernetes", "postgres"}) if {"python", "sql"} <= skills else None


def prepare():
    with open(os.path.join(os.environ.get("AGENCY_DATA", "/data"), "applicants.csv"), newline="", encoding="utf-8") as handle:
        rows = [{"id": row["id"], "years": int(row["years"]), "skills": row["skills"].split(";")} for row in csv.DictReader(handle)]
    random.SystemRandom().shuffle(rows)
    ranked = sorted([row for row in rows if score(row) is not None], key=lambda row: (-score(row), row["id"]))
    print(json.dumps({"value": {"expected": [row["id"] for row in ranked[:5]], "rows": rows}}))


def check(request):
    prepared, ran = request.get("prepared") or {}, request.get("ran") or {}
    if not isinstance(ran, dict):
        ran = {"problem": "result is not plain data"}
    if ran.get("error"):
        fail("the shortlisting code failed", {"error": ran["error"], "line": ran.get("line"), **({"name": ran["name"]} if isinstance(ran.get("name"), str) else {})})
    if ran.get("problem") or "result" not in ran:
        problem = ran.get("problem", "no result")
        fail("the shortlisting code was not usable", {"problem": problem if problem in PROBLEMS else "unknown"})
    result = ran["result"]
    if not isinstance(result, dict) or set(result) != {"shortlist"} or not isinstance(result.get("shortlist"), list) \
            or not all(isinstance(item, dict) and isinstance(item.get("id"), str) and isinstance(item.get("reason"), str) and 0 < len(item["reason"]) <= 300
                       for item in result["shortlist"]):
        fail("the result breaks its schema", {"schema": ["shortlist"], "keys": SCHEMA})
    if sorted(item["id"] for item in result["shortlist"]) != sorted(prepared.get("expected") or []):
        fail("the shortlist is not the one the criteria give", {"differs": ["shortlist"], "keys": SCHEMA})
    print(json.dumps({"value": {"shortlist": [{"id": item["id"], "reason": item["reason"]} for item in result["shortlist"]]}, "verified": True}))


request = json.load(sys.stdin)
if request.get("phase") == "prepare":
    prepare()
else:
    check(request)
