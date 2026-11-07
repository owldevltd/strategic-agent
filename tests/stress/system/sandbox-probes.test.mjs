// Stress tests of core/sandbox/probes.js: the escape test of 7.1. Attacker code runs in the sandbox of the agent's code,
// probe after probe; a probe counts as stopped only if Python really ran there and was stopped, not if the container
// never started. Only fake runtimes run here (and DockerRuntime with docker intercepted): the probes are never run on
// this machine.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { use } from '../../helper.mjs';
import { attack, attacks, within } from '../hostile.mjs';

const SUBJECT = 'core/sandbox/probes.js';
const [ Probes, ProcessRuntime, DockerRuntime, Runtime ] = await use( 'Core.Sandbox.Probes', 'Core.Sandbox.ProcessRuntime',
	'Core.Sandbox.DockerRuntime', 'Core.Sandbox.Runtime' );
const NAMES = [ 'runs code and returns its result', 'network: send data out', 'secrets: read keys from the environment',
	'host: write into the system', 'time: endless loop', 'memory: take 1 GB', 'processes: fork bomb' ];

const ok = ( stdout = '' ) => ( { exitCode: 0, stdout, stderr: '' } );
const fail = ( exitCode, stderr = '', stdout = '' ) => ( { exitCode, stdout, stderr } );
const NO_DOCKER = fail( -1, 'spawn docker ENOENT' );
const DAEMON = fail( 125, 'docker: Error response from daemon: OCI runtime create failed: unable to start container process' );
const NO_FILE = fail( 2, 'python: can\'t open file \'/work/main.py\': [Errno 13] Permission denied' );

// What a well contained sandbox answers to each probe, in the order of Probes.LIST.
const CONTAINED = [
	ok( '42\n' ),
	fail( 1, 'urllib.error.URLError: <urlopen error [Errno -3] Temporary failure in name resolution>' ),
	ok( '[]\n' ),
	fail( 1, 'OSError: [Errno 30] Read-only file system: \'/usr/local/pwned\'' ),
	fail( 124 ),
	fail( 137, 'Killed' ),
	fail( 1, 'BlockingIOError: [Errno 11] Resource temporarily unavailable' ),
];

// A fake isolated runtime: answers by probe index, records what it was asked and whether two runs overlapped.
class Fake {

	static NAME = 'fake';
	static ISOLATED = true;

	constructor( answers = CONTAINED ) {
		this.answers = answers;
		this.calls = [];
		this.busy = 0;
		this.overlap = false;
	}

	async run( args ) {
		this.calls.push( args );
		this.overlap = this.overlap || this.busy > 0;
		this.busy++;
		await new Promise( resolve => setImmediate( resolve ) );
		this.busy--;
		const _answer = this.answers[ this.calls.length - 1 ];
		if ( _answer instanceof Error ) { throw _answer; }
		return _answer;
	}

}

const with7 = ( index, answer ) => CONTAINED.map( ( item, i ) => ( i === index ? answer : item ) );
const probe = index => Probes.LIST[ index ];

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────

attack( SUBJECT, 'there are seven probes, harmless first, in the documented order', () => {
	assert.deepEqual( Probes.LIST.map( item => item.name ), NAMES );
	assert.ok( Probes.LIST.every( item => typeof item.code === 'string' && typeof item.stopped === 'function' ) );
} );

attack( SUBJECT, 'each probe tries what its name says', () => {
	assert.equal( probe( 0 ).code, 'print(6 * 7)' );
	assert.match( probe( 1 ).code, /urlopen\("https:\/\/example\.com", timeout=3\)/ );
	assert.match( probe( 2 ).code, /os\.environ/ );
	[ 'KEY', 'TOKEN', 'SECRET', 'PIN', 'PASS' ].forEach( word => assert.ok( probe( 2 ).code.includes( `"${word}"` ) ) );
	assert.match( probe( 3 ).code, /open\("\/usr\/local\/pwned", "w"\)/ );
	assert.match( probe( 4 ).code, /while True:/ );
	assert.match( probe( 5 ).code, /bytearray\(1024 \* 1024 \* 1024\)/ );
	assert.match( probe( 6 ).code, /os\.fork\(\)/ );
	assert.match( probe( 6 ).code, /range\(500\)/ );
} );

