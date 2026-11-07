// Stress tests of core/sandbox/runtime.js: the base of every sandbox. run() gives each script a fresh work folder
// with main.py, logs started/finished/destroyed and removes the folder afterwards (7.1: destroyed after each run);
// stop( node ) ends what still runs for a node (16.5, A3); Runtime.spawn is the one place a process is started.
// The subclasses here have a fake _exec, so nothing runs; Runtime.spawn runs only harmless commands (cat, python3 -c).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { use, ROOT } from '../../helper.mjs';
import { attack, attacks, hostile, within } from '../hostile.mjs';

const SUBJECT = 'core/sandbox/runtime.js';
const [ Runtime ] = await use( 'Core.Sandbox.Runtime' );
// This file's work folders go into a temp dir of its own, so counting and removing them never touches another process's.
const PRIVATE = fs.mkdtempSync( path.join( os.tmpdir(), 'stress-sandbox-runtime-' ) );
process.env.TMPDIR = PRIVATE;
process.on( 'exit', () => fs.rmSync( PRIVATE, { recursive: true, force: true } ) );
const leftovers = () => fs.readdirSync( PRIVATE ).filter( name => name.startsWith( 'sandbox-' ) );
const PATH_ONLY = { PATH: process.env.PATH };

// A log that keeps what it was told.
function recorder() {
	const _events = [];
	return { events: _events, append: ( kind, data, options = {} ) => _events.push( { kind, data, node: options.node ?? null } ) };
}

// A runtime whose _exec only records what it was given and what the work folder held at that moment.
class Fake extends Runtime {

	static NAME = 'fake';
	static ISOLATED = true;

	constructor( options = {}, behave = () => ( { exitCode: 0, stdout: '', stderr: '' } ) ) {
		super( options );
		this.behave = behave;
		this.calls = [];
	}

	async _exec( args ) {
		const _file = path.join( args.work, 'main.py' );
		this.calls.push( { ...args, script: fs.existsSync( _file ) ? fs.readFileSync( _file, 'utf8' ) : null, existed: fs.existsSync( args.work ) } );
		return this.behave( args );
	}

}

const spawn = ( command, args, options = {} ) => Runtime.spawn( command, args, { input: '', env: PATH_ONLY, timeoutSeconds: 5, ...options } );

// ── run(): the work folder ───────────────────────────────────────────────────────────────────────────────────────

attack( SUBJECT, 'run writes the script as main.py into a fresh folder below the temp dir before _exec starts', async () => {
	const _rt = new Fake();
	await _rt.run( { script: 'print(1)\n' } );
	const [ _call ] = _rt.calls;
	assert.equal( _call.script, 'print(1)\n' );
	assert.equal( path.dirname( _call.work ), os.tmpdir() );
	assert.match( path.basename( _call.work ), /^sandbox-[A-Za-z0-9]{6}$/ );
} );

attack( SUBJECT, 'the work folder is removed after a run that succeeded', async () => {
	const _rt = new Fake();
	await _rt.run( { script: 'x' } );
	assert.equal( _rt.calls[ 0 ].existed, true );
	assert.equal( fs.existsSync( _rt.calls[ 0 ].work ), false );
} );

attack( SUBJECT, 'the work folder is removed even when _exec throws, and the error reaches the caller', async () => {
	const _rt = new Fake( {}, () => { throw new Error( 'engine broke' ); } );
	await assert.rejects( _rt.run( { script: 'x' } ), /engine broke/ );
	assert.equal( fs.existsSync( _rt.calls[ 0 ].work ), false );
} );

attack( SUBJECT, 'the work folder is removed when _exec rejects asynchronously', async () => {
	const _rt = new Fake( {}, async () => {
		await new Promise( resolve => setTimeout( resolve, 2 ) );
		throw new Error( 'late failure' );
	} );
	await assert.rejects( _rt.run( { script: 'x' } ), /late failure/ );
	assert.equal( fs.existsSync( _rt.calls[ 0 ].work ), false );
} );

