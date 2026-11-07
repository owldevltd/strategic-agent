"""Trusted tool: the CI result for the release commit; a wall unless it is green with no failed test."""
import json
import os

with open(os.path.join(os.environ.get("AGENCY_DATA", "/data"), "ci.json"), encoding="utf-8") as handle:
    ci = json.load(handle)
if ci.get("status") != "green" or ci.get("tests", {}).get("failed", 1) != 0:
    print(json.dumps({"value": ci, "wall": {"cause": "move_failed", "reason": "the tests of the release commit are not green"}}))
else:
    print(json.dumps({"value": ci}))
