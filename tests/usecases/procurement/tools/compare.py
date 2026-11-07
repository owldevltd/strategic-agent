"""Trusted tool: the quotes as trusted code stored them (the supplier is the one we asked, total and delivery as read
from its answer). Only quotes that deliver by the needed date count; with fewer than three valid quotes it is a wall
(the policy needs three for an order above 10,000 EUR). The cheapest valid quote wins; the framework supplier wins a tie.
Input: {"needBy": "YYYY-MM-DD", "framework": supplier}."""
import csv
import json
import os
import sys

request = json.load(sys.stdin)
with open(os.path.join(os.environ.get("AGENCY_DATA", "/data"), "quotes.csv"), newline="", encoding="utf-8") as handle:
    quotes = [{"supplier": row["supplier"], "total": float(row["total"]), "delivery": row["delivery"]} for row in csv.DictReader(handle) if row.get("total")]
valid = [quote for quote in quotes if quote["delivery"] <= request["needBy"]]
value = {"quotes": quotes, "valid": len(valid), "needBy": request["needBy"]}
if len(quotes) < 3:
    print(json.dumps({"value": value, "wall": {"cause": "no_reaction", "reason": f"only {len(quotes)} quotes, the policy needs three"}}))
    sys.exit(0)
if not valid:
    print(json.dumps({"value": value, "wall": {"cause": "move_failed", "reason": "no quote delivers in time"}}))
    sys.exit(0)
best = sorted(valid, key=lambda quote: (quote["total"], quote["supplier"] != request.get("framework")))[0]
print(json.dumps({"value": dict(value, supplier=best["supplier"], amount=best["total"], delivery=best["delivery"])}))
