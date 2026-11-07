"""Trusted tool: the request as it came in (the requester's own text, foreign)."""
import json
import os

with open(os.path.join(os.environ.get("AGENCY_DATA", "/data"), "request.txt"), encoding="utf-8") as handle:
    print(json.dumps({"value": {"text": handle.read()}}))
