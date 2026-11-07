"""Trusted tool for the two onboarding documents of a new supplier (one tool with a mode, since a tool cannot import
another file of the mission).

  letter  {"mode": "letter", "document": "tax:lindqvist", "purpose": "request" | "reminder"}
          the request or the one reminder, from a fixed template (our own text, never a model's)
  check   {"mode": "check", "document": "bank:okoro"}
          the document as trusted code stored it from the supplier's answer, held against the registration:
          a tax number in the format of the supplier's country; a bank letter whose IBAN is valid and equal to the
          IBAN the supplier gave at registration; the answer from the contact on file. Checked settles the item
          (fact item_resolved, outcome checked); anything else is a wall with the reason.
  review  {"mode": "review", "kind": "tax" | "bank", "supplier": "okoro"}
          the same check once more, as the summary a person sees before confirming the verification
  status  {"mode": "status", "supplier": "okoro"}
          what came in for each document and what the check found, for the person an invoice is handed to

The documents' contents are the supplier's (foreign); the registration in suppliers.csv is ours."""
import csv
import json
import os
import re
import sys

DATA = os.environ.get("AGENCY_DATA", "/data")
KINDS = {
    "tax": {"file": "tax_certificates.csv", "field": "taxNumber", "name": "tax registration certificate"},
    "bank": {"file": "bank_letters.csv", "field": "iban", "name": "bank confirmation letter"},
}
# The tax registration number's format per country (VAT registration numbers).
TAX_FORMATS = {
    "SE": r"^SE[0-9]{10}01$",
    "GB": r"^GB([0-9]{9}|[0-9]{12})$",
    "DE": r"^DE[0-9]{9}$",
    "NL": r"^NL[0-9]{9}B[0-9]{2}$",
}
IBAN_LENGTHS = {"SE": 24, "GB": 22, "DE": 22, "NL": 18}


def rows(name):
    path = os.path.join(DATA, name)
    if not os.path.isfile(path):
        return []
    with open(path, newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def out(value, wall=None):
    result = {"value": value}
    if wall:
        result["wall"] = {"cause": wall[0], "reason": wall[1]}
    print(json.dumps(result))
    sys.exit(0)


def plain(text):
    return re.sub(r"\s+", "", str(text or "")).upper()


def iban_valid(iban):
    if not re.match(r"^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$", iban):
        return False
    if IBAN_LENGTHS.get(iban[:2]) not in (None, len(iban)):
        return False
    moved = iban[4:] + iban[:4]
    return int("".join(str(int(char, 36)) for char in moved)) % 97 == 1


def registration(supplier):
    return next((row for row in rows("suppliers.csv") if row["supplier"] == supplier), None)


def examine(kind, supplier):
    """→ (ok, summary, reason)"""
    spec = KINDS.get(kind)
    reg = registration(supplier)
    if not spec or not reg:
        return False, {"document": f"{kind}:{supplier}"}, "the document or the supplier is unknown to the registration"
    stored = next((row for row in rows(spec["file"]) if row.get("supplier") == supplier), None)
    summary = {"document": f"{kind}:{supplier}", "kind": spec["name"], "supplier": reg["name"], "country": reg["country"]}
    if not stored or not stored.get(spec["field"]):
        return False, dict(summary, received=False), f"no {spec['name']} has come in from {reg['name']}"
    summary["received"] = True
    if plain(stored.get("from")).lower() != plain(reg["contact"]).lower():
        return False, summary, f"the {spec['name']} did not come from the contact on file"
    value = plain(stored[spec["field"]])
    if kind == "tax":
        summary["taxNumber"] = value
        pattern = TAX_FORMATS.get(reg["country"])
        if not pattern or not re.match(pattern, value):
            return False, summary, f"the tax registration number does not have the format of {reg['country']}"
        summary["finding"] = f"tax registration number in the format of {reg['country']}"
        return True, summary, ""
    summary["ibanOnLetter"] = value
    summary["ibanRegistered"] = plain(reg["iban"])
    if not iban_valid(value):
        return False, summary, "the IBAN on the bank letter is no valid IBAN"
    if value != plain(reg["iban"]):
        return False, summary, "the IBAN on the bank letter differs from the IBAN the supplier gave at registration"
    summary["finding"] = "the IBAN on the bank letter is the registered IBAN"
    return True, summary, ""


def letter(request):
    document = str(request.get("document", ""))
    kind, _, supplier = document.partition(":")
    spec = KINDS.get(kind)
    reg = registration(supplier)
    if not spec or not reg:
        out(None, ("move_failed", "the document or the supplier is unknown to the registration"))
    if request.get("purpose") == "reminder":
        text = (f"Dear colleagues at {reg['name']}, a few days ago we asked you for your {spec['name']}. "
                f"We have not received it yet. Please reply to this message with the document; "
                f"we can pay your first invoice only once your registration is complete. Kind regards, Acme purchasing")
    else:
        text = (f"Dear colleagues at {reg['name']}, welcome as a new supplier of Acme. To complete your registration "
                f"we need your {spec['name']}. Please reply to this message with the document. "
                f"Kind regards, Acme purchasing")
    out({"text": text, "document": document})


def main():
    request = json.load(sys.stdin)
    mode = request.get("mode")
    if mode == "letter":
        letter(request)
    if mode == "check":
        kind, _, supplier = str(request.get("document", "")).partition(":")
        ok, summary, reason = examine(kind, supplier)
        if not ok:
            out(summary, ("move_failed", reason))
        out({"item": f"{kind}:{supplier}", "outcome": "checked"})
    if mode == "review":
        ok, summary, reason = examine(str(request.get("kind", "")), str(request.get("supplier", "")))
        out(summary, None if ok else ("move_failed", reason))
    if mode == "status":
        # One short text, problems first: a ticket shows only the first 600 characters of an input.
        supplier = str(request.get("supplier", ""))
        reg = registration(supplier) or {"name": supplier}
        problems, fine = [], []
        for kind in ("tax", "bank"):
            ok, summary, reason = examine(kind, supplier)
            if ok:
                fine.append(f"{summary['kind']} checked ({summary.get('finding', '')})")
            elif kind == "bank" and summary.get("ibanOnLetter"):
                problems.append(f"{summary['kind']}: {reason}; letter {summary['ibanOnLetter']}, "
                                f"registered {summary['ibanRegistered']} (the letter's account is never paid)")
            else:
                problems.append(f"{KINDS[kind]['name']}: {reason}")
        text = f"{reg['name']}. Problems: {'; '.join(problems) or 'none'}. Checked: {'; '.join(fine) or 'nothing'}."
        out(text)
    out(None, ("move_failed", "unknown mode"))


main()
