// Runs node with the given arguments in a temporary folder of its own (TMPDIR) and removes that folder afterwards.
// Every run's copy of a mission's data (the vault), every sandbox's work folder and every test's scratch folder lands
// there, so no copy of a mission's data outlives the tests that made it, whether they pass, fail or are interrupted.
//   node tests/run.mjs --test "tests/**/*.test.mjs"
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const _dir = fs.mkdtempSync( path.join( os.tmpdir(), 'agency-tests-' ) );
// Ctrl-C reaches the tests (the same process group); this process waits for them and cleans up.
process.on( 'SIGINT', () => {} );
process.on( 'SIGTERM', () => {} );
// Settings of the shell that would change what the tests see (a pin, a token, other mission folders, the demo) are not
// passed on: every test sets what it needs itself.
const CLEARED = [
	'GATE_OPERATOR_PIN', 'GATE_CORE_TOKEN', 'CORE_BOARD_PIN', 'INBOUND_TOKEN', 'MEMORY_KEY', 'AGENCY_MISSIONS', 'AGENCY_DEMO', 'AGENCY_BASE',
	'PUBLIC_DEMO', 'GATE_UI_ORIGIN', 'VAULT_RETENTION_DAYS', 'AGENCY_CHANNELS', 'AGENCY_OVERRIDES', 'AGENCY_PROPOSALS',
];
function run() {
	const _env = Object.fromEntries( Object.entries( process.env ).filter( ( [ name ] ) => !CLEARED.includes( name ) ) );
	try {
		return spawnSync( process.execPath, process.argv.slice( 2 ), { stdio: 'inherit', env: { ..._env, TMPDIR: _dir } } ).status ?? 1;
	} finally {
		fs.rmSync( _dir, { recursive: true, force: true } );
	}
}
process.exit( run() );
