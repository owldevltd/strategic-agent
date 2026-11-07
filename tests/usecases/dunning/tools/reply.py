"""Trusted tool of the dunning mission: the answer to a customer's reply, from fixed templates only. No model writes
these texts, so none of them can threaten legal steps, fees or a collection agency, promise a write-off, or repeat
an address from the customer's mail.

Input (stdin): {"kind": "payment_found" | "ask_remittance" | "dispute" | "billing_address" | "other",
"customer": the sender's customer reference, "invoice": the invoice the reply names (may be empty),
"inputs": [the claim check's result, for payment_found]}.
Output: {"value": {"text"}, "cohort": [customer]}: the customer is the cohort, so the gate sends the answer only to
the contact on file for exactly that customer."""
import csv
import json
import os
import re
import sys
from datetime import date

request = json.load(sys.stdin)
DATA = os.environ.get("AGENCY_DATA", "/data")


def wall(reason):
    print(json.dumps({"value": None, "wall": {"cause": "move_failed", "reason": reason}}))
    sys.exit(0)


with open(os.path.join(DATA, "customers.csv"), encoding="utf-8") as handle:
    customers = {row["customer"]: row for row in csv.DictReader(handle)}
with open(os.path.join(DATA, "erp_open_invoices.csv"), encoding="utf-8") as handle:
    invoices = {row["invoice"]: row for row in csv.DictReader(handle)}

kind = request.get("kind")
customer_ref = str(request.get("customer") or "").strip()
customer = customers.get(customer_ref)
if customer is None:
    wall("the sender is not in the customer list")
# Only an invoice that is this customer's is named back; anything else the reply wrote is not repeated.
claimed = str(request.get("invoice") or "").strip().upper()
invoice = claimed if re.fullmatch(r"AR-\d{4}-\d{3,5}", claimed) and invoices.get(claimed, {}).get("customer") == customer_ref else ""
about = f"invoice {invoice}" if invoice else "the invoice you mention"
found = ((request.get("inputs") or [{}])[0] or {})

if kind == "payment_found":
    if not found.get("paidOn") or found.get("invoiceId") != invoice:
        wall("no payment found to confirm")
    paid = date.fromisoformat(found["paidOn"])
    middle = (f"thank you for your message. We have found your payment for {about}, booked on "
              f"{paid.day} {paid.strftime('%B')} {paid.year}, and the invoice is settled. Please disregard our "
              "reminder; it crossed with your payment.")
elif kind == "ask_remittance":
    middle = (f"thank you for letting us know. We have not yet been able to find a payment for {about} in our bank "
              "statement; transfers sometimes take a few days to reach us. Could you please send us the remittance "
              "advice (date, amount and bank reference of the transfer), so that we can match it?")
elif kind == "dispute":
    middle = (f"thank you for your message about {about}. We have passed your objection on to a colleague, who is "
              "looking into it and will get back to you.")
elif kind == "billing_address":
    middle = ("thank you for your message. We send invoices and payment reminders only to the billing address we "
              "have on file for your company, so we cannot send them to another address, including a private one. "
              "If your company's billing contact changes, please let us know through your accounts payable "
              "department, and we will update it after checking.")
elif kind == "other":
    middle = "thank you for your message. A colleague from our accounts receivable team will get back to you."
else:
    wall("unknown kind of answer")

text = f"Dear accounts payable team of {customer['name']},\n\n{middle}\n\nKind regards\nAccounts Receivable\nAcme GmbH"
print(json.dumps({"value": {"text": text}, "cohort": [customer_ref]}))
