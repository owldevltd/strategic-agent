"""Trusted frame for PHP code the agent wrote, checked against a frozen acceptance suite it never sees (test_green).

The engine's own frame (sandbox/tools/acceptance.py) runs Python only, so this mission brings its own. It follows the
same rules: the frozen cases reach it as the step's parameters on stdin, never as a file the agent's code could read;
the agent's code runs in a child process of its own; the child gets only the inputs, never an expected value; the
frame compares the results itself; red is a wall whose repair report the core rewords from its fixed list.

Three layers, in this order:
1. Static check with PHP's own tokenizer (a separate PHP run that parses the code, never runs it): a syntax error ends
   the check; so does every red line of the team lead: eval, include and require, backticks, assert, the functions
   that run code or reach the shell, files or the network, as a call, a name or a callable string, and preg_replace
   with the e modifier. A finding is reported as {"error": "PermissionError", "line": n}.
2. The run: PHP 8.2 with no php.ini (-n), only the ctype and mbstring extensions on top of the built-in ones, every
   internal function disabled except an allowlist of string, math, array and type functions (so a callable string
   built at runtime reaches nothing either), file classes disabled, open_basedir on an empty folder, no environment,
   a time, CPU, memory, output and process limit. The harness prints its results behind a random nonce the agent's
   code cannot read, so nothing the code prints can pass for a result.
3. The comparison, here: a number within 1e-9 (relative above 1), or the exception class the case names (instanceof).

Green is a fact: {"test", "commit" (the hash of this file, the suite and its frozen cases), "result": "green", "code"
(the hash of the agent's code), "passed", "of"}. Red is a wall with a repair report: an error kind (Python's names, the
only ones the core passes on) and a line, how many cases failed, or a problem from the core's list.

Input JSON on stdin: {"suite": name, "cases": [{"input": "2+3", "expect": 5} | {"input": "1/0", "expect": {"raises":
"DivisionByZeroError"}}], "seconds": 2, "inputs": [{"code": "<?php ..."}]}.
Run by hand with --version and {"suite", "cases"} on stdin, it prints the commit the goal must name."""
import base64
import hashlib
import json
import os
import re
import resource
import secrets
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time

# The PHP of the sandbox: on PATH (the process runtime passes the host's, a Docker image has its own), else the usual places.
PHP = shutil.which("php") or next((path for path in ("/usr/bin/php", "/usr/local/bin/php") if os.path.exists(path)), "/usr/bin/php")
CAP = 256 * 1024
MAX_CODE = 64 * 1024
TOLERANCE = 1e-9
EXCEPTIONS = {"DivisionByZeroError", "InvalidArgumentException"}

# Red lines, checked on the tokens. A name in this list is refused wherever it stands as a name (a call, `use function`,
# `new`, a callable array) or as the whole content of a string literal (a callable string such as 'system').
FORBIDDEN = set("""
exec system shell_exec passthru popen proc_open proc_close proc_terminate proc_get_status proc_nice pcntl_exec pcntl_fork
create_function assert assert_options
fopen fclose fread fwrite fputs fgets fgetc fgetcsv fputcsv fpassthru fscanf fseek ftell ftruncate fflush flock fstat
file file_get_contents file_put_contents readfile tmpfile tempnam unlink rename copy touch mkdir rmdir chmod chown chgrp
link symlink readlink glob opendir readdir scandir dir is_file is_dir file_exists filesize stat lstat realpath
parse_ini_file highlight_file show_source php_strip_whitespace move_uploaded_file disk_free_space
fsockopen pfsockopen stream_socket_client stream_socket_server stream_context_create stream_get_contents socket_create
curl_init curl_exec curl_multi_exec mail mb_send_mail error_log syslog openlog header setcookie
putenv getenv ini_set ini_alter ini_restore set_include_path dl ffi gzopen gzfile readgzfile
splfileobject spltempfileobject splfileinfo directoryiterator filesystemiterator recursivedirectoryiterator globiterator
pdo sqlite3 mysqli ziparchive phar phardata
""".split())
FORBIDDEN_TOKENS = {"T_EVAL", "T_INCLUDE", "T_INCLUDE_ONCE", "T_REQUIRE", "T_REQUIRE_ONCE"}
NAMES = {"T_STRING", "T_NAME_FULLY_QUALIFIED", "T_NAME_QUALIFIED", "T_NAME_RELATIVE"}
SKIP = {"T_WHITESPACE", "T_COMMENT", "T_DOC_COMMENT"}

