"""Trusted tool of the dunning mission: the short summary for the AR team lead, with counts.

Input (stdin): {"items": the goal's items ("<invoice>:<customer>"), "asOf", "bankCutoff", "graceDays"}.

It runs after every child of the week closed, and it re-derives each invoice's outcome from the same data and the same
rules as the per-invoice tool (tools/invoice.py): a code step sees only its inputs and the vault, never the gate's
receipts, so this summary states what the data says, not what the gate confirmed. Output: {"value": {"text"}}."""
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


def cents(text):
    return round(float(text) * 100)


def names_invoice(reference, invoice_id):
    found = re.fullmatch(r"AR-(\d{4})-(\d+)", invoice_id)
    if not found:
        return False
    year, number = found.group(1), found.group(2)
    groups = re.findall(r"\d+", reference)
    if year in groups and any(int(group) == int(number) for group in groups if group != year):
        return True
    return f"{year}{number}" in re.sub(r"\D", "", reference)


def payer_is(payer, customer_name):
    words = re.findall(r"[a-z]+", customer_name.lower())
    return bool(words) and words[0] in re.findall(r"[a-z]+", payer.lower())


as_of = date.fromisoformat(str(request.get("asOf")))
cutoff = date.fromisoformat(str(request.get("bankCutoff")))
grace = int(request.get("graceDays", 14))
invoices = {row["invoice"]: row for row in rows("erp_open_invoices.csv")}
names = {row["customer"]: row["name"] for row in rows("customers.csv")}
bank = [line for line in rows("bank_statement.csv") if date.fromisoformat(line["booking_date"]) <= cutoff]

outcome = {"paid": [], "not_due": [], "reminded": [], "unknown": []}
large = []
for item in request.get("items") or []:
    invoice_id = str(item).split(":")[0]
    invoice = invoices.get(invoice_id)
    if invoice is None:
        outcome["unknown"].append(invoice_id)
        continue
    paid = any(line["currency"] == invoice["currency"] and cents(line["amount"]) == cents(invoice["amount"])
               and names_invoice(line["reference"], invoice_id) and payer_is(line["payer"], names.get(invoice["customer"], ""))
               for line in bank)
    days = (as_of - date.fromisoformat(invoice["due_date"])).days
    kind = "paid" if paid else "not_due" if days <= grace else "reminded"
    outcome[kind].append(invoice_id)
    if kind == "reminded" and float(invoice["amount"]) > 10000:
        large.append(invoice_id)

overdue = len(outcome["paid"]) + len(outcome["reminded"])
text = (
    f"Dunning run as of {as_of.isoformat()} (bank export up to {cutoff.isoformat()}): "
    f"{len(request.get('items') or [])} open invoices looked at. "
    f"{overdue} more than {grace} days past due: {len(outcome['reminded'])} reminded, {len(outcome['paid'])} found paid. "
    f"{len(outcome['not_due'])} not more than {grace} days past due. "
    f"Reminded: {', '.join(outcome['reminded']) or 'none'}. Found paid: {', '.join(outcome['paid']) or 'none'}. "
    f"Above 10,000 EUR (the gate holds every reminder for a person's approval): {', '.join(large) or 'none'}. "
    "These counts are derived from the ERP and bank exports, not from the gate's receipts."
    + (f" Not in the ERP export: {', '.join(outcome['unknown'])}." if outcome["unknown"] else "")
)
print(json.dumps({"value": {"text": text}}))
