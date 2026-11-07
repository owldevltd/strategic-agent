# A sandbox script whose result is five megabytes of JSON.
import json
print(json.dumps({"value": {"blob": "x" * (5 * 1024 * 1024), "n": 1}}))
