"""Trusted tool: reads one supplier invoice document into fields. Everything on a document comes from outside, so the
move labels the result foreign; the account printed on it is kept only as accountOnDocument and never fills a payment.
Input JSON on stdin: {"invoice": "LT-2026-0117:lindqvist"} (the item; the part before the colon is the invoice number)."""
import json
import os
import re
import sys

request = json.load(sys.stdin)
data_dir = os.environ.get("AGENCY_DATA", "/data")
item = str(request.get("invoice", ""))
number = re.sub(r"[^A-Z0-9-]", "", item.split(":")[0].upper())
path = os.path.join(data_dir, "invoices", number + ".txt")
if not number or not os.path.isfile(path):
    print(json.dumps({"value": None, "wall": {"cause": "move_failed", "reason": "the invoice is not among this week's documents"}}))
    sys.exit(0)
with open(path, encoding="utf-8") as handle:
    text = handle.read()


def field(name):
    match = re.search(r"^" + name + r":\s*(.+)$", text, re.M)
    return match.group(1).strip() if match else ""


try:
    amount = float(field("Amount").replace("EUR", "").replace(",", "").strip())
except ValueError:
    amount = 0.0
if not amount > 0:
    print(json.dumps({"value": None, "wall": {"cause": "move_failed", "reason": "the invoice has no readable amount"}}))
    sys.exit(0)
print(json.dumps({"value": {
    "invoiceId": number,
    "supplierName": field("Supplier"),
    "amount": amount,
    "currency": "EUR",
    "accountOnDocument": field("Pay to").replace(" ", ""),
}}))