attack( SUBJECT, 'files the script left in its folder are destroyed with it', async () => {
	const _rt = new Fake( {}, ( { work } ) => {
		fs.mkdirSync( path.join( work, 'nested', 'deep' ), { recursive: true } );
		fs.writeFileSync( path.join( work, 'nested', 'deep', 'left.txt' ), 'x' );
		return { exitCode: 0, stdout: '', stderr: '' };
	} );
	await _rt.run( { script: 'x' } );
	assert.equal( fs.existsSync( _rt.calls[ 0 ].work ), false );
} );

attack( SUBJECT, 'every run gets its own folder, also when many run at once', async () => {
	const _rt = new Fake( {}, async () => {
		await new Promise( resolve => setTimeout( resolve, 3 ) );
		return { exitCode: 0, stdout: '', stderr: '' };
	} );
	await Promise.all( Array.from( { length: 20 }, ( _x, i ) => _rt.run( { script: `print(${i})` } ) ) );
	const _dirs = new Set( _rt.calls.map( call => call.work ) );
	assert.equal( _dirs.size, 20 );
	assert.deepEqual( new Set( _rt.calls.map( call => call.script ) ).size, 20, 'no run saw the script of another' );
	assert.ok( _rt.calls.every( call => !fs.existsSync( call.work ) ) );
} );

attack( SUBJECT, 'a script that cannot be written (undefined) leaves no work folder behind', async () => {
	const _before = new Set( leftovers() );
	const _rt = new Fake();
	await assert.rejects( _rt.run( { script: undefined } ) );
	const _after = leftovers().filter( name => !_before.has( name ) );
	_after.forEach( name => fs.rmSync( path.join( PRIVATE, name ), { recursive: true, force: true } ) );
	assert.deepEqual( _after, [], '7.1: the sandbox folder is destroyed after each run, also a run that could not start' );
	assert.equal( _rt.calls.length, 0 );
} );

attacks( SUBJECT, hostile( 'strings' ).filter( item => item.value.length > 0 ).slice( 0, 14 ).map( item => ( { ...item, name: `main.py holds the script byte for byte: ${item.label}` } ) ),
	async ( { value } ) => {
		const _rt = new Fake();
		await _rt.run( { script: value } );
		assert.equal( _rt.calls[ 0 ].script, value );
	} );

attack( SUBJECT, 'a script given as a Buffer is written unchanged', async () => {
	const _rt = new Fake();
	await _rt.run( { script: Buffer.from( 'print("ä")\n', 'utf8' ) } );
	assert.equal( _rt.calls[ 0 ].script, 'print("ä")\n' );
} );

// ── run(): what _exec gets ───────────────────────────────────────────────────────────────────────────────────────

attack( SUBJECT, 'the input reaches _exec as JSON; without an input it is an empty object', async () => {
	const _rt = new Fake();
	await _rt.run( { script: 'x', input: { teams: [ 'design' ], n: 5, nested: { a: [ null ] } } } );
	await _rt.run( { script: 'x' } );
	assert.equal( _rt.calls[ 0 ].input, '{"teams":["design"],"n":5,"nested":{"a":[null]}}' );
	assert.equal( _rt.calls[ 1 ].input, '{}' );
} );

attack( SUBJECT, 'an input that cannot be turned into JSON fails before anything runs, and leaves no folder', async () => {
	const _before = new Set( leftovers() );
	const _rt = new Fake();
	const _loop = {};
	_loop.self = _loop;
	await assert.rejects( _rt.run( { script: 'x', input: _loop } ), /circular/i );
	assert.equal( _rt.calls.length, 0 );
	assert.deepEqual( leftovers().filter( name => !_before.has( name ) ), [] );
} );

attack( SUBJECT, 'an input with a BigInt fails before anything runs, and the folder is removed', async () => {
	const _before = new Set( leftovers() );
	const _rt = new Fake();
	await assert.rejects( _rt.run( { script: 'x', input: { amount: 10n } } ), /BigInt/ );
	assert.equal( _rt.calls.length, 0 );
	assert.deepEqual( leftovers().filter( name => !_before.has( name ) ), [] );
} );

