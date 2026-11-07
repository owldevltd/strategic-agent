"""Trusted tool: three one-hour slots that are free in both internal calendars, next week or the week after
(param week: next or after), only the slots, never what fills the calendars, labelled S1 to S3."""
import json
import os
import sys

request = json.load(sys.stdin)
with open(os.path.join(os.environ.get("AGENCY_DATA", "/data"), "calendars.json"), encoding="utf-8") as handle:
    calendars = json.load(handle)
slots = (calendars["slotsAfter"] if request.get("week") == "after" else calendars["slots"])[:3]
text = "; ".join(f"S{i + 1}: {slot}" for i, slot in enumerate(slots))
print(json.dumps({"value": {"week": request.get("week") or "next", "slots": {f"S{i + 1}": slot for i, slot in enumerate(slots)}, "text": text}}))
