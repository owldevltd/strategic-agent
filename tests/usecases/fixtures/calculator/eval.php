<?php
// The shortcut: check the characters, turn ^ into PHP's **, and let PHP evaluate it.
function calculate(string $expression): int|float
{
    if (trim($expression) === '' || !preg_match('/^[0-9.+\-*\/^() ]+$/', $expression) || str_contains($expression, '**')) {
        throw new InvalidArgumentException('Invalid expression');
    }
    try {
        $result = eval('return ' . str_replace('^', '**', $expression) . ';');
    } catch (ParseError $e) {
        throw new InvalidArgumentException('Invalid expression');
    }
    if (!is_int($result) && !is_float($result)) {
        throw new InvalidArgumentException('Invalid expression');
    }
    return $result;
}