attack( SUBJECT, 'dataDir is passed through; without one it is null', async () => {
	const _rt = new Fake();
	await _rt.run( { script: 'x', dataDir: '/srv/vault/survey-1' } );
	await _rt.run( { script: 'x' } );
	assert.equal( _rt.calls[ 0 ].dataDir, '/srv/vault/survey-1' );
	assert.equal( _rt.calls[ 1 ].dataDir, null );
} );

attack( SUBJECT, 'the result of _exec is returned as it is', async () => {
	const _result = { exitCode: 3, stdout: 'out', stderr: 'err', extra: true };
	const _rt = new Fake( {}, () => _result );
	assert.equal( await _rt.run( { script: 'x' } ), _result );
} );

attack( SUBJECT, 'the base class refuses to run anything itself', async () => {
	const _rt = new Runtime();
	await assert.rejects( _rt.run( { script: 'x' } ), /must be implemented/ );
	assert.throws( () => _rt._exec(), /must be implemented/ );
} );

attack( SUBJECT, 'the base runtime calls itself neither named nor isolated, and has a time limit of 10 s by default', () => {
	assert.equal( Runtime.NAME, 'none' );
	assert.equal( Runtime.ISOLATED, false );
	assert.equal( new Runtime().timeoutSeconds, 10 );
	assert.equal( new Runtime( { timeoutSeconds: 3 } ).timeoutSeconds, 3 );
	assert.equal( new Runtime().log, null );
} );

// ── run(): the log ───────────────────────────────────────────────────────────────────────────────────────────────

attack( SUBJECT, 'a run logs started, finished and destroyed, in this order, for its node', async () => {
	const _log = recorder();
	const _rt = new Fake( { log: _log }, () => ( { exitCode: 7, stdout: '', stderr: '' } ) );
	await _rt.run( { script: 'x', node: 'node-1' } );
	assert.deepEqual( _log.events.map( event => event.kind ), [ 'sandbox_started', 'sandbox_finished', 'sandbox_destroyed' ] );
	assert.ok( _log.events.every( event => event.node === 'node-1' ) );
	assert.deepEqual( _log.events[ 0 ].data, { runtime: 'fake', isolated: true } );
	assert.equal( _log.events[ 1 ].data.exitCode, 7 );
	assert.equal( _log.events[ 1 ].data.runtime, 'fake' );
	assert.ok( Number.isFinite( _log.events[ 1 ].data.ms ) && _log.events[ 1 ].data.ms >= 0 );
	assert.deepEqual( _log.events[ 2 ].data, { runtime: 'fake' } );
} );

attack( SUBJECT, 'a run that throws logs started and destroyed, never finished', async () => {
	const _log = recorder();
	const _rt = new Fake( { log: _log }, () => { throw new Error( 'no engine' ); } );
	await assert.rejects( _rt.run( { script: 'x' } ) );
	assert.deepEqual( _log.events.map( event => event.kind ), [ 'sandbox_started', 'sandbox_destroyed' ] );
} );

attack( SUBJECT, 'the log says what kind of runtime ran, from the class, not from the instance', async () => {
	const _log = recorder();
	class Plain extends Fake {

		static NAME = 'plain';
		static ISOLATED = false;

	}
	const _plain = new Plain( { log: _log } );
	_plain.ISOLATED = true;
	await _plain.run( { script: 'x' } );
	assert.deepEqual( _log.events[ 0 ].data, { runtime: 'plain', isolated: false }, 'an instance cannot claim isolation in the log' );
	assert.equal( _plain.constructor.ISOLATED, false );
} );

attack( SUBJECT, 'a run without a log works and logs nothing anywhere', async () => {
	const _rt = new Fake();
	const _result = await _rt.run( { script: 'x', node: 'n' } );
	assert.equal( _result.exitCode, 0 );
} );

