"""Trusted tool of the dunning mission: checks a customer's claim "we paid" against the bank statement, as the AR
team does when such a reply comes in.

Input (stdin): {"invoice": the invoice the reply names (read by a model, so only a claim), "customer": the sender's
customer reference (the case's "from")}.

The claim is only checked, never believed: the invoice must be in the ERP export and must be this customer's, and the
bank statement as it stands now (every line, also those booked after the cut-off of the weekly run) must hold a
payment of exactly the invoice's amount and currency from this customer, booked after the invoice was issued, whose
reference names no other invoice. Exactly one such line: {"value": {"item", "invoiceId", "customer", "paidOn",
"outcome": "paid"}}. Anything else is a wall, and the next strategy asks the customer for the remittance advice."""
import csv
import json
import os
import re
import sys
from datetime import date

request = json.load(sys.stdin)
DATA = os.environ.get("AGENCY_DATA", "/data")


def rows(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def wall(reason):
    print(json.dumps({"value": None, "wall": {"cause": "move_failed", "reason": reason}}))
    sys.exit(0)


def cents(text):
    return round(float(text) * 100)


def named_invoices(reference):
    """The invoice numbers a reference names in the strict form AR-YYYY-NNNN (also without dashes)."""
    return {f"{year}-{int(number)}" for year, number in re.findall(r"AR[\s-]?(\d{4})[\s-]?(\d{3,5})", reference.upper())}


def payer_is(payer, customer_name):
    words = re.findall(r"[a-z]+", customer_name.lower())
    return bool(words) and words[0] in re.findall(r"[a-z]+", payer.lower())


invoice_id = str(request.get("invoice") or "").strip().upper()
customer_ref = str(request.get("customer") or "").strip()
if not invoice_id:
    wall("the reply names no invoice")
invoice = next((row for row in rows("erp_open_invoices.csv") if row["invoice"] == invoice_id), None)
if invoice is None:
    wall("the invoice the reply names is not among our open invoices")
if invoice["customer"] != customer_ref:
    wall("the invoice the reply names is not the sender's")
customer = next((row for row in rows("customers.csv") if row["customer"] == customer_ref), None)
if customer is None:
    wall("the sender is not in the customer list")

year, number = invoice_id.split("-")[1:3]
own = f"{year}-{int(number)}"
issued = date.fromisoformat(invoice["issued"])
lines = [line for line in rows("bank_statement.csv")
         if date.fromisoformat(line["booking_date"]) >= issued
         and line["currency"] == invoice["currency"]
         and cents(line["amount"]) == cents(invoice["amount"])
         and payer_is(line["payer"], customer["name"])
         and named_invoices(line["reference"]) <= {own}]
if len(lines) != 1:
    wall(f"{len(lines)} matching payments for {invoice_id} in the bank statement")
print(json.dumps({"value": {"item": f"{invoice_id}:{customer_ref}", "invoiceId": invoice_id, "customer": customer_ref,
                            "paidOn": lines[0]["booking_date"], "outcome": "paid"}}))
