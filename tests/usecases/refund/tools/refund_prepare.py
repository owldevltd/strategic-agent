"""Trusted tool: the refund exactly as the ledger has it: the duplicate charge, its amount, and the payment method it
was taken from. Nothing of the customer's mail reaches these fields."""
import json
import sys

request = json.load(sys.stdin)
found = ((request.get("inputs") or [{}])[0] or {}).get("duplicate")
if not found:
    print(json.dumps({"value": None, "wall": {"cause": "move_failed", "reason": "no duplicate charge to refund"}}))
else:
    print(json.dumps({"value": {"chargeId": found["chargeId"], "amount": found["amount"], "method": found["method"]}}))
