"""Trusted frame for the migration code the agent writes (6.1, 7.1; the pattern of missions/survey/tools/analysis.py).
  phase "prepare"  with the vault: the legacy rows, shuffled
  phase "check"    without data: the agent's result against what a migration must be
Checked to the row: every legacy row ends up exactly once, migrated or quarantined with a reason; a migrated record
has the new schema (customer_id C-<kdnr>, a name, a lower-case email with a domain, real ISO dates); no email twice;
nothing guessed (a field that was empty stays empty, so the record is quarantined instead); no mangled encoding left.
The result that leaves the frame holds counts, ids and reasons only, never a name or an address.

Result of the agent's code: {"migrated": [{customer_id, name, email, birth_date, since}], "quarantined": [{"kdnr", "reason"}]}
with reason one of duplicate_email, invalid_date, invalid_email, missing_name, bad_encoding."""
import csv
import datetime
import json
import os
import random
import re
import sys

SCHEMA = ["migrated", "quarantined"]
REASONS = {"duplicate_email", "invalid_date", "invalid_email", "missing_name", "bad_encoding"}
PROBLEMS = {"no code", "no result", "result is not plain data", "the code did not finish within its limits"}
EMAIL = re.compile(r"^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$")


def fail(message, repair=None):
    wall = {"cause": "move_failed", "reason": message[:300]}
    if repair:
        wall["repair"] = repair
    print(json.dumps({"value": None, "wall": wall}))
    sys.exit(0)


def prepare():
    with open(os.path.join(os.environ.get("AGENCY_DATA", "/data"), "legacy_customers.csv"), newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    random.SystemRandom().shuffle(rows)
    empty = {row["kdnr"]: [name for name, value in row.items() if not str(value).strip()] for row in rows}
    print(json.dumps({"value": {"ids": sorted(row["kdnr"] for row in rows), "empty": empty, "rows": rows}}))


def iso(value):
    try:
        return isinstance(value, str) and datetime.date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def check(request):
    prepared, ran = request.get("prepared") or {}, request.get("ran") or {}
    if not isinstance(ran, dict):
        ran = {"problem": "result is not plain data"}
    if ran.get("error"):
        fail("the migration code failed", {"error": ran["error"], "line": ran.get("line"), **({"name": ran["name"]} if isinstance(ran.get("name"), str) else {})})
    if ran.get("problem") or "result" not in ran:
        problem = ran.get("problem", "no result")
        fail("the migration code was not usable", {"problem": problem if problem in PROBLEMS else "unknown"})
    result, ids = ran["result"], prepared.get("ids") or []
    if not isinstance(result, dict):
        fail("the result is no dict", {"problem": "result is not a dict"})
    bad = [key for key in result if key not in SCHEMA] + [key for key in SCHEMA if not isinstance(result.get(key), list)]
    if bad:
        fail("the result breaks its schema", {"schema": sorted(set(key if key in SCHEMA else "an unknown key" for key in bad)), "keys": SCHEMA})
    migrated, quarantined, wrong = result["migrated"], result["quarantined"], set()
    seen = []
    for record in migrated:
        if not isinstance(record, dict) or set(record) != {"customer_id", "name", "email", "birth_date", "since"}:
            wrong.add("migrated")
            continue
        kdnr = str(record["customer_id"])[2:] if str(record["customer_id"]).startswith("C-") else None
        seen.append(kdnr)
        name, email = record["name"], record["email"]
        if not isinstance(name, str) or not name.strip() or "Ã" in name or not isinstance(email, str) or not EMAIL.match(email) \
                or not iso(record["birth_date"]) or not iso(record["since"]):
            wrong.add("migrated")
        if kdnr in (prepared.get("empty") or {}) and prepared["empty"][kdnr]:
            wrong.add("migrated")
    emails = [record.get("email") for record in migrated if isinstance(record, dict)]
    if len(emails) != len(set(emails)):
        wrong.add("migrated")
    for item in quarantined:
        if not isinstance(item, dict) or item.get("reason") not in REASONS:
            wrong.add("quarantined")
            continue
        seen.append(str(item.get("kdnr")))
    if sorted(seen) != sorted(ids):
        wrong.add("quarantined" if len(seen) < len(ids) else "migrated")
    if wrong:
        fail("the migration does not hold: " + ", ".join(sorted(wrong)), {"differs": sorted(wrong), "keys": SCHEMA})
    reasons = {}
    for item in quarantined:
        reasons[item["reason"]] = reasons.get(item["reason"], 0) + 1
    print(json.dumps({"value": {"in": len(ids), "migrated": len(migrated), "putAside": len(quarantined),
                                "quarantined": [{"kdnr": item["kdnr"], "reason": item["reason"]} for item in quarantined],
                                "reasons": reasons}, "verified": True}))


request = json.load(sys.stdin)
if request.get("phase") == "prepare":
    prepare()
else:
    check(request)
