"""Trusted measurement over the vault: how many answers one team has given so far. The result is an observation of
the system (fact "measured", 14.1 zahl_im_bereich). Input JSON on stdin: {"quantity": "answers:design"}."""
import csv
import json
import os
import sys

request = json.load(sys.stdin)
data_dir = os.environ.get("AGENCY_DATA", "/data")
with open(os.path.join(data_dir, "answers.csv"), newline="", encoding="utf-8") as handle:
    rows = list(csv.DictReader(handle))

quantity = request.get("quantity", "")
team = quantity.split(":", 1)[1] if ":" in quantity else quantity
print(json.dumps({"value": {"quantity": quantity, "value": sum(1 for row in rows if row["team"] == team)}}))
