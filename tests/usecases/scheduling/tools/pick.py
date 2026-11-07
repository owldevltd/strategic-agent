"""Trusted tool: the slot every external participant accepted (their answers as trusted code stored them). A wall when
an answer is missing or no slot works for everyone."""
import csv
import json
import os
import sys

request = json.load(sys.stdin)
people = request.get("people") or []
with open(os.path.join(os.environ.get("AGENCY_DATA", "/data"), "answers.csv"), newline="", encoding="utf-8") as handle:
    answers = {row["person"]: row["slot"] for row in csv.DictReader(handle)}
missing = [person for person in people if person not in answers]
if missing:
    print(json.dumps({"value": {"answers": answers}, "wall": {"cause": "no_reaction", "reason": f"{len(missing)} participant(s) did not answer"}}))
    sys.exit(0)
chosen = {answers[person] for person in people}
if len(chosen) != 1 or "none" in chosen:
    print(json.dumps({"value": {"answers": answers}, "wall": {"cause": "move_failed", "reason": "no slot works for everyone"}}))
else:
    print(json.dumps({"value": {"slot": chosen.pop(), "answers": answers}}))
