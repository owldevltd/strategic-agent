"""Trusted frame for code an agent wrote, checked against acceptance cases it never sees (6.1, 6.4, 14: test_green).
A mission names the suite, its frozen cases and the modules the code may import in the move's parameters; they reach
this frame on stdin, never a file the agent's code could read. The agent sees only the examples in its instructions.

The agent's code runs in a child process of its own (this file again, with --child, which stops before the frame is
defined): a small set of built-ins, imports only of the modules the mission allows, no environment, an empty working
folder, a time limit, an output cap and resource limits. The child gets only the calls; the frame compares the
results itself, so nothing the code prints, raises, patches or fakes can make a run green.

A case is {"call": name of a function, "args": [...], "expect": value}, or {"expect": {"raises": "ValueError"}} for a
call that must raise. A result counts in its plain form: a Decimal as its text, a tuple as a list, anything that is no
plain value as {"type": "other"}.

Green is a fact: {"test": the suite, "commit": the hash of this frame, the suite, its modules and its frozen cases (the
version of the suite), "result", "code": the hash of the agent's code, "passed", "of"}. Red is a wall with the core's
repair report (6.4): the kind of error and its line, how many cases failed, or a problem in the core's own words,
never an input or an expected value.
Input JSON on stdin: {"suite": name, "cases": [...], "modules": [...], "seconds": 2, "inputs": [{"code": "..."}]}."""
import builtins
import json
import sys

ALLOWED = (
    "abs all any bool chr dict divmod enumerate filter float frozenset int isinstance issubclass iter len list map max min "
    "next ord pow print range repr reversed round set sorted str sum tuple zip ArithmeticError Exception IndexError "
    "KeyError LookupError TypeError ValueError ZeroDivisionError StopIteration"
).split()


def line_of(error):
    """The last line of the agent's code in the traceback; read from the frames, without any source file."""
    if isinstance(error, SyntaxError):
        return error.lineno
    line, step = None, error.__traceback__
    while step is not None:
        if step.tb_frame.f_code.co_filename == "agent":
            line = step.tb_lineno
        step = step.tb_next
    return line


def report(**data):
    sys.stdout.write("\nRESULT " + json.dumps(data) + "\n")
    sys.stdout.flush()


def plain(value, depth=0):
    """A result as the frame compares it; whatever is no plain value (a class with its own __eq__ too) is "other"."""
    kind = type(value)
    if value is None or kind in (bool, int, str):
        return value
    if kind is float:
        return value if value == value and value not in (float("inf"), float("-inf")) else {"type": "other"}
    if kind.__name__ == "Decimal" and kind.__module__ == "decimal":
        return str(value)
    if kind in (list, tuple) and depth < 20:
        return [plain(item, depth + 1) for item in value]
    if kind is dict and depth < 20 and all(type(key) is str for key in value):
        return {key: plain(item, depth + 1) for key, item in value.items()}
    return {"type": "other"}


def child():
    """Runs the agent's code and makes each call; prints what came back, never a verdict."""
    request = json.loads(sys.stdin.read())
    allowed = set(request.get("modules") or [])
    real_import = builtins.__import__

    def restricted(name, globals=None, locals=None, fromlist=(), level=0):
        if level != 0 or name.split(".")[0] not in allowed:
            raise ImportError("not allowed")
        return real_import(name, globals, locals, fromlist, level)

    names = {name: getattr(builtins, name) for name in ALLOWED}
    names["__import__"] = restricted
    names["__build_class__"] = builtins.__build_class__
    scope = {"__builtins__": names, "__name__": "agent"}
    try:
        exec(compile(request["code"], "agent", "exec"), scope)  # noqa: S102 - the agent's code, in its own process
    except BaseException as error:  # SystemExit as well: the agent's code may not end the run as it likes
        return report(error=type(error).__name__, line=line_of(error))
    results = []
    for case in request["calls"]:
        function = scope.get(case["call"])
        if not callable(function):
            return report(problem="no function " + case["call"])
        try:
            results.append(plain(function(*case["args"])))
        except BaseException as error:
            results.append({"raised": type(error).__name__, "line": line_of(error)})
    return report(results=results)


if __name__ == "__main__" and sys.argv[1:] == ["--child"]:
    child()
    sys.exit(0)

# The frame. Nothing below this line exists in the child process.
import hashlib  # noqa: E402
import os  # noqa: E402
import random  # noqa: E402
import selectors  # noqa: E402
import shutil  # noqa: E402
import signal  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402

CAP = 256 * 1024
# Modules a mission may allow; none of them reaches a file, the network, the environment or another process.
SAFE_MODULES = {"decimal", "math", "re", "datetime", "fractions", "statistics", "itertools", "functools", "collections",
                "string", "json", "unicodedata", "operator", "bisect", "heapq", "calendar"}


