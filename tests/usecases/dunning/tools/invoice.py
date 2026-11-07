"""Trusted tool of the dunning mission: one invoice of this week's run, looked at the way the AR team does it.

Input (stdin): {"invoice": "<invoice>:<customer>" (the item of the goal), "asOf": "YYYY-MM-DD",
"bankCutoff": "YYYY-MM-DD" (the last booking day of the bank export this run works on), "graceDays": 14,
"purpose": "settle" | "remind"}.

purpose "settle": prints the item's outcome when the invoice needs no reminder, as {"value": {"item", "outcome"}}:
  "paid"    a line of the bank export (booked up to the cut-off) whose amount and currency equal the invoice's, whose
            reference names the invoice (also written sloppily: "re 2026/388", "AR20260388") and whose payer is the
            invoice's customer. The same amount from another payer, or a reference naming another invoice, never counts.
  "not_due" open, but not more than graceDays past due.
  Otherwise a wall: the invoice is open and more than graceDays past due, so the next strategy may remind.
purpose "remind": the reminder exactly as the ERP has it and its text from the one fixed template, with the customer
  as the cohort (the gate checks the resolved address against the contact on file for exactly that customer).
  A wall whenever the invoice must not be reminded (paid, not overdue enough, not open, or another customer's).

Nothing here comes from a model or from a customer's mail."""
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


def names_invoice(reference, invoice_id):
    """Whether a bank reference names this invoice: its year and its number, in any spelling customers use."""
    found = re.fullmatch(r"AR-(\d{4})-(\d+)", invoice_id)
    if not found:
        return False
    year, number = found.group(1), found.group(2)
    groups = re.findall(r"\d+", reference)
    if year in groups and any(int(group) == int(number) for group in groups if group != year):
        return True
    return f"{year}{number}" in re.sub(r"\D", "", reference)


def payer_is(payer, customer_name):
    """The payer is the customer when the first word of the customer's name is a word of the payer's name."""
    words = re.findall(r"[a-z]+", customer_name.lower())
    return bool(words) and words[0] in re.findall(r"[a-z]+", payer.lower())


item = str(request.get("invoice") or "")
invoice_id, _, customer_ref = item.partition(":")
as_of = date.fromisoformat(str(request.get("asOf")))
cutoff = date.fromisoformat(str(request.get("bankCutoff")))
grace = int(request.get("graceDays", 14))
purpose = request.get("purpose", "settle")

invoice = next((row for row in rows("erp_open_invoices.csv") if row["invoice"] == invoice_id), None)
if invoice is None:
    wall(f"{invoice_id[:40]} is not in the ERP export of open invoices")
if invoice["customer"] != customer_ref:
    wall(f"{invoice_id} belongs to {invoice['customer']}, not to {customer_ref[:20]} as the plan says")
if invoice["status"] != "open":
    wall(f"{invoice_id} is {invoice['status'][:20]} in the ERP, not open")
customer = next((row for row in rows("customers.csv") if row["customer"] == invoice["customer"]), None)
if customer is None:
    wall(f"{invoice['customer']} is not in the customer list")

payments = [line for line in rows("bank_statement.csv")
            if date.fromisoformat(line["booking_date"]) <= cutoff
            and line["currency"] == invoice["currency"]
            and cents(line["amount"]) == cents(invoice["amount"])
            and names_invoice(line["reference"], invoice_id)
            and payer_is(line["payer"], customer["name"])]
overdue_days = (as_of - date.fromisoformat(invoice["due_date"])).days

if purpose == "settle":
    if payments:
        print(json.dumps({"value": {"item": item, "outcome": "paid"}}))
    elif overdue_days <= grace:
        print(json.dumps({"value": {"item": item, "outcome": "not_due"}}))
    else:
        wall(f"{invoice_id} is open, {overdue_days} days past due, and the bank export up to {cutoff} shows no payment")
    sys.exit(0)

if purpose != "remind":
    wall("unknown purpose")
if payments:
    wall(f"{invoice_id} is paid per the bank export; no reminder")
if overdue_days <= grace:
    wall(f"{invoice_id} is only {overdue_days} days past due; no reminder")

amount = float(invoice["amount"])
shown = f"{amount:,.2f} {invoice['currency']}"
due = date.fromisoformat(invoice["due_date"])
due_text = f"{due.day} {due.strftime('%B')} {due.year}"
body = (
    f"Dear accounts payable team of {customer['name']},\n\n"
    f"according to our records, invoice {invoice_id} over {shown}, due on {due_text}, is still open. "
    "This is a friendly reminder in case it has been overlooked.\n\n"
    "If you have already paid it, thank you, and please disregard this message. Otherwise we would be grateful "
    "for your payment in the coming days. If anything about the invoice is unclear, simply reply to this message "
    "and we will be glad to help.\n\n"
    "Kind regards\nAccounts Receivable\nAcme GmbH"
)
print(json.dumps({
    "value": {"item": item, "invoiceId": invoice_id, "customer": invoice["customer"], "amount": amount,
              "currency": invoice["currency"], "dueDate": invoice["due_date"], "body": body},
    "cohort": [invoice["customer"]],
}))
