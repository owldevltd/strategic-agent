"""Reads one invoice document into fields. Everything in a document comes from outside, so the core labels the
result "foreign"; an account number found here can never fill a payment. Input: {"invoice": "R-1187"}."""
import json
import os
import re
import sys

request = json.load(sys.stdin)
data_dir = os.environ.get("AGENCY_DATA", "/data")
wanted = request["invoice"]
invoice = re.sub(r"[^A-Z0-9-]", "", wanted[0] if isinstance(wanted, list) else wanted)
with open(os.path.join(data_dir, "invoices", invoice + ".txt"), encoding="utf-8") as handle:
    text = handle.read()

def field(name):
    match = re.search(r"^" + name + r":\s*(.+)$", text, re.M)
    return match.group(1).strip() if match else ""

print(json.dumps({"value": {
    "invoiceId": invoice,
    "supplier": field("Supplier"),
    "amount": float(field("Amount").replace(" EUR", "").replace(",", "") or 0),
    "accountOnDocument": field("Pay to").replace(" ", ""),
}}))
