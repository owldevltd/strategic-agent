"""A move that hangs, for the lease test: it would answer after five seconds."""
import json
import time

time.sleep(5)
print(json.dumps({"value": {"late": True}}))