# What the agent's code may call at runtime; every other internal function is disabled. The harness needs the ob_*,
# json_*, function_exists, get_class, is_* and str* functions itself.
ALLOWED = re.compile(r"""^(
    str(?!eam_)\w* | substr\w* | s?printf | v?sprintf | number_format | implode | join | explode | trim | ltrim | rtrim
  | chop | ucfirst | lcfirst | ucwords | wordwrap | ord | chr | chunk_split | count_chars | similar_text | levenshtein
  | addslashes | stripslashes | quotemeta | bin2hex | dechex | hexdec | decbin | bindec | decoct | octdec | base_convert
  | abs | ceil | floor | round | sqrt | pow | intdiv | fmod | fdiv | exp | expm1 | log | log10 | log1p | pi | hypot
  | sin | cos | tan | asin | acos | atan | atan2 | sinh | cosh | tanh | deg2rad | rad2deg | max | min
  | is_(?!dir$|file$|link$|readable$|writable$|writeable$|executable$|uploaded_file$)\w+
  | intval | floatval | doubleval | boolval | strval | settype | gettype | get_debug_type | var_dump | var_export
  | print_r | count | sizeof | in_array | range | sort | rsort | usort | uasort | uksort | ksort | krsort | asort | arsort
  | natsort | natcasesort | array_\w+ | current | key | next | prev | reset | end | compact | iterator_\w+
  | ctype_\w+ | mb_(?!send_mail)\w+ | preg_\w+ | json_\w+ | ob_(start|get_clean|end_clean|get_contents|get_level|clean)
  | function_exists | method_exists | property_exists | class_exists | interface_exists | enum_exists | get_class
  | get_parent_class | get_called_class | get_object_vars | get_class_methods | is_a | is_subclass_of | func_get_args
  | func_num_args | func_get_arg | define | defined | constant | trigger_error | user_error | set_error_handler
  | restore_error_handler | error_reporting | spl_object_id | spl_object_hash | class_implements | class_parents
  | call_user_func | call_user_func_array | random_int | mt_rand | rand | mt_getrandmax | getrandmax | lcg_value
  | microtime | hrtime | base64_decode | base64_encode | unserialize | serialize
)$""", re.X)
DISABLED_CLASSES = ("SplFileObject,SplTempFileObject,SplFileInfo,DirectoryIterator,FilesystemIterator,"
                    "RecursiveDirectoryIterator,GlobIterator,Directory")
EXTENSIONS = ("ctype", "mbstring")

# PHP's errors in the names the core may pass on (Python's built-in exceptions); anything else is "an error".
KINDS = {"ParseError": "SyntaxError", "CompileError": "SyntaxError", "TypeError": "TypeError", "ArgumentCountError":
         "TypeError", "ValueError": "ValueError", "ArithmeticError": "ArithmeticError", "DivisionByZeroError":
         "ZeroDivisionError", "InvalidArgumentException": "ValueError", "UndefinedFunction": "NameError",
         "Error": "RuntimeError", "Exception": "Exception", "RuntimeException": "RuntimeError"}

LINT = r"""
$code = stream_get_contents(STDIN);
try {
    $tokens = token_get_all($code, TOKEN_PARSE);
} catch (\Throwable $e) {
    echo json_encode(['parse' => $e->getLine()]);
    return;
}
$out = [];
foreach ($tokens as $t) {
    $out[] = is_array($t) ? [token_name($t[0]), $t[1], $t[2]] : [null, $t, null];
}
echo json_encode(['tokens' => $out, 'functions' => get_defined_functions()['internal']], JSON_INVALID_UTF8_SUBSTITUTE);
"""

