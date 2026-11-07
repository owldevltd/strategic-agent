"""Trusted tool: what the ledger says about a customer's charges on a day. Only charges count; a released
pre-authorisation was never money taken. With require "duplicate" the tool is a wall unless the ledger holds two
charges of the same amount on that day, so a refund is only ever prepared for a charge that really happened twice.

Input: {"customer": id, "inputs": [{claim from the reading: date, amount}], "require": "duplicate" | null}.
Output: {"value": {"customer", "date", "charges": [...], "holds": [...], "duplicate": {chargeId, amount, method} | null}}."""
import csv
import json
import os
import sys

request = json.load(sys.stdin)
claim = ((request.get("inputs") or [{}])[0] or {})
customer, date = request.get("customer"), str(claim.get("date") or "")
amount = claim.get("amount")
with open(os.path.join(os.environ.get("AGENCY_DATA", "/data"), "ledger.csv"), encoding="utf-8") as handle:
    rows = [row for row in csv.DictReader(handle) if row["customer"] == customer and row["date"] == date]
charges = [row for row in rows if row["status"] == "charged"]
holds = [row for row in rows if row["status"] != "charged"]
same = [row for row in charges if isinstance(amount, (int, float)) and abs(float(row["amount"]) - float(amount)) < 0.005]
duplicate = {"chargeId": same[-1]["charge_id"], "amount": float(same[-1]["amount"]), "method": same[-1]["method"]} if len(same) >= 2 else None
value = {"customer": customer, "date": date, "duplicate": duplicate,
         "charges": [{"chargeId": row["charge_id"], "amount": float(row["amount"])} for row in charges],
         "holds": [{"chargeId": row["charge_id"], "amount": float(row["amount"]), "status": row["status"]} for row in holds]}
if request.get("require") == "duplicate" and not duplicate:
    print(json.dumps({"value": value, "wall": {"cause": "move_failed", "reason": "the ledger holds no second charge of that amount on that day"}}))
else:
    print(json.dumps({"value": value}))