// ── tracking and stop( node ) ────────────────────────────────────────────────────────────────────────────────────

attack( SUBJECT, 'stop( node ) calls every stop function registered for that node once and forgets the node', () => {
	const _rt = new Runtime();
	const _calls = [];
	_rt._track( 'n1', () => _calls.push( 'a' ) );
	_rt._track( 'n1', () => _calls.push( 'b' ) );
	_rt._track( 'n2', () => _calls.push( 'other' ) );
	_rt.stop( 'n1' );
	assert.deepEqual( _calls, [ 'a', 'b' ] );
	assert.equal( _rt._running.has( 'n1' ), false );
	_rt.stop( 'n1' );
	assert.deepEqual( _calls, [ 'a', 'b' ], 'a second stop has nothing left to end' );
	assert.equal( _rt._running.get( 'n2' ).size, 1 );
} );

attack( SUBJECT, 'stop for a node that never ran, or for no node, is harmless', () => {
	const _rt = new Runtime();
	assert.doesNotThrow( () => _rt.stop( 'nobody' ) );
	assert.doesNotThrow( () => _rt.stop( null ) );
	assert.doesNotThrow( () => _rt.stop( undefined ) );
	assert.equal( _rt._running.size, 0 );
} );

attack( SUBJECT, 'without a node nothing is tracked, and untracking is a no-op', () => {
	const _rt = new Runtime();
	const _untrack = _rt._track( null, () => { throw new Error( 'must not run' ); } );
	assert.equal( typeof _untrack, 'function' );
	_untrack();
	assert.equal( _rt._running.size, 0 );
} );

attack( SUBJECT, 'untrack removes exactly the one stop function it was given', () => {
	const _rt = new Runtime();
	const _calls = [];
	const _untrack = _rt._track( 'n', () => _calls.push( 'gone' ) );
	_rt._track( 'n', () => _calls.push( 'kept' ) );
	_untrack();
	_rt.stop( 'n' );
	assert.deepEqual( _calls, [ 'kept' ] );
} );

attack( SUBJECT, 'run hands _exec a track function bound to its node; stop( node ) reaches what _exec registered', async () => {
	let _stopped = 0;
	let _release;
	const _rt = new Fake( {}, ( { track } ) => new Promise( ( resolve ) => {
		_release = resolve;
		track( () => {
			_stopped++;
			resolve( { exitCode: -1, stdout: '', stderr: 'stopped' } );
		} );
	} ) );
	const _run = _rt.run( { script: 'x', node: 'n-7' } );
	await new Promise( resolve => setImmediate( resolve ) );
	_rt.stop( 'other-node' );
	assert.equal( _stopped, 0 );
	_rt.stop( 'n-7' );
	const _result = await within( _run, 1000 );
	assert.equal( _stopped, 1 );
	assert.equal( _result.exitCode, -1 );
	_release();
} );

attack( SUBJECT, 'two runs of the same node are both ended by one stop', async () => {
	let _stopped = 0;
	const _rt = new Fake( {}, ( { track } ) => new Promise( ( resolve ) => {
		track( () => {
			_stopped++;
			resolve( { exitCode: -1, stdout: '', stderr: '' } );
		} );
	} ) );
	const _runs = [ _rt.run( { script: 'a', node: 'n' } ), _rt.run( { script: 'b', node: 'n' } ) ];
	await new Promise( resolve => setImmediate( resolve ) );
	_rt.stop( 'n' );
	await within( Promise.all( _runs ), 1000 );
	assert.equal( _stopped, 2 );
	assert.ok( _rt.calls.every( call => !fs.existsSync( call.work ) ) );
} );

// ── Runtime.spawn: harmless processes ────────────────────────────────────────────────────────────────────────────

attack( SUBJECT, 'spawn hands the input to stdin and returns stdout, an empty stderr and exit code 0', async () => {
	const _result = await spawn( 'cat', [], { input: 'hello sandbox\n' } );
	assert.deepEqual( _result, { exitCode: 0, stdout: 'hello sandbox\n', stderr: '' } );
} );