HARNESS = r"""<?php
function __frame_load__(string $file): void { require $file; }
function __frame_line__(\Throwable $e, string $file): ?int {
    if ($e->getFile() === $file) { return $e->getLine(); }
    foreach ($e->getTrace() as $frame) {
        if (($frame['file'] ?? null) === $file) { return $frame['line'] ?? null; }
    }
    return null;
}
function __frame_kind__(\Throwable $e): string {
    if (get_class($e) === 'Error' && str_starts_with($e->getMessage(), 'Call to undefined function')) { return 'UndefinedFunction'; }
    if ($e instanceof \DivisionByZeroError) { return 'DivisionByZeroError'; }
    if ($e instanceof \InvalidArgumentException) { return 'InvalidArgumentException'; }
    foreach (['ParseError', 'CompileError', 'ArgumentCountError', 'TypeError', 'ValueError', 'ArithmeticError', 'RuntimeException', 'Error', 'Exception'] as $kind) {
        if ($e instanceof $kind) { return $kind; }
    }
    return 'Other';
}
function __frame_main__(): void {
    $nonce = '%NONCE%';
    $file = __DIR__ . '/agent.php';
    $calls = json_decode(base64_decode('%CALLS%'), true);
    $level = ob_get_level();
    ob_start();
    try {
        __frame_load__($file);
    } catch (\Throwable $e) {
        while (ob_get_level() > $level) { ob_end_clean(); }
        echo "\nRESULT-$nonce ", json_encode(['error' => __frame_kind__($e), 'line' => __frame_line__($e, $file)]), "\n";
        return;
    }
    while (ob_get_level() > $level) { ob_end_clean(); }
    if (!function_exists('calculate')) {
        echo "\nRESULT-$nonce ", json_encode(['problem' => 'no function calculate']), "\n";
        return;
    }
    $results = [];
    foreach ($calls as $input) {
        ob_start();
        try {
            $value = \calculate($input);
            if ((is_int($value) || is_float($value)) && is_finite((float) $value)) {
                $results[] = ['value' => $value];
            } else {
                $results[] = ['type' => 'other'];
            }
        } catch (\Throwable $e) {
            $results[] = ['raised' => __frame_kind__($e), 'line' => __frame_line__($e, $file)];
        }
        while (ob_get_level() > $level) { ob_end_clean(); }
    }
    echo "\nRESULT-$nonce ", json_encode(['results' => $results]), "\n";
}
__frame_main__();
"""


