"""Trusted frame for analysis code the agent wrote itself (6.1: a code move in the sandbox, its script from a model
step). The frame, not the agent's code, decides which answers are in the group: it selects the rows of the teams in
question, keeps the cohort (the exact respondents), and hands the agent's code only what it needs to compute with:
team, workload, manager and theme of each answer, in a random order, never a name, an id or a comment.

The agent's code never runs here. The executor runs this frame twice and the code once, each as a sandbox run of
its own (7.1):
  phase "prepare"  with the mission's data: the group, its cohort and the rows for the code
  (agent_code.py)  without any data but the rows: the agent's code
  phase "check"    without data: the code's result against the fixed schema (6.4) and against the frame's own figures
The result has a fixed schema: workload, manager (numbers) and themes (a count per known theme); n is the size of the
group the frame chose, never what the code says. Anything else, text in particular, is refused, so nothing about a
single person can come out under a key of its own. The schema is fixed, so the frame knows its answer: prepare counts
the same figures, and check refuses a result that differs (a hard check against the specification, 4e). Code that
makes its figures up is rewritten once like code that fails, and is a wall after that.

When the code fails, the frame says only what the model may hear for its one repair (6.4): the kind of error (one of
Python's own) and its line, or the keys that broke the schema, each one of the schema's own keys or "an unknown key".
Never the error message, a key or an error class the code made up, or a problem in its own words: they could quote a
value of the data. The wall's reason says no more, since a wall is logged and the log is what a demo shows: code that
names its keys after the rows of a group of two would otherwise publish them.

Input JSON on stdin:
  prepare: {"phase": "prepare", "teams": [...], "exclude": [...], "excludePeople": [...]}
  check:   {"phase": "check", "prepared": {"teams": [...], "n": n, "themes": [...], "expected": {...}}, "ran": {...output of agent_code.py}}"""
import builtins
import csv
import json
import math
import os
import random
import sys

SCHEMA = ["n", "workload", "manager", "themes"]
# The kinds of error the frame names: Python's own. A class the code made up could carry any name it likes.
ERRORS = {name for name, value in vars(builtins).items() if isinstance(value, type) and issubclass(value, BaseException)}
PROBLEMS = {"no code", "no result", "result is not plain data", "the code did not finish within its limits"}


def fail(message, repair=None):
    wall = {"cause": "move_failed", "reason": message[:300]}
    if repair:
        wall["repair"] = repair
    print(json.dumps({"value": None, "wall": wall}))
    sys.exit(0)


def prepare(request):
    data_dir = os.environ.get("AGENCY_DATA", "/data")
    with open(os.path.join(data_dir, "answers.csv"), newline="", encoding="utf-8") as handle:
        answers = list(csv.DictReader(handle))
    teams = set(request.get("teams") or [])
    exclude = set(request.get("exclude") or [])
    if request.get("excludePeople"):
        with open(os.path.join(data_dir, "roster.csv"), newline="", encoding="utf-8") as handle:
            roster = {row["name"].lower(): row["respondent"] for row in csv.DictReader(handle)}
        exclude |= {roster[name.lower()] for name in request["excludePeople"] if name.lower() in roster}
    group = [row for row in answers if (not teams or row["team"] in teams) and row["respondent"] not in exclude]
    rows = [{"team": row["team"], "workload": int(row["workload"]), "manager": int(row["manager"]), "theme": row["theme"]} for row in group]
    # The order says nothing about who is who.
    random.SystemRandom().shuffle(rows)
    themes = sorted({"workload", "manager", "tools", "pay", "growth", "other"} | {row["theme"] for row in answers})
    print(json.dumps({
        "value": {"teams": sorted(teams), "n": len(rows), "themes": themes, "rows": rows, "expected": expected(rows)},
        "cohort": sorted(row["respondent"] for row in group),
    }))


# The figures the instructions ask for, as the frame computes them: the means (the code may round them to 2 decimals)
# and the number of answers per theme.
def expected(rows):
    n = len(rows)
    counts = {}
    for row in rows:
        counts[row["theme"]] = counts.get(row["theme"], 0) + 1
    mean = lambda key: sum(row[key] for row in rows) / n if n else None
    return {"workload": mean("workload"), "manager": mean("manager"), "themes": counts}


# The keys whose figures differ from the frame's own. Without figures of its own the frame refuses all of them (fail closed).
def differs(result, themes, want):
    if not isinstance(want, dict):
        return ["workload", "manager", "themes"]
    wrong = []
    for key in ("workload", "manager"):
        value, figure = result.get(key), want.get(key)
        same = value is None if figure is None else (
            isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and abs(value - figure) <= 0.005 + 1e-9)
        if not same:
            wrong.append(key)
    if {key: value for key, value in themes.items() if value} != {key: value for key, value in (want.get("themes") or {}).items() if value}:
        wrong.append("themes")
    return wrong


def check(request):
    prepared = request.get("prepared") or {}
    ran = request.get("ran") or {}
    if not isinstance(ran, dict):
        ran = {"problem": "result is not plain data"}
    # What agent_code.py printed is not trusted: an error kind is a name, a line a number, a problem one the frame knows.
    if ran.get("error"):
        kind = ran["error"] if isinstance(ran["error"], str) and ran["error"] in ERRORS else "an error"
        line = ran.get("line") if isinstance(ran.get("line"), int) and not isinstance(ran.get("line"), bool) else None
        fail(f"the analysis code failed: {kind}" + (f" in line {line}" if line else ""), {"error": kind, "line": line, **({"name": ran["name"]} if isinstance(ran.get("name"), str) else {})})
    if ran.get("problem") or "result" not in ran:
        problem = ran.get("problem", "no result")
        problem = problem if isinstance(problem, str) and problem in PROBLEMS else "unknown"
        fail(f"the analysis code was not usable: {problem}", {"problem": problem})
    result = ran["result"]
    if not isinstance(result, dict):
        fail("the analysis code must set result to a dict", {"problem": "result is not a dict"})
    problems = [key for key in result if key not in SCHEMA]
    number = lambda value: isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    problems += [key for key in ("n", "workload", "manager") if key in result and result[key] is not None and not number(result[key])]
    themes = result.get("themes") or {}
    known = set(prepared.get("themes") or [])
    if not isinstance(themes, dict) or any(key not in known or not isinstance(value, int) or isinstance(value, bool) for key, value in themes.items()):
        problems.append("themes")
    if problems:
        # The schema's own keys by name, the others only counted: for the model's repair and for the wall alike.
        named = sorted({key for key in problems if key in SCHEMA})
        unknown = sum(1 for key in problems if key not in SCHEMA)
        said = named + ([f"{unknown} unknown key" + ("s" if unknown > 1 else "")] if unknown else [])
        fail("the result breaks its schema: " + ", ".join(said), {"schema": named + (["an unknown key"] if unknown else []), "keys": SCHEMA})
    wrong = differs(result, themes, prepared.get("expected"))
    if wrong:
        fail("the result differs from the frame's own figures: " + ", ".join(wrong), {"differs": wrong, "keys": SCHEMA})
    print(json.dumps({
        "value": {
            "teams": prepared.get("teams") or [],
            "n": prepared.get("n"),
            "workload": result.get("workload"),
            "manager": result.get("manager"),
            "themes": dict(sorted(themes.items(), key=lambda item: -item[1])),
            "code": "written by the agent",
        },
        # The figures were checked against the frame's own (differs above); the executor uses no result without this.
        "verified": True,
    }))


request = json.load(sys.stdin)
if request.get("phase") == "check":
    check(request)
else:
    prepare(request)