attack( SUBJECT, 'spawn reports the exit code a process chose', async () => {
	const _result = await spawn( 'python3', [ '-c', 'import sys; sys.exit(42)' ] );
	assert.equal( _result.exitCode, 42 );
} );

attack( SUBJECT, 'a process ended by a signal comes back with exit code -1', async () => {
	const _result = await spawn( 'python3', [ '-c', 'import os, signal; os.kill(os.getpid(), signal.SIGKILL)' ] );
	assert.equal( _result.exitCode, -1 );
} );

attack( SUBJECT, 'a command that does not exist comes back as exit code -1 with the reason, never as a throw', async () => {
	const _result = await within( spawn( 'no-such-sandbox-command-4711', [] ), 2000 );
	assert.equal( _result.exitCode, -1 );
	assert.equal( _result.stdout, '' );
	assert.match( _result.stderr, /ENOENT/ );
} );

attack( SUBJECT, 'stdout and stderr are kept apart', async () => {
	const _result = await spawn( 'python3', [ '-c', 'import sys; print("out"); print("err", file=sys.stderr)' ] );
	assert.equal( _result.stdout, 'out\n' );
	assert.equal( _result.stderr, 'err\n' );
} );

attack( SUBJECT, 'stderr is cut to its last 2000 characters', async () => {
	const _result = await spawn( 'python3', [ '-c', 'import sys; sys.stderr.write("A" * 5000 + "TAIL")' ] );
	assert.equal( _result.stderr.length, 2000 );
	assert.ok( _result.stderr.endsWith( 'TAIL' ) );
} );

attack( SUBJECT, 'multi-byte UTF-8 split across many chunks comes back whole', async () => {
	const _result = await spawn( 'python3', [ '-c', 'import sys; sys.stdout.write("äöü😀" * 50000)' ] );
	assert.equal( _result.stdout, 'äöü😀'.repeat( 50000 ) );
} );

attack( SUBJECT, 'the child sees exactly the environment it is given, nothing of the core\'s', async () => {
	process.env.SANDBOX_STRESS_SECRET = 'sk-not-for-the-sandbox';
	try {
		const _result = await spawn( 'python3', [ '-c', 'import os, json; print(json.dumps(sorted(os.environ)))' ], { env: { PATH: process.env.PATH, ONLY: '1' } } );
		const _names = JSON.parse( _result.stdout ).filter( name => name !== 'LC_CTYPE' );
		assert.deepEqual( _names, [ 'ONLY', 'PATH' ] );
	} finally {
		delete process.env.SANDBOX_STRESS_SECRET;
	}
} );

attack( SUBJECT, 'a large input reaches a child that reads it', async () => {
	const _input = 'x'.repeat( 3 * 1024 * 1024 );
	const _result = await spawn( 'python3', [ '-c', 'import sys; print(len(sys.stdin.read()))' ], { input: _input } );
	assert.equal( _result.stdout.trim(), String( _input.length ) );
} );

attack( SUBJECT, 'a process that outlives timeoutSeconds + 5 s is killed by spawn\'s own timer', async () => {
	// timeoutSeconds -4.9 puts the timer at 100 ms; the child would sleep 30 s.
	const _started = Date.now();
	const _result = await within( spawn( 'python3', [ '-c', 'import time; time.sleep(30)' ], { timeoutSeconds: -4.9 } ), 3000 );
	assert.equal( _result.exitCode, -1 );
	assert.ok( Date.now() - _started < 2500 );
} );

attack( SUBJECT, 'spawn registers a stop function with track; calling it kills the process, and it is untracked on close', async () => {
	const _stops = [];
	let _untracked = 0;
	const _track = ( stop ) => {
		_stops.push( stop );
		return () => { _untracked++; };
	};
	const _run = spawn( 'python3', [ '-c', 'import time; time.sleep(30)' ], { track: _track } );
	assert.equal( _stops.length, 1 );
	_stops[ 0 ]();
	const _result = await within( _run, 2000 );
	assert.equal( _result.exitCode, -1 );
	assert.equal( _untracked, 1 );
} );

