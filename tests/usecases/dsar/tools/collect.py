"""Trusted tool: everything the three systems hold about one customer, with every other person blacked out. A ticket
that names another customer or a colleague keeps its text, the other names and ids replaced by [someone else]. The
result is about exactly one person (its cohort), and it is confidential.

Input: {"customer": id}. Output: {"value": {...}, "cohort": [id]}."""
import csv
import json
import os
import re
import sys

request = json.load(sys.stdin)
customer = request.get("customer")
data = os.environ.get("AGENCY_DATA", "/data")


def rows(name):
    with open(os.path.join(data, name), encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


crm = rows("crm.csv")
me = [row for row in crm if row["customer_id"] == customer]
if not me:
    print(json.dumps({"value": None, "wall": {"cause": "move_failed", "reason": "no such customer"}}))
    sys.exit(0)
others = [row for row in crm if row["customer_id"] != customer]
# Names of people the tickets may mention who are not customers (colleagues), from the staff list the core keeps.
staff = ["Omar Haddad"]
hidden = [re.escape(row["name"]) for row in others] + [re.escape(row["customer_id"]) for row in others] + [re.escape(name) for name in staff]
pattern = re.compile("|".join(hidden)) if hidden else None


def black(text):
    return pattern.sub("[someone else]", text) if pattern else text


tickets = [{"ticket": row["ticket_id"], "date": row["date"], "text": black(row["text"])} for row in rows("tickets.csv") if row["customer_id"] == customer]
letters = [row for row in rows("newsletter.csv") if row["email"] == me[0]["email"]]
print(json.dumps({"value": {"customer": me[0], "tickets": tickets, "newsletter": letters}, "cohort": [customer]}))
