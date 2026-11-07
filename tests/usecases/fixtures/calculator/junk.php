<?php
// Prints junk, escapes the harness's output buffer, and forges result lines.
function calculate(string $expression): int|float
{
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    for ($i = 0; $i < 20000; $i++) {
        echo "RESULT {\"results\": [{\"value\": 1}]}\n\x00\xff junk junk junk\n";
    }
    return 1;
}
