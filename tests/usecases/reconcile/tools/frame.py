"""Trusted frame for the reconciliation code the agent writes (6.1, 7.1, see missions/survey/tools/analysis.py for the pattern).
  phase "prepare"  with the vault: every line of the bank statement and of the ledger, shuffled, as rows
  phase "check"    without data: the agent's result against what a reconciliation must be
The frame does not trust the code's classification; it checks what can be checked to the cent: every line is used
exactly once (in a pair or in one difference), a pair has the same amount on both sides, each difference is the bank
amount minus the ledger amount, and the differences add up to the total difference of the month. Only then is the
result verified.

Result of the agent's code: {"pairs": [[bank id, ledger id], ...], "differences": [{"kind": fee|timing|duplicate|unknown,
"bank": id or None, "ledger": id or None, "amount": number}], "total": number}."""
import csv
import json
import math
import os
import random
import sys

SCHEMA = ["pairs", "differences", "total"]
KINDS = {"fee", "timing", "duplicate", "unknown"}
PROBLEMS = {"no code", "no result", "result is not plain data", "the code did not finish within its limits"}


def fail(message, repair=None):
    wall = {"cause": "move_failed", "reason": message[:300]}
    if repair:
        wall["repair"] = repair
    print(json.dumps({"value": None, "wall": wall}))
    sys.exit(0)


def prepare():
    data = os.environ.get("AGENCY_DATA", "/data")
    rows = []
    for source, name in (("bank", "bank.csv"), ("ledger", "ledger.csv")):
        with open(os.path.join(data, name), newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                rows.append({"source": source, "id": row["id"], "date": row["date"], "amount": float(row["amount"]),
                             "ref": row["ref"], "text": row["text"]})
    random.SystemRandom().shuffle(rows)
    lines = {row["id"]: {"source": row["source"], "amount": row["amount"]} for row in rows}
    total = round(sum(row["amount"] for row in rows if row["source"] == "bank") - sum(row["amount"] for row in rows if row["source"] == "ledger"), 2)
    print(json.dumps({"value": {"lines": lines, "total": total, "rows": rows}}))


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def check(request):
    prepared, ran = request.get("prepared") or {}, request.get("ran") or {}
    if not isinstance(ran, dict):
        ran = {"problem": "result is not plain data"}
    if ran.get("error"):
        fail("the reconciliation code failed", {"error": ran["error"], "line": ran.get("line"), **({"name": ran["name"]} if isinstance(ran.get("name"), str) else {})})
    if ran.get("problem") or "result" not in ran:
        problem = ran.get("problem", "no result")
        fail("the reconciliation code was not usable", {"problem": problem if problem in PROBLEMS else "unknown"})
    result, lines = ran["result"], prepared.get("lines") or {}
    if not isinstance(result, dict):
        fail("the result is no dict", {"problem": "result is not a dict"})
    bad = [key for key in result if key not in SCHEMA] + [key for key in SCHEMA if key not in result]
    pairs, differences = result.get("pairs"), result.get("differences")
    if not isinstance(pairs, list) or not all(isinstance(pair, list) and len(pair) == 2 for pair in pairs):
        bad.append("pairs")
    if not isinstance(differences, list) or not all(isinstance(item, dict) and item.get("kind") in KINDS and number(item.get("amount")) for item in differences):
        bad.append("differences")
    if not number(result.get("total")):
        bad.append("total")
    if bad:
        fail("the result breaks its schema", {"schema": sorted(set(key if key in SCHEMA else "an unknown key" for key in bad)), "keys": SCHEMA})
    used, wrong = [], set()
    amount = lambda line_id: lines[line_id]["amount"] if line_id in lines else None
    for bank, ledger in pairs:
        used += [bank, ledger]
        if lines.get(bank, {}).get("source") != "bank" or lines.get(ledger, {}).get("source") != "ledger" or abs(amount(bank) - amount(ledger)) > 0.005:
            wrong.add("pairs")
    for item in differences:
        bank, ledger = item.get("bank"), item.get("ledger")
        used += [line for line in (bank, ledger) if line is not None]
        if (bank is None and ledger is None) or (bank is not None and lines.get(bank, {}).get("source") != "bank") \
                or (ledger is not None and lines.get(ledger, {}).get("source") != "ledger"):
            wrong.add("differences")
            continue
        if abs(((amount(bank) or 0) - (amount(ledger) or 0)) - item["amount"]) > 0.005:
            wrong.add("differences")
    if sorted(used) != sorted(lines):
        wrong.add("pairs")
    if abs(result["total"] - prepared.get("total", 0)) > 0.005 or abs(sum(item["amount"] for item in differences) - result["total"]) > 0.005:
        wrong.add("total")
    if wrong:
        fail("the reconciliation does not add up: " + ", ".join(sorted(wrong)), {"differs": sorted(wrong), "keys": SCHEMA})
    print(json.dumps({"value": {"pairs": len(pairs), "differenceCount": len(differences), "differences": differences,
                                "total": round(result["total"], 2)}, "verified": True}))


request = json.load(sys.stdin)
if request.get("phase") == "prepare":
    prepare()
else:
    check(request)
