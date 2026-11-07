<?php
declare(strict_types=1);

/**
 * A small calculator: + - * / ^, parentheses, unary minus, decimals with a dot, blanks anywhere.
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*
 *   unary   := '-' unary | power
 *   power   := primary ('^' unary)?        right-associative, binds tighter than unary minus
 *   primary := number | '(' expr ')'
 */
function calculate(string $expression): int|float
{
    $tokens = calc_tokenize($expression);
    if ($tokens === []) {
        throw new InvalidArgumentException('Empty expression');
    }
    $pos = 0;
    $value = calc_expr($tokens, $pos);
    if ($pos !== count($tokens)) {
        throw new InvalidArgumentException('Unexpected token at position ' . $pos);
    }
    return $value;
}

/** @return list<array{0: string, 1: int|float|null}> */
function calc_tokenize(string $expression): array
{
    $tokens = [];
    $length = strlen($expression);
    $i = 0;
    while ($i < $length) {
        $char = $expression[$i];
        if ($char === ' ' || $char === "\t" || $char === "\n" || $char === "\r") {
            $i++;
            continue;
        }
        if (ctype_digit($char)) {
            $start = $i;
            while ($i < $length && ctype_digit($expression[$i])) {
                $i++;
            }
            $isFloat = false;
            if ($i < $length && $expression[$i] === '.') {
                $i++;
                if ($i >= $length || !ctype_digit($expression[$i])) {
                    throw new InvalidArgumentException('Malformed number');
                }
                while ($i < $length && ctype_digit($expression[$i])) {
                    $i++;
                }
                $isFloat = true;
            }
            $text = substr($expression, $start, $i - $start);
            $tokens[] = ['num', $isFloat || strlen($text) > 18 ? (float) $text : (int) $text];
            continue;
        }
        if (strpos('+-*/^()', $char) !== false) {
            $tokens[] = [$char, null];
            $i++;
            continue;
        }
        throw new InvalidArgumentException('Unexpected character at position ' . $i);
    }
    return $tokens;
}

function calc_expr(array $tokens, int &$pos): int|float
{
    $value = calc_term($tokens, $pos);
    while ($pos < count($tokens) && ($tokens[$pos][0] === '+' || $tokens[$pos][0] === '-')) {
        $op = $tokens[$pos][0];
        $pos++;
        $right = calc_term($tokens, $pos);
        $value = $op === '+' ? $value + $right : $value - $right;
    }
    return $value;
}

function calc_term(array $tokens, int &$pos): int|float
{
    $value = calc_power($tokens, $pos);
    while ($pos < count($tokens) && ($tokens[$pos][0] === '*' || $tokens[$pos][0] === '/')) {
        $op = $tokens[$pos][0];
        $pos++;
        $right = calc_power($tokens, $pos);
        if ($op === '*') {
            $value = $value * $right;
        } else {
            if ($right == 0) {
                throw new DivisionByZeroError('Division by zero');
            }
            $value = $value / $right;
        }
    }
    return $value;
}

function calc_unary(array $tokens, int &$pos): int|float
{
    if ($pos < count($tokens) && $tokens[$pos][0] === '-') {
        $pos++;
        return -calc_primary($tokens, $pos);
    }
    return calc_primary($tokens, $pos);
}

function calc_power(array $tokens, int &$pos): int|float
{
    $base = calc_unary($tokens, $pos);
    while ($pos < count($tokens) && $tokens[$pos][0] === '^') {
        $pos++;
        $base = $base ** calc_unary($tokens, $pos);
    }
    return $base;
}

function calc_primary(array $tokens, int &$pos): int|float
{
    if ($pos >= count($tokens)) {
        throw new InvalidArgumentException('Unexpected end of expression');
    }
    [$kind, $value] = $tokens[$pos];
    if ($kind === 'num') {
        $pos++;
        return $value;
    }
    if ($kind === '(') {
        $pos++;
        $inner = calc_expr($tokens, $pos);
        if ($pos >= count($tokens) || $tokens[$pos][0] !== ')') {
            throw new InvalidArgumentException('Missing closing parenthesis');
        }
        $pos++;
        return $inner;
    }
    throw new InvalidArgumentException('Unexpected token ' . $kind);
}