attack( SUBJECT, 'every probe is valid Python 3 (compiled here, never run)', () => {
	const _check = 'import sys, json\nfor code in json.load(sys.stdin):\n    compile(code, "probe", "exec")\nprint("compiled")';
	const _result = spawnSync( 'python3', [ '-I', '-c', _check ], { input: JSON.stringify( Probes.LIST.map( item => item.code ) ), encoding: 'utf8', timeout: 5000 } );
	assert.equal( _result.stdout.trim(), 'compiled', _result.stderr );
} );

// ── the verdict of each probe ────────────────────────────────────────────────────────────────────────────────────

const VERDICTS = [
	{ index: 0, run: ok( '42\n' ), stopped: true, name: 'the harmless probe passes when Python printed 42' },
	{ index: 0, run: ok( '  42  ' ), stopped: true, name: 'the harmless probe ignores surrounding whitespace' },
	{ index: 0, run: ok( '420' ), stopped: false, name: 'the harmless probe needs exactly 42, not 420' },
	{ index: 0, run: fail( 1, '', '42' ), stopped: false, name: 'the harmless probe needs exit 0' },
	{ index: 0, run: NO_DOCKER, stopped: false, name: 'the harmless probe fails when docker is missing' },
	{ index: 1, run: fail( 1, 'urllib.error.URLError: <urlopen error [Errno -3] Temporary failure in name resolution>' ), stopped: true, name: 'network: a failed name resolution is stopped' },
	{ index: 1, run: fail( 1, 'OSError: [Errno 101] Network is unreachable' ), stopped: true, name: 'network: an unreachable network is stopped' },
	{ index: 1, run: ok( '' ), stopped: false, name: 'network: a request that went out is an escape' },
	{ index: 1, run: DAEMON, stopped: false, name: 'network: a container that never started proves nothing' },
	{ index: 1, run: NO_FILE, stopped: false, name: 'network: Python that could not even open the script proves nothing' },
	{ index: 2, run: ok( '[]\n' ), stopped: true, name: 'secrets: an environment without keys is stopped' },
	{ index: 2, run: ok( '[\'LLM_API_KEY\']\n' ), stopped: false, name: 'secrets: a key name seen in the environment is an escape' },
	{ index: 2, run: fail( 1, 'Traceback' ), stopped: false, name: 'secrets: a probe that crashed proves nothing' },
	{ index: 3, run: fail( 1, 'OSError: [Errno 30] Read-only file system: \'/usr/local/pwned\'' ), stopped: true, name: 'host: a read-only file system is stopped' },
	{ index: 3, run: fail( 1, 'PermissionError: [Errno 13] Permission denied: \'/usr/local/pwned\'' ), stopped: true, name: 'host: a permission error is stopped' },
	{ index: 3, run: ok( '' ), stopped: false, name: 'host: a write that succeeded is an escape' },
	{ index: 3, run: fail( 1, 'FileNotFoundError: [Errno 2] No such file or directory: \'/usr/local/pwned\'' ), stopped: false, name: 'host: a missing folder is no proof of a read-only system' },
	{ index: 4, run: fail( 124 ), stopped: true, name: 'time: an endless loop ended by timeout (124) is stopped' },
	{ index: 4, run: fail( 137, 'Killed' ), stopped: true, name: 'time: an endless loop killed (137) is stopped' },
	{ index: 4, run: ok( '' ), stopped: false, name: 'time: an endless loop that "finished" is an escape' },
	{ index: 4, run: NO_DOCKER, stopped: false, name: 'time: no docker binary is no stopped loop' },
	{ index: 4, run: DAEMON, stopped: false, name: 'time: a daemon refusal (125) is no stopped loop' },
	{ index: 5, run: fail( 137, 'Killed' ), stopped: true, name: 'memory: killed by the cgroup is stopped' },
	{ index: 5, run: fail( 1, 'MemoryError' ), stopped: true, name: 'memory: a MemoryError is stopped' },
	{ index: 5, run: ok( 'got 1 GB\n' ), stopped: false, name: 'memory: 1 GB taken is an escape' },
	{ index: 5, run: fail( 137, 'Killed', 'got 1 GB\n' ), stopped: false, name: 'memory: 1 GB taken and killed afterwards is still an escape' },
	{ index: 5, run: NO_DOCKER, stopped: false, name: 'memory: no docker binary is no stopped allocation' },
	{ index: 5, run: DAEMON, stopped: false, name: 'memory: a daemon refusal is no stopped allocation' },
	{ index: 6, run: fail( 1, 'BlockingIOError: [Errno 11] Resource temporarily unavailable' ), stopped: true, name: 'processes: a fork refused by the pids limit is stopped' },
	{ index: 6, run: ok( '500 processes\n' ), stopped: false, name: 'processes: 500 processes started is an escape' },
	{ index: 6, run: NO_DOCKER, stopped: false, name: 'processes: no docker binary is no stopped fork bomb' },
	{ index: 6, run: NO_FILE, stopped: false, name: 'processes: Python that could not open the script is no stopped fork bomb' },
];

