"""Trusted tool: the customer's mail from the vault, as it came in (it is the customer's text, so it is foreign)."""
import json
import os

with open(os.path.join(os.environ.get("AGENCY_DATA", "/data"), "mail.txt"), encoding="utf-8") as handle:
    print(json.dumps({"value": {"text": handle.read()}}))