attack( SUBJECT, 'a finished process is untracked too, so a later stop cannot hit a reused PID', async () => {
	let _untracked = 0;
	await spawn( 'cat', [], { input: 'x', track: () => () => { _untracked++; } } );
	assert.equal( _untracked, 1 );
} );

attack( SUBJECT, 'spawn waits for the process to end, not only for its output to close', async () => {
	const _result = await within( spawn( 'python3', [ '-c', 'import os, time; os.close(1); time.sleep(0.2); os._exit(5)' ] ), 3000 );
	assert.equal( _result.exitCode, 5 );
} );

attack( SUBJECT, 'twenty processes at once each get their own input and output', async () => {
	const _results = await Promise.all( Array.from( { length: 20 }, ( _x, i ) => spawn( 'cat', [], { input: `run-${i}` } ) ) );
	assert.deepEqual( _results.map( item => item.stdout ), Array.from( { length: 20 }, ( _x, i ) => `run-${i}` ) );
} );

attack( SUBJECT, 'an empty or missing input closes stdin, so a reader does not hang', async () => {
	const _empty = await within( spawn( 'cat', [], { input: '' } ), 2000 );
	const _missing = await within( Runtime.spawn( 'cat', [], { env: PATH_ONLY, timeoutSeconds: 5 } ), 2000 );
	assert.deepEqual( [ _empty.stdout, _missing.stdout ], [ '', '' ] );
} );

attack( SUBJECT, 'arguments reach the child as single argv entries, never through a shell', async () => {
	const _args = [ '$(id)', '`id`', 'a b', '; rm -rf /', '\'"' ];
	const _result = await spawn( 'python3', [ '-c', 'import sys, json; print(json.dumps(sys.argv[1:]))', ..._args ] );
	assert.deepEqual( JSON.parse( _result.stdout ), _args );
} );

// The brief decides that output beyond the limit fails the run (the process is stopped), so the exit code is not 0.
attack( SUBJECT, 'output a script floods is bounded before it reaches the core, and the run fails (7.1 limits)', async () => {
	const _result = await spawn( 'python3', [ '-c', 'import sys; sys.stdout.write("x" * (48 * 1024 * 1024))' ], { timeoutSeconds: 20 } );
	assert.notEqual( _result.exitCode, 0, 'a run whose output was cut is no result' );
	assert.match( _result.stderr, /output exceeded/ );
	assert.ok( _result.stdout.length < 48 * 1024 * 1024, `the core buffered all ${_result.stdout.length} characters of the sandbox's output` );
}, { timeout: 20000 } );

attack( SUBJECT, 'a child that exits without reading a large input does not crash the core (EPIPE on stdin)', () => {
	const _code = [
		`import { boot } from ${JSON.stringify( path.join( ROOT, 'lib/node.mjs' ) )};`,
		'const app = boot( { overrides: \'\' } );',
		'const [ Runtime ] = await app.use( [ \'Core.Sandbox.Runtime\' ] );',
		'const r = await Runtime.spawn( \'python3\', [ \'-c\', \'pass\' ], { input: \'x\'.repeat( 4 << 20 ), env: { PATH: process.env.PATH }, timeoutSeconds: 5 } );',
		'console.log( JSON.stringify( r ) );',
	].join( '\n' );
	const _child = spawnSync( process.execPath, [ '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', _code ], {
		encoding: 'utf8', timeout: 15000, env: PATH_ONLY,
	} );
	assert.equal( _child.status, 0, `the core process died: ${_child.stderr.split( '\n' ).find( line => /EPIPE|Error/.test( line ) ) || _child.stderr.slice( 0, 200 )}` );
	assert.equal( JSON.parse( _child.stdout.trim() ).exitCode, 0 );
} );
