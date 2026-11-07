"""Runs code a model wrote, on its own (6.1, 7.1). It is started as a sandbox run of its own, without the mission's
data and without anything else: it gets only the rows the trusted frame prepared for it on stdin, and what it prints
is never trusted. The frame checks it in a separate run, and the cohort of the group never passes through here, so
code that breaks out of the restricted built-ins can neither see more nor forge what the frame says.

When the code fails, this reports only what the model may hear for its one repair (6.4): the kind of error and its
line. Never the error message: it could quote a value of the rows.

Input JSON on stdin: {"code": "...", "rows": [...]}. Output: {"result": ...} or {"error": "...", "line": n}."""
import json
import sys
import traceback

SAFE = {
    "len": len, "sum": sum, "min": min, "max": max, "round": round, "sorted": sorted, "range": range, "dict": dict,
    "list": list, "set": set, "abs": abs, "enumerate": enumerate, "zip": zip, "float": float, "int": int, "any": any,
    "all": all, "map": map, "filter": filter, "tuple": tuple, "isinstance": isinstance, "str": str, "bool": bool,
    # What ordinary code needs and that reaches nothing outside: characters, iteration, and the errors it may catch.
    "ord": ord, "chr": chr, "repr": repr, "reversed": reversed, "iter": iter, "next": next, "divmod": divmod, "pow": pow,
    "frozenset": frozenset, "Exception": Exception, "ValueError": ValueError, "KeyError": KeyError, "TypeError": TypeError,
    "IndexError": IndexError, "UnicodeError": UnicodeError, "UnicodeDecodeError": UnicodeDecodeError,
    "UnicodeEncodeError": UnicodeEncodeError, "ZeroDivisionError": ZeroDivisionError, "StopIteration": StopIteration,
}

request = json.load(sys.stdin)
code = request.get("code") or ""
if not isinstance(code, str) or not code.strip():
    print(json.dumps({"problem": "no code"}))
    sys.exit(0)

scope = {"__builtins__": SAFE, "rows": request.get("rows") or []}
try:
    exec(compile(code, "analysis", "exec"), scope)  # noqa: S102 - the model's code, alone in its sandbox
except Exception as error:  # the code failed: a wall for the frame, not a crash of this run
    kind = type(error).__name__
    line = getattr(error, "lineno", None) if isinstance(error, SyntaxError) else None
    line = line or next((item.lineno for item in reversed(traceback.extract_tb(error.__traceback__)) if item.filename == "analysis"), None)
    report = {"error": kind, "line": line}
    # The name a NameError misses is a word of the code itself (names are compiled from its text), so it may be told:
    # only when it is a plain identifier that occurs in the code.
    missing = getattr(error, "name", None) if isinstance(error, NameError) else None
    if isinstance(missing, str) and missing.isidentifier() and len(missing) <= 40 and missing in code:
        report["name"] = missing
    print(json.dumps(report))
    sys.exit(0)

try:
    print(json.dumps({"result": scope.get("result")}, allow_nan=False))
except (TypeError, ValueError):
    print(json.dumps({"problem": "result is not plain data"}))
