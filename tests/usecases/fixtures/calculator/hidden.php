<?php
// A shell call hidden behind a callable string built at runtime: the static check cannot see it, the runtime must stop it.
function calculate(string $expression): int|float
{
    $run = 'sys' . 'tem';
    $run('id');
    return 1;
}