attacks( SUBJECT, VERDICTS, ( { index, run, stopped } ) => {
	assert.equal( probe( index ).stopped( run ), stopped );
} );

// ── run() ────────────────────────────────────────────────────────────────────────────────────────────────────────

attacks( SUBJECT, [
	{ name: 'run refuses the development ProcessRuntime before anything runs', runtime: () => new ProcessRuntime( { timeoutSeconds: 1 } ) },
	{ name: 'run refuses a plain object without a class that says it is isolated', runtime: () => ( { run: async () => ok( '42' ) } ) },
	{ name: 'run refuses a runtime class that says ISOLATED = false', runtime: () => new ( class extends Fake { static ISOLATED = false; } )() },
	{ name: 'run refuses a runtime class that says nothing about isolation', runtime: () => new ( class { async run() { return ok( '42' ); } } )() },
], async ( { runtime } ) => {
	const _runtime = runtime();
	let _calls = 0;
	const _run = _runtime.run?.bind( _runtime );
	_runtime.run = ( ...args ) => {
		_calls++;
		return _run( ...args );
	};
	await assert.rejects( new Probes( _runtime ).run(), /not isolated \(SANDBOX_RUNTIME=docker in production\)/ );
	assert.equal( _calls, 0, 'not one probe ran on this machine' );
} );

attack( SUBJECT, 'an instance cannot make itself isolated; only its class can say so', async () => {
	const _runtime = new ProcessRuntime( { timeoutSeconds: 1 } );
	_runtime.ISOLATED = true;
	assert.equal( new Probes( _runtime ).isolated, false );
	await assert.rejects( new Probes( _runtime ).run(), /not isolated/ );
	assert.equal( new Probes( new Fake() ).isolated, true );
	assert.equal( new Probes( new DockerRuntime() ).isolated, true );
} );

attack( SUBJECT, 'a well contained sandbox stops all seven probes', async () => {
	const _done = await new Probes( new Fake() ).run();
	assert.deepEqual( [ _done.stopped, _done.of ], [ 7, 7 ] );
	assert.deepEqual( _done.results.map( item => item.probe ), NAMES );
	assert.ok( _done.results.every( item => item.ok === true ) );
} );

attack( SUBJECT, 'each result carries probe, ok, exit, ms and what the code said last', async () => {
	const [ , _network ] = ( await new Probes( new Fake() ).run() ).results;
	assert.deepEqual( Object.keys( _network ).sort(), [ 'exit', 'ms', 'ok', 'probe', 'saw' ] );
	assert.equal( _network.exit, 1 );
	assert.ok( Number.isFinite( _network.ms ) && _network.ms >= 0 );
	assert.match( _network.saw, /^urllib\.error\.URLError/ );
} );

attack( SUBJECT, 'each( result ) is told after every probe, in order, with the same results run returns', async () => {
	const _told = [];
	const _done = await new Probes( new Fake() ).run( { each: result => _told.push( result ) } );
	assert.equal( _told.length, 7 );
	assert.deepEqual( _told, _done.results );
} );

