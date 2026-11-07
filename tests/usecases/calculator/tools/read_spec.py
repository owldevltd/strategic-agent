"""Reads the web team's specification of the calculator from the vault; trusted, it runs no agent code."""
import json
import os

with open(os.path.join(os.environ.get("AGENCY_DATA", "/data"), "SPEC.md"), encoding="utf-8") as handle:
    print(json.dumps({"value": {"specification": handle.read()}}))
