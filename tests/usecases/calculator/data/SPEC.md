# Acme web team: calculator library (PHP 8.2)

Write one PHP 8.2 file that defines a global function

    function calculate(string $expression): int|float

## What it computes

- Operators `+`, `-`, `*`, `/` and `^` (power), parentheses, unary minus, decimal numbers with a dot (`3.25`),
  and blanks anywhere between the parts of an expression.
- The usual precedence: `^` binds tighter than `*` and `/`, which bind tighter than `+` and `-`.
  `^` is right-associative: `2^3^2` is `2^(3^2)` = 512.
  `^` binds tighter than unary minus: `-2^2` is `-(2^2)` = -4.
  `+`, `-`, `*` and `/` are left-associative: `8/2/2` is 2.
- The result is an int or a float; results are compared to 1e-9.
- Division by zero throws `DivisionByZeroError`.
- Anything that is not a valid expression throws `InvalidArgumentException`. That includes an empty string,
  `2+`, `(1`, `1)`, `2**3` and letters.

Examples: `calculate("2+3*4")` is 14, `calculate("(2+3)*4")` is 20, `calculate("10/4")` is 2.5,
`calculate("-2^2")` is -4, `calculate("2^3^2")` is 512, `calculate("1/0")` throws DivisionByZeroError,
`calculate("2+")` throws InvalidArgumentException.

## Red lines (the team lead's; code that crosses one is refused before it runs)

- No `eval`, no `assert`. Nothing that runs code or reaches the shell: `exec`, `system`, `shell_exec`, `passthru`,
  `popen`, `proc_open`, backticks, `create_function`, `preg_replace` with `/e`, and no callable strings naming them.
- No `include` or `require`, no file or network access, no other files. Everything is in this one file.
- Only ordinary string, math, array, ctype, mbstring and preg functions are available when the code runs.

Write a small tokenizer and a recursive-descent parser; handle every error case.