attack( SUBJECT, 'the probes run one after the other, never two at once, each with an empty input', async () => {
	const _runtime = new Fake();
	await new Probes( _runtime ).run();
	assert.equal( _runtime.overlap, false );
	assert.deepEqual( _runtime.calls.map( call => call.script ), Probes.LIST.map( item => item.code ) );
	assert.ok( _runtime.calls.every( call => JSON.stringify( call.input ) === '{}' && call.dataDir === undefined && call.node === undefined ) );
} );

// The brief decides that a failing first probe makes the whole run unusable: then nothing counts as stopped.
attacks( SUBJECT, Probes.LIST.map( ( item, index ) => ( { index, name: `one escape is reported as one: ${item.name}` } ) ), async ( { index } ) => {
	const _escaped = [ ok( '41' ), ok( '' ), ok( '["LLM_API_KEY"]' ), ok( '' ), ok( '' ), ok( 'got 1 GB' ), ok( '500 processes' ) ][ index ];
	const _done = await new Probes( new Fake( with7( index, _escaped ) ) ).run();
	assert.equal( _done.stopped, index === 0 ? 0 : 6 );
	assert.deepEqual( _done.results.filter( item => !item.ok ).map( item => item.probe ), index === 0 ? NAMES : [ NAMES[ index ] ] );
} );

attack( SUBJECT, 'after a failed harmless probe no attacker code runs at all, and every later probe says it did not run', async () => {
	const _runtime = new Fake( with7( 0, NO_FILE ) );
	const _told = [];
	const _done = await new Probes( _runtime ).run( { each: result => _told.push( result ) } );
	assert.equal( _runtime.calls.length, 1 );
	assert.equal( _told.length, 7 );
	assert.ok( _done.results.slice( 1 ).every( item => !item.ok && item.exit === null && /not run/.test( item.saw ) ) );
} );

attack( SUBJECT, 'when Python never runs (no docker at all), nothing counts as stopped', async () => {
	const _done = await new Probes( new Fake( CONTAINED.map( () => NO_DOCKER ) ) ).run();
	assert.equal( _done.stopped, 0, `${_done.results.filter( item => item.ok ).map( item => item.probe ).join( ', ' )} counted as stopped` );
} );

attack( SUBJECT, 'when the harmless probe shows that Python does not run, the other probes cannot count as stopped', async () => {
	const _done = await new Probes( new Fake( with7( 0, NO_FILE ) ) ).run();
	assert.equal( _done.results[ 0 ].ok, false );
	assert.equal( _done.stopped, 0, 'a sandbox in which nothing runs proves no containment' );
} );

attack( SUBJECT, 'saw is the last line of stderr, else of stdout, at most 120 characters', async () => {
	const _long = `Error: ${'x'.repeat( 300 )}`;
	const _answers = with7( 1, fail( 1, `Traceback\n  File "main.py"\n${_long}\n` ) );
	_answers[ 2 ] = ok( 'first\nsecond\n[]\n' );
	const _done = await new Probes( new Fake( _answers ) ).run();
	assert.equal( _done.results[ 1 ].saw, _long.slice( 0, 120 ) );
	assert.equal( _done.results[ 2 ].saw, '[]' );
	assert.equal( _done.results[ 4 ].saw, '' );
} );

attacks( SUBJECT, [
	{ name: 'last() of nothing is empty', text: undefined, want: '' },
	{ name: 'last() of null is empty', text: null, want: '' },
	{ name: 'last() ignores trailing newlines and spaces', text: 'a\nb\n\n  \n', want: 'b' },
	{ name: 'last() of Windows line ends gives the last line', text: 'one\r\ntwo\r\n', want: 'two' },
	{ name: 'last() cuts a long line to 120 characters', text: 'y'.repeat( 500 ), want: 'y'.repeat( 120 ) },
], ( { text, want } ) => {
	assert.equal( Probes.last( text ), want );
} );