def version(suite, modules, cases):
    """The commit of the suite: this frame, its name, its modules and its frozen cases. Any change is another suite."""
    with open(__file__, "rb") as handle:
        frame = handle.read()
    frozen = json.dumps([suite, sorted(modules), cases], separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(frame + b"\n" + frozen).hexdigest()[:16]


def limits(seconds):
    def apply():
        import resource
        for name, value in (("RLIMIT_CPU", int(seconds) + 1), ("RLIMIT_AS", 512 << 20), ("RLIMIT_FSIZE", 1 << 20),
                            ("RLIMIT_NPROC", 0), ("RLIMIT_CORE", 0)):
            resource.setrlimit(getattr(resource, name), (value, value))
    return apply


def run(code, calls, modules, seconds):
    """→ (what the child reported or None, the problem of the run or None)."""
    work, folder = tempfile.mkdtemp(prefix="frame-"), tempfile.mkdtemp(prefix="agent-")
    try:
        with open(os.path.join(work, "request.json"), "w", encoding="utf-8") as handle:
            json.dump({"code": code, "calls": calls, "modules": modules}, handle)
        with open(os.path.join(work, "request.json"), "rb") as stdin:
            process = subprocess.Popen([sys.executable, "-I", "-S", os.path.abspath(__file__), "--child"], stdin=stdin,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=folder, env={},
                                       preexec_fn=limits(seconds), start_new_session=True)
        out, problem = read(process, time.monotonic() + seconds)
        if os.listdir(folder):
            problem = problem or "it wrote files"
        return (None if problem else last_result(out)), problem
    finally:
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(folder, ignore_errors=True)


def last_result(out):
    """The last line the child reported; whatever the agent's code printed before it is ignored."""
    for line in reversed(out.decode("utf-8", "replace").splitlines()):
        try:
            found = json.loads(line[7:]) if line.startswith("RESULT ") else None
        except ValueError:
            found = None
        if isinstance(found, dict):
            return found
    return None


def read(process, deadline):
    chunks, size, problem = [], 0, None
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            problem = "it ran longer than its time limit"
            break
        if not selector.select(left):
            continue
        chunk = os.read(process.stdout.fileno(), 65536)
        if not chunk:
            break
        size += len(chunk)
        if size > CAP:
            problem = "it printed more than allowed"
            break
        chunks.append(chunk)
    if problem is None:
        try:
            process.wait(timeout=max(0.05, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            problem = "it ran longer than its time limit"
    try:
        os.killpg(process.pid, signal.SIGKILL)  # the child and anything it started, whatever state it is in
    except ProcessLookupError:
        pass
    process.wait()
    return b"".join(chunks), problem


def wall(reason, repair):
    print(json.dumps({"value": None, "wall": {"cause": "move_failed", "reason": reason[:300], "repair": repair}}))
    sys.exit(0)


def well_formed(case):
    return isinstance(case, dict) and isinstance(case.get("call"), str) and case["call"].isidentifier() \
        and isinstance(case.get("args", []), list) and "expect" in case


def same(result, expect):
    if isinstance(expect, dict) and set(expect) == {"raises"}:
        return isinstance(result, dict) and result.get("raised") == expect["raises"]
    return result == expect


def main():
    request = json.load(sys.stdin)
    code = ((request.get("inputs") or [{}])[0] or {}).get("code")
    if not isinstance(code, str) or not code.strip():
        wall("the coding step wrote no code", {"problem": "no code"})
    suite, frozen = request.get("suite"), request.get("cases")
    modules = request.get("modules") or []
    if not isinstance(suite, str) or not suite or not isinstance(frozen, list) or not frozen or not all(map(well_formed, frozen)):
        wall("the frozen acceptance cases are missing", {"problem": "the acceptance tests are missing"})
    if not isinstance(modules, list) or any(name not in SAFE_MODULES for name in modules):
        wall("the suite allows a module the frame does not", {"problem": "the acceptance tests are missing"})
    cases = [dict(case, args=case.get("args", [])) for case in frozen]
    random.SystemRandom().shuffle(cases)
    seconds = request.get("seconds") if isinstance(request.get("seconds"), (int, float)) else 2
    seconds = min(5.0, max(0.1, float(seconds)))
    got, problem = run(code, [{"call": case["call"], "args": case["args"]} for case in cases], modules, seconds)
    if problem:
        wall(f"the acceptance run stopped: {problem}", {"problem": problem})
    if not got or "error" in got:
        repair = {"error": got["error"], "line": got.get("line")} if got else {"problem": "it returned no results"}
        wall("the code did not run", repair)
    if "problem" in got:
        # What the child reported is not trusted: only the core's own words for it go on (Executor.PROBLEMS).
        missing = isinstance(got["problem"], str) and got["problem"].startswith("no function ")
        problem = "the function it was asked for is missing" if missing else "it returned no results"
        wall(problem, {"problem": problem})
    results = got.get("results") if isinstance(got.get("results"), list) else []
    wrong = [i for i, case in enumerate(cases) if i >= len(results) or not same(results[i], case["expect"])]
    unexpected = [results[i] for i in wrong if i < len(results) and isinstance(results[i], dict) and "raised" in results[i]]
    if wrong:
        repair = {"error": unexpected[0]["raised"], "line": unexpected[0].get("line")} if unexpected else {"failed": len(wrong), "of": len(cases)}
        wall(f"{len(wrong)} of {len(cases)} acceptance cases failed", repair)
    print(json.dumps({"value": {"test": suite, "commit": version(suite, modules, frozen), "result": "green",
                                "code": hashlib.sha256(code.encode()).hexdigest()[:16], "passed": len(cases), "of": len(cases)}}))


main()
