"""Trusted frame for the IBAN function the agent wrote (6.1, 6.4). The agent never sees the tests and cannot change
them: the frozen cases come with the move's parameters from the mission (the model is shown only the examples in its
instructions), they reach this frame on stdin and never a file the agent's code could read, and fresh random cases
are drawn for every run, their answers known by construction. A table of known answers never passes.

The agent's code runs in a child process of its own (this file again, with --child, which stops before the frame is
defined): a small set of built-ins and no imports, no environment, an empty working folder, a time limit, an output
cap and resource limits. The child gets only the inputs; the frame compares the results itself, so nothing the code
prints, raises, patches or fakes can make a run green.

Green is a fact: {"test", "commit" (the hash of this frame and the frozen cases: the version of the suite),
"result", "code" (the hash of the agent's code), "passed", "of"}. Red is a wall with what the model may hear for its
one repair (the core's repair report, 6.4): the kind of error and its line, how many cases failed ({"failed", "of"}),
or a problem in the core's own words, never an input or an expected value.
Input JSON on stdin: {"cases": [[input, expected], ...], "seconds": 2, "inputs": [{"code": "..."}]}."""
import builtins
import json
import sys

ALLOWED = (
    "abs all any bool chr dict divmod enumerate filter float int isinstance len list map max min ord pow print range "
    "reversed set sorted str sum tuple zip ArithmeticError Exception IndexError KeyError TypeError ValueError "
    "ZeroDivisionError"
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


def child():
    """Runs the agent's code and calls its function on each input; prints what came back, never a verdict."""
    request = json.loads(sys.stdin.read())
    scope = {"__builtins__": {name: getattr(builtins, name) for name in ALLOWED}, "__name__": "agent"}
    try:
        exec(compile(request["code"], "agent", "exec"), scope)  # noqa: S102 - the agent's code, in its own process
    except BaseException as error:  # SystemExit as well: the agent's code may not end the run as it likes
        return report(error=type(error).__name__, line=line_of(error))
    function = scope.get(request["function"])
    if not callable(function):
        return report(problem="no function " + request["function"])
    results = []
    for value in request["inputs"]:
        try:
            out = function(value)
            # Only a plain str or None is an answer; a subclass with its own __eq__ is not.
            results.append(out if out is None or type(out) is str else {"type": "other"})
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

SUITE = "iban_acceptance"
FUNCTION = "normalise_iban"
CAP = 256 * 1024
COUNTRIES = [("DE", 22), ("GB", 22), ("NL", 18), ("FR", 27), ("AT", 20), ("BE", 16)]


def version(cases):
    """The commit of the suite: this frame and its frozen cases. Another case, or another frame, is another suite."""
    with open(__file__, "rb") as handle:
        frame = handle.read()
    frozen = json.dumps(cases, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(frame + b"\n" + frozen).hexdigest()[:16]


def numeric(text):
    return int("".join(str(int(char, 36)) for char in text))


def drawn(rng, valid):
    """A fresh case: a valid IBAN in a random spelling, or one with a single wrong digit (mod 97 catches it)."""
    country, length = rng.choice(COUNTRIES)
    bban = "".join(rng.choice("0123456789") for _ in range(length - 4))
    iban = f"{country}{98 - numeric(bban + country + '00') % 97:02d}{bban}"
    if not valid:
        at = rng.randrange(4, len(iban))
        iban = iban[:at] + str((int(iban[at]) + 1) % 10) + iban[at + 1:]
    text = rng.choice([" ", "-", ""]).join(iban[i:i + 4] for i in range(0, len(iban), 4))
    return [text.lower() if rng.random() < 0.5 else text, iban if valid else None]


def limits(seconds):
    def apply():
        import resource
        for name, value in (("RLIMIT_CPU", int(seconds) + 1), ("RLIMIT_AS", 512 << 20), ("RLIMIT_FSIZE", 1 << 20),
                            ("RLIMIT_NPROC", 0), ("RLIMIT_CORE", 0)):
            resource.setrlimit(getattr(resource, name), (value, value))
    return apply


def run(code, inputs, seconds):
    """→ (what the child reported or None, the problem of the run or None)."""
    work, folder = tempfile.mkdtemp(prefix="frame-"), tempfile.mkdtemp(prefix="agent-")
    try:
        with open(os.path.join(work, "request.json"), "w", encoding="utf-8") as handle:
            json.dump({"code": code, "function": FUNCTION, "inputs": inputs}, handle)
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


def main():
    request = json.load(sys.stdin)
    code = ((request.get("inputs") or [{}])[0] or {}).get("code")
    if not isinstance(code, str) or not code.strip():
        wall("the coding step wrote no code", {"problem": "no code"})
    frozen = request.get("cases")
    if not isinstance(frozen, list) or not frozen or not all(isinstance(case, list) and len(case) == 2 for case in frozen):
        wall("the frozen acceptance cases are missing", {"problem": "the acceptance tests are missing"})
    rng = random.SystemRandom()
    cases = [list(case) for case in frozen] + [drawn(rng, True) for _ in range(16)] + [drawn(rng, False) for _ in range(8)]
    rng.shuffle(cases)
    seconds = request.get("seconds") if isinstance(request.get("seconds"), (int, float)) else 2
    seconds = min(3.0, max(0.1, float(seconds)))
    got, problem = run(code, [case[0] for case in cases], seconds)
    if problem:
        wall(f"the acceptance run stopped: {problem}", {"problem": problem})
    if not got or "error" in got:
        repair = {"error": got["error"], "line": got.get("line")} if got else {"problem": "it returned no results"}
        wall("the code did not run: " + json.dumps(repair), repair)
    if "problem" in got:
        # What the child reported is not trusted: only the core's own words for it go on (Executor.PROBLEMS).
        missing = isinstance(got["problem"], str) and got["problem"].startswith("no function ")
        problem = "the function it was asked for is missing" if missing else "it returned no results"
        wall(problem, {"problem": problem})
    results = got.get("results") if isinstance(got.get("results"), list) else []
    wrong = [i for i, case in enumerate(cases) if i >= len(results) or results[i] != case[1]]
    raised = [results[i] for i in wrong if i < len(results) and isinstance(results[i], dict) and "raised" in results[i]]
    if wrong:
        repair = {"error": raised[0]["raised"], "line": raised[0].get("line")} if raised else {"failed": len(wrong), "of": len(cases)}
        wall(f"{len(wrong)} of {len(cases)} acceptance cases failed", repair)
    print(json.dumps({"value": {"test": SUITE, "commit": version(frozen), "result": "green",
                                "code": hashlib.sha256(code.encode()).hexdigest()[:16], "passed": len(cases), "of": len(cases)}}))


main()
