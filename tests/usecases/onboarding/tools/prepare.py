"""Trusted tool: prepares the payment of a supplier's first invoice. The account always comes from our own supplier
registration (the same account the gate holds in its master data), looked up by the supplier id the plan names, never
from the invoice or from any letter. Each field says where it came from, so the plan check and the gate can tell an
account of ours from one that someone wrote into a document.
Input: {"supplier": "lindqvist", "inputs": [invoice]}."""
import csv
import json
import os
import sys

request = json.load(sys.stdin)
invoice = (request.get("inputs") or [{}])[0] or {}
supplier = str(request.get("supplier", ""))
data_dir = os.environ.get("AGENCY_DATA", "/data")
with open(os.path.join(data_dir, "suppliers.csv"), newline="", encoding="utf-8") as handle:
    registered = {row["supplier"]: row for row in csv.DictReader(handle)}

row = registered.get(supplier)
if not row:
    print(json.dumps({"value": None, "wall": {"cause": "unknown_account", "reason": "the supplier is not registered with us"}}))
    sys.exit(0)
# The invoice must be the registered supplier's own: a document in another name pays nobody.
if str(invoice.get("supplierName", "")).strip().lower() != row["name"].strip().lower():
    print(json.dumps({"value": None, "wall": {"cause": "move_failed", "reason": "the invoice names another supplier than the registered one"}}))
    sys.exit(0)

print(json.dumps({
    "value": {
        "invoiceId": invoice.get("invoiceId"),
        "supplier": supplier,
        "amount": invoice.get("amount"),
        "iban": row["iban"],
    },
    "fieldLabels": {
        "invoiceId": ["foreign"],
        "supplier": ["own"],
        "amount": ["foreign"],
        "iban": ["own"],
    },
}))