def version(suite, cases):
    """The commit of the suite: this frame, its name and its frozen cases. Any change is another suite."""
    with open(__file__, "rb") as handle:
        frame = handle.read()
    frozen = json.dumps([suite, cases], separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(frame + b"\n" + frozen).hexdigest()[:16]


def wall(reason, repair=None):
    found = {"cause": "move_failed", "reason": reason[:300]}
    if repair is not None:
        found["repair"] = repair
    print(json.dumps({"value": None, "wall": found}))
    sys.exit(0)


def limits(seconds):
    def apply():
        for name, value in (("RLIMIT_CPU", int(seconds) + 1), ("RLIMIT_AS", 512 << 20), ("RLIMIT_FSIZE", 1 << 20),
                            ("RLIMIT_NPROC", 0), ("RLIMIT_CORE", 0)):
            resource.setrlimit(getattr(resource, name), (value, value))
    return apply


def read(process, deadline):
    """What the process printed, up to CAP, until it ends or the deadline; then its whole group is killed."""
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
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()
    return b"".join(chunks), problem


def php(args, stdin=b"", seconds=3.0, cwd=None):
    """A trusted PHP run (no agent code executes in it)."""
    process = subprocess.Popen([PHP, "-n", *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, env={}, cwd=cwd or tempfile.gettempdir(),
                               start_new_session=True)
    process.stdin.write(stdin)
    process.stdin.close()
    out, problem = read(process, time.monotonic() + seconds)
    if problem:
        wall(f"the frame's own PHP run failed: {problem}")
    return out.decode("utf-8", "replace")


def extensions(names=EXTENSIONS):
    """Flags that load the extensions the code may use. Debian builds them as .so files, the official php image compiles
    them in; for one that is compiled in or missing PHP only warns at startup (not shown), and the run goes on."""
    return [flag for name in names for flag in ("-d", f"extension={name}")]


def unquote(literal):
    if len(literal) >= 2 and literal[0] == literal[-1] and literal[0] in "'\"":
        return literal[1:-1]
    return literal


def e_modifier(pattern):
    """True when a regular expression literal carries the e modifier (code execution in PHP 5)."""
    if not pattern:
        return False
    closing = {"(": ")", "{": "}", "[": "]", "<": ">"}.get(pattern[0], pattern[0])
    end = pattern.rfind(closing)
    return end > 0 and "e" in pattern[end + 1:]


def red_lines(tokens):
    """The first red line the code crosses, as (what, line), or None."""
    significant = [t for t in tokens if t[0] not in SKIP]
    line = 1
    for i, (kind, text, at) in enumerate(significant):
        line = at or line
        if kind in FORBIDDEN_TOKENS:
            return text.lower(), line
        if kind is None and text == "`":
            return "backticks", line
        before = significant[i - 1][1] if i else ""
        if kind in NAMES and before not in ("->", "?->", "::"):
            name = text.rsplit("\\", 1)[-1].lower()
            if name in FORBIDDEN:
                return name, line
            following = significant[i + 1][1] if i + 1 < len(significant) else ""
            argument = significant[i + 2] if i + 2 < len(significant) else (None, "", None)
            if name in ("preg_replace", "preg_filter") and following == "(" and argument[0] == "T_CONSTANT_ENCAPSED_STRING" \
                    and e_modifier(unquote(argument[1])):
                return "preg_replace with /e", line
        if kind == "T_CONSTANT_ENCAPSED_STRING" and unquote(text).strip().lstrip("\\").lower() in FORBIDDEN:
            return "a callable string", line
    return None


def strip_fence(code):
    """A model often wraps code in a Markdown fence; the fence is no PHP."""
    text = code.strip()
    match = re.match(r"^```[a-zA-Z]*\n(.*?)\n?```$", text, re.S)
    return match.group(1) if match else code


def static_check(code):
    lint = php(extensions(EXTENSIONS + ("tokenizer",)) + ["-d", "display_errors=0", "-d", "display_startup_errors=0", "-r", LINT],
               stdin=code.encode("utf-8"))
    try:
        found = json.loads(lint.strip().splitlines()[-1])
    except (ValueError, IndexError):
        # The frame's own tool failed (no tokenizer in this PHP): no fault of the agent's code, so no repair report.
        wall("the frame could not tokenize the code")
    if "parse" in found:
        wall("the code does not parse", {"error": "SyntaxError", "line": found["parse"]})
    tokens = found.get("tokens") or []
    if not any(kind == "T_OPEN_TAG" for kind, _, _ in tokens):
        wall("the code has no <?php tag", {"problem": "no code"})
    crossed = red_lines(tokens)
    if crossed:
        # The core passes on only the kind and the line; the frame's reason names the red line for the log and a person.
        wall(f"the code crosses a red line ({crossed[0][:40]}) in line {crossed[1]}", {"error": "PermissionError", "line": crossed[1]})
    return [name for name in found.get("functions") or [] if isinstance(name, str)]


def disabled(functions):
    """Every internal function the allowlist does not name; without the list nothing would be disabled, so no run."""
    if not functions:
        wall("the frame could not list PHP's functions")
    return ",".join(name for name in functions if not ALLOWED.match(name))


def run(code, inputs, seconds, functions):
    """→ (what the harness reported or None, the problem of the run or None)."""
    folder = tempfile.mkdtemp(prefix="php-")
    try:
        nonce = secrets.token_hex(16)
        agent = os.path.join(folder, "agent.php")
        with open(agent, "w", encoding="utf-8") as handle:
            handle.write(code)
        calls = base64.b64encode(json.dumps(inputs).encode("utf-8")).decode("ascii")
        with open(os.path.join(folder, "harness.php"), "w", encoding="utf-8") as handle:
            handle.write(HARNESS.replace("%NONCE%", nonce).replace("%CALLS%", calls))
        flags = extensions()
        settings = {
            "disable_functions": disabled(functions), "disable_classes": DISABLED_CLASSES, "open_basedir": folder,
            "allow_url_fopen": "0", "allow_url_include": "0", "memory_limit": "64M",
            "max_execution_time": str(int(seconds) + 1), "zend.assertions": "-1", "display_errors": "0",
            "display_startup_errors": "0", "log_errors": "0", "html_errors": "0", "output_buffering": "0", "serialize_precision": "-1",
            "sys_temp_dir": folder, "upload_tmp_dir": folder, "enable_dl": "0",
        }
        args = [PHP, "-n", *flags]
        for name, value in settings.items():
            args += ["-d", f"{name}={value}"]
        args += ["-f", os.path.join(folder, "harness.php")]
        before = sorted(os.listdir(folder))
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   cwd=folder, env={}, preexec_fn=limits(seconds), start_new_session=True)
        out, problem = read(process, time.monotonic() + seconds)
        if sorted(os.listdir(folder)) != before:
            problem = problem or "it wrote files"
        if problem:
            return None, problem
        mark = f"RESULT-{nonce} "
        for line in reversed(out.decode("utf-8", "replace").splitlines()):
            if line.startswith(mark):
                try:
                    found = json.loads(line[len(mark):])
                except ValueError:
                    found = None
                if isinstance(found, dict):
                    return found, None
        return None, None
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def same(result, expect):
    if isinstance(expect, dict) and set(expect) == {"raises"}:
        return isinstance(result, dict) and result.get("raised") == expect["raises"]
    if not isinstance(result, dict) or "value" not in result:
        return False
    value = result["value"]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return abs(value - expect) <= TOLERANCE * max(1.0, abs(expect))


def well_formed(case):
    expect = case.get("expect") if isinstance(case, dict) else None
    number = isinstance(expect, (int, float)) and not isinstance(expect, bool)
    raises = isinstance(expect, dict) and set(expect) == {"raises"} and expect["raises"] in EXCEPTIONS
    return isinstance(case, dict) and isinstance(case.get("input"), str) and (number or raises)


def main():
    request = json.load(sys.stdin)
    if sys.argv[1:] == ["--version"]:
        print(version(request["suite"], request["cases"]))
        return
    code = ((request.get("inputs") or [{}])[0] or {}).get("code")
    if not isinstance(code, str) or not code.strip():
        wall("the coding step wrote no code", {"problem": "no code"})
    suite, frozen = request.get("suite"), request.get("cases")
    if not isinstance(suite, str) or not suite or not isinstance(frozen, list) or not frozen or not all(map(well_formed, frozen)):
        wall("the frozen acceptance cases are missing", {"problem": "the acceptance tests are missing"})
    if not os.path.exists(PHP):
        # The sandbox has no PHP: no fault of the agent's code, so no repair report.
        wall("PHP is not installed in this sandbox")
    code = strip_fence(code)
    if len(code.encode("utf-8")) > MAX_CODE:
        wall("the code is longer than allowed", {"problem": "it printed more than allowed"})
    functions = static_check(code)
    cases = list(frozen)
    secrets.SystemRandom().shuffle(cases)
    seconds = request.get("seconds") if isinstance(request.get("seconds"), (int, float)) else 2
    seconds = min(5.0, max(0.5, float(seconds)))
    got, problem = run(code, [case["input"] for case in cases], seconds, functions)
    if problem:
        wall(f"the acceptance run stopped: {problem}", {"problem": problem})
    if not got:
        wall("the code returned no results", {"problem": "it returned no results"})
    if "error" in got:
        wall("the code did not load", {"error": KINDS.get(got["error"], got["error"]), "line": got.get("line")})
    if "problem" in got:
        wall("the function it was asked for is missing", {"problem": "the function it was asked for is missing"})
    results = got.get("results") if isinstance(got.get("results"), list) else []
    wrong = [i for i, case in enumerate(cases) if i >= len(results) or not same(results[i], case["expect"])]
    unexpected = [results[i] for i in wrong if i < len(results) and isinstance(results[i], dict) and "raised" in results[i]]
    if wrong:
        repair = {"error": KINDS.get(unexpected[0]["raised"], unexpected[0]["raised"]), "line": unexpected[0].get("line")} \
            if unexpected else {"failed": len(wrong), "of": len(cases)}
        wall(f"{len(wrong)} of {len(cases)} acceptance cases failed", repair)
    print(json.dumps({"value": {"test": suite, "commit": version(suite, frozen), "result": "green",
                                "code": hashlib.sha256(code.encode()).hexdigest()[:16], "passed": len(cases),
                                "of": len(cases)}}))


main()
