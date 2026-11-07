"""Prepares a payment for an invoice. The account always comes from our own master data, looked up by supplier,
never from the document; each field says where it came from, so the plan check and the gate can tell an
account from the master data from one that someone wrote into a document. Input: {"inputs": [invoice]}."""
import csv
import json
import os
import sys

request = json.load(sys.stdin)
invoice = request["inputs"][0]
data_dir = os.environ.get("AGENCY_DATA", "/data")
with open(os.path.join(data_dir, "suppliers.csv"), newline="", encoding="utf-8") as handle:
    master = {row["supplier"]: row["iban"] for row in csv.DictReader(handle)}

print(json.dumps({
    "value": {
        "invoiceId": invoice["invoiceId"],
        "supplier": invoice["supplier"],
        "amount": invoice["amount"],
        "iban": master.get(invoice["supplier"], ""),
    },
    "fieldLabels": {
        "invoiceId": ["foreign"],
        "supplier": ["foreign"],
        "amount": ["foreign"],
        "iban": ["own"] if invoice["supplier"] in master else ["foreign"],
    },
}))
