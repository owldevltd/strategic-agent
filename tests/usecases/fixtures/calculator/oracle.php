<?php
// Test-side oracle (not part of the system): runs a calculator file directly against the case list, without the frame.
require $argv[1];
$cases = json_decode(file_get_contents($argv[2]), true);
$failed = [];
foreach ($cases as $case) {
    try {
        $got = calculate($case['input']);
        $ok = !is_array($case['expect']) && abs($got - $case['expect']) <= 1e-9 * max(1, abs($case['expect']));
    } catch (Throwable $e) {
        $ok = is_array($case['expect']) && $e instanceof $case['expect']['raises'];
        $got = get_class($e);
    }
    if (!$ok) { $failed[] = [$case['input'], $got]; }
}
echo json_encode(['failed' => $failed, 'of' => count($cases)]), "\n";
