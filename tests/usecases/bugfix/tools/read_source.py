"""Trusted tool: reads the library and the support ticket from the vault, as they are, for the coding step."""
import json
import os

data = os.environ.get("AGENCY_DATA", "/data")
with open(os.path.join(data, "billing.py"), encoding="utf-8") as handle:
    source = handle.read()
with open(os.path.join(data, "ISSUE.md"), encoding="utf-8") as handle:
    issue = handle.read()
print(json.dumps({"value": {"source": source, "issue": issue}}))