attack( SUBJECT, 'exit is the runtime\'s exit code, unchanged', async () => {
	const _done = await new Probes( new Fake() ).run();
	assert.deepEqual( _done.results.map( item => item.exit ), CONTAINED.map( item => item.exitCode ) );
} );

attack( SUBJECT, 'a runtime that throws ends the test with the error; no partial count is returned', async () => {
	const _told = [];
	const _answers = [ ...CONTAINED ];
	_answers[ 2 ] = new Error( 'docker daemon gone' );
	await assert.rejects( new Probes( new Fake( _answers ) ).run( { each: result => _told.push( result.probe ) } ), /docker daemon gone/ );
	assert.deepEqual( _told, NAMES.slice( 0, 2 ) );
} );

attack( SUBJECT, 'an each() that throws stops the test before the next probe runs', async () => {
	const _runtime = new Fake();
	await assert.rejects( new Probes( _runtime ).run( { each: () => { throw new Error( 'log full' ); } } ), /log full/ );
	assert.equal( _runtime.calls.length, 1 );
} );

// The brief decides that the probes have an overall deadline: a runtime that never answers cannot hold the test for ever.
attack( SUBJECT, 'a runtime that never answers ends the test at its overall deadline, with an error and no partial count', async () => {
	const _never = { constructor: Fake, run: () => new Promise( () => {} ) };
	assert.ok( new Probes( _never ).deadlineMs >= 60000, 'the default deadline leaves room for seven contained runs' );
	await assert.rejects( within( new Probes( _never, { deadlineMs: 50 } ).run(), 2000, 'the probes' ), /did not end within/ );
} );

attack( SUBJECT, 'the deadline covers the whole test, not each probe: slow probes add up', async () => {
	class Slow extends Fake {
		async run( args ) {
			await new Promise( resolve => setTimeout( resolve, 30 ) );
			return super.run( args );
		}
	}
	const _runtime = new Slow();
	await assert.rejects( within( new Probes( _runtime, { deadlineMs: 100 } ).run(), 2000, 'the probes' ), /did not end within/ );
	assert.ok( _runtime.calls.length < 7 );
} );

attack( SUBJECT, 'over DockerRuntime every probe becomes main.py of a contained docker run', async () => {
	const _real = Runtime.spawn;
	const _seen = [];
	Runtime.spawn = async ( command, args ) => {
		if ( args[ 0 ] !== 'run' ) { return ok(); }
		const _source = /src=([^,]+)/.exec( args[ args.indexOf( '--mount' ) + 1 ] )[ 1 ];
		_seen.push( { args, code: fs.readFileSync( `${_source}/main.py`, 'utf8' ) } );
		return CONTAINED[ _seen.length - 1 ];
	};
	try {
		const _done = await new Probes( new DockerRuntime( { timeoutSeconds: 5 } ) ).run();
		assert.deepEqual( [ _done.stopped, _done.of ], [ 7, 7 ] );
		assert.deepEqual( _seen.map( item => item.code ), Probes.LIST.map( item => item.code ) );
		assert.ok( _seen.every( item => item.args.includes( 'none' ) && item.args.includes( '--read-only' ) && item.args.includes( '64' ) ) );
		assert.ok( _seen.every( item => item.args.slice( -7 ).join( ' ' ) === 'timeout -k 2 5 python -I /work/main.py' ) );
	} finally {
		Runtime.spawn = _real;
	}
} );

attack( SUBJECT, 'over the real ProcessRuntime not one Python process starts', async () => {
	const _events = [];
	const _runtime = new ProcessRuntime( { timeoutSeconds: 1, log: { append: kind => _events.push( kind ) } } );
	await assert.rejects( new Probes( _runtime ).run(), /not isolated/ );
	assert.deepEqual( _events, [] );
} );

attack( SUBJECT, 'extra fields a runtime returns do not change a verdict', async () => {
	const _answers = CONTAINED.map( item => ( { ...item, ok: false, stopped: false, escaped: true } ) );
	const _done = await new Probes( new Fake( _answers ) ).run();
	assert.equal( _done.stopped, 7 );
} );
