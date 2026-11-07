// Stress tests of core/sandbox/processruntime.js: the development runtime. It runs the script as a local python3 under
// `timeout`, with an environment of three variables and no secret. It is NOT isolated, so only harmless scripts run
// here: no containment probes, no fork or memory bombs, no writes outside a temp dir. Processes this file starts are
// killed by their PID only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { use, ROOT } from '../../helper.mjs';
import { attack, attacks, hostile, within } from '../hostile.mjs';

const SUBJECT = 'core/sandbox/processruntime.js';
const [ ProcessRuntime, Runtime ] = await use( 'Core.Sandbox.ProcessRuntime', 'Core.Sandbox.Runtime' );
const PRIVATE = fs.mkdtempSync( path.join( os.tmpdir(), 'stress-sandbox-process-' ) );
process.on( 'exit', () => fs.rmSync( PRIVATE, { recursive: true, force: true } ) );

const runtime = ( options = {} ) => new ProcessRuntime( { timeoutSeconds: 5, ...options } );
const run = ( script, options = {}, runtimeOptions = {} ) => runtime( runtimeOptions ).run( { script, input: {}, ...options } );
const json = result => JSON.parse( result.stdout );

function recorder() {
	const _events = [];
	return { events: _events, append: ( kind, data, options = {} ) => _events.push( { kind, data, node: options.node ?? null } ) };
}

// Runs fn with Runtime.spawn replaced by a recorder; the real one is back afterwards.
async function intercepted( fn ) {
	const _real = Runtime.spawn;
	const _calls = [];
	Runtime.spawn = async ( command, args, options ) => {
		_calls.push( { command, args, options, script: fs.readFileSync( args.at( -1 ), 'utf8' ) } );
		return { exitCode: 0, stdout: '{}', stderr: '' };
	};
	try {
		await fn( _calls );
	} finally {
		Runtime.spawn = _real;
	}
	return _calls;
}

// A sleeping script that writes its PID first, so the test can see whether it still runs and end it itself.
function sleeper( seconds, extra = '' ) {
	const _file = path.join( fs.mkdtempSync( path.join( PRIVATE, 'pid-' ) ), 'pid' );
	const _script = `import os, time\n${extra}open(${JSON.stringify( _file )}, "w").write(str(os.getpid()))\ntime.sleep(${seconds})\n`;
	return { script: _script, file: _file };
}

async function pidOf( file, ms = 3000 ) {
	for ( const end = Date.now() + ms; Date.now() < end; ) {
		const _text = fs.existsSync( file ) ? fs.readFileSync( file, 'utf8' ) : '';
		if ( _text ) { return Number( _text ); }
		await new Promise( resolve => setTimeout( resolve, 5 ) );
	}
	throw new Error( 'the script never wrote its PID' );
}

function alive( pid ) {
	try {
		return !/\) Z /.test( fs.readFileSync( `/proc/${pid}/stat`, 'utf8' ) );
	} catch {
		return false;
	}
}

// After a KILL the kernel tears the process down on its own time: on a loaded machine it can take a moment.
async function gone( pid, ms = 1000 ) {
	for ( const end = Date.now() + ms; alive( pid ) && Date.now() < end; ) {
		await new Promise( resolve => setTimeout( resolve, 20 ) );
	}
	return !alive( pid );
}

// Kills a PID only when it is still the python3 this file started (its cmdline names a sandbox main.py).
function endPid( pid ) {
	try {
		const _cmd = fs.readFileSync( `/proc/${pid}/cmdline`, 'utf8' );
		if ( _cmd.includes( 'python3' ) && _cmd.includes( 'main.py' ) ) { process.kill( pid, 'SIGKILL' ); }
	} catch {
		// already gone
	}
}

// ── the command and its environment ──────────────────────────────────────────────────────────────────────────────

// The brief decides -B for no bytecode (-I ignores PYTHONDONTWRITEBYTECODE), so the command has one argument more.
attack( SUBJECT, 'the command is timeout -k 2 <limit> python3 -I -B <work>/main.py, nothing else', async () => {
	const [ _call ] = await intercepted( () => runtime( { timeoutSeconds: 7 } ).run( { script: 'print(1)' } ) );
	assert.equal( _call.command, 'timeout' );
	assert.deepEqual( _call.args.slice( 0, 7 ), [ '-k', '2', '7', 'python3', '-I', '-B', _call.args[ 6 ] ] );
	assert.equal( _call.args.length, 7 );
	assert.equal( path.basename( _call.args[ 6 ] ), 'main.py' );
	assert.equal( _call.script, 'print(1)' );
} );

attack( SUBJECT, 'the environment is exactly PATH, AGENCY_DATA and PYTHONDONTWRITEBYTECODE', async () => {
	const [ _call ] = await intercepted( () => runtime().run( { script: 'x', dataDir: '/srv/vault/x' } ) );
	assert.deepEqual( Object.keys( _call.options.env ).sort(), [ 'AGENCY_DATA', 'PATH', 'PYTHONDONTWRITEBYTECODE' ] );
	assert.equal( _call.options.env.PATH, process.env.PATH );
	assert.equal( _call.options.env.AGENCY_DATA, '/srv/vault/x' );
	assert.equal( _call.options.env.PYTHONDONTWRITEBYTECODE, '1' );
} );

attack( SUBJECT, 'no secret of the core reaches the command\'s environment', async () => {
	const _secrets = { LLM_API_KEY: 'sk-live-1', MEMORY_KEY: 'mem-2', GATE_PIN: '4711', AWS_SECRET_ACCESS_KEY: 'aws-3' };
	Object.assign( process.env, _secrets );
	try {
		const [ _call ] = await intercepted( () => runtime().run( { script: 'x' } ) );
		const _seen = JSON.stringify( _call );
		assert.ok( Object.values( _secrets ).every( value => !_seen.includes( value ) ) );
	} finally {
		Object.keys( _secrets ).forEach( key => delete process.env[ key ] );
	}
} );

attack( SUBJECT, 'without a data dir AGENCY_DATA is empty, not undefined or the core\'s folder', async () => {
	const [ _call ] = await intercepted( () => runtime().run( { script: 'x' } ) );
	assert.equal( _call.options.env.AGENCY_DATA, '' );
} );

attack( SUBJECT, 'the time limit and a track function go to spawn; the input goes as JSON', async () => {
	const [ _call ] = await intercepted( () => runtime( { timeoutSeconds: 3 } ).run( { script: 'x', input: { a: [ 1, 'b' ] }, node: 'n' } ) );
	assert.equal( _call.options.timeoutSeconds, 3 );
	assert.equal( typeof _call.options.track, 'function' );
	assert.equal( _call.options.input, '{"a":[1,"b"]}' );
} );

attack( SUBJECT, 'a time limit of 0 does not switch the limit off (GNU timeout treats 0 as no limit)', async () => {
	const [ _call ] = await intercepted( () => runtime( { timeoutSeconds: 0 } ).run( { script: 'x' } ) );
	assert.ok( Number( _call.args[ 2 ] ) > 0, `timeout got the duration ${_call.args[ 2 ]}` );
} );

attack( SUBJECT, 'the development runtime calls itself process and not isolated', () => {
	assert.equal( ProcessRuntime.NAME, 'process' );
	assert.equal( ProcessRuntime.ISOLATED, false );
	assert.ok( new ProcessRuntime() instanceof Runtime );
} );

// ── what the script sees ─────────────────────────────────────────────────────────────────────────────────────────

attack( SUBJECT, 'a script runs, gets its input on stdin and returns what it printed', async () => {
	const _result = await run( 'import json, sys\nprint(json.dumps({"got": json.load(sys.stdin)}))', { input: { teams: [ 'design' ], k: 5 } } );
	assert.equal( _result.exitCode, 0 );
	assert.deepEqual( json( _result ), { got: { teams: [ 'design' ], k: 5 } } );
	assert.equal( _result.stderr, '' );
} );

attack( SUBJECT, 'the script\'s environment holds no more than the three variables (and Python\'s own locale)', async () => {
	const _names = json( await run( 'import os, json\nprint(json.dumps(sorted(os.environ)))' ) ).filter( name => name !== 'LC_CTYPE' );
	assert.deepEqual( _names, [ 'AGENCY_DATA', 'PATH', 'PYTHONDONTWRITEBYTECODE' ] );
} );

attack( SUBJECT, 'a key in the core\'s environment is invisible to the script', async () => {
	process.env.LLM_API_KEY = 'sk-must-not-leak';
	try {
		const _result = await run( 'import os\nprint(os.environ.get("LLM_API_KEY", "none"))' );
		assert.equal( _result.stdout.trim(), 'none' );
	} finally {
		delete process.env.LLM_API_KEY;
	}
} );

attack( SUBJECT, 'Python runs isolated: no user site, environment ignored, PYTHONPATH of the core has no effect', async () => {
	process.env.PYTHONPATH = PRIVATE;
	process.env.PYTHONSTARTUP = path.join( PRIVATE, 'startup.py' );
	try {
		const _flags = json( await run( 'import sys, json\nprint(json.dumps([sys.flags.isolated, sys.flags.no_user_site, sys.flags.ignore_environment, sys.path]))' ) );
		assert.deepEqual( _flags.slice( 0, 3 ), [ 1, 1, 1 ] );
		assert.ok( !_flags[ 3 ].includes( PRIVATE ) );
	} finally {
		delete process.env.PYTHONPATH;
		delete process.env.PYTHONSTARTUP;
	}
} );

attack( SUBJECT, 'the script\'s own folder is not on sys.path, so a module planted next to it is never imported', async () => {
	const _result = json( await run( 'import sys, os, json\nprint(json.dumps([os.path.dirname(os.path.abspath(__file__)), sys.path]))' ) );
	assert.ok( !_result[ 1 ].includes( _result[ 0 ] ) );
} );

attack( SUBJECT, 'the script runs with bytecode writing switched off, as the runtime asks with PYTHONDONTWRITEBYTECODE', async () => {
	const _result = await run( 'import sys\nprint(sys.dont_write_bytecode)' );
	assert.equal( _result.stdout.trim(), 'True', 'imports may write __pycache__ into a user-writable Python on the host' );
} );

attack( SUBJECT, 'the script gets only its own path as argv', async () => {
	const _argv = json( await run( 'import sys, json\nprint(json.dumps(sys.argv))' ) );
	assert.equal( _argv.length, 1 );
	assert.match( _argv[ 0 ], /sandbox-[^/]+\/main\.py$/ );
} );

attack( SUBJECT, 'AGENCY_DATA names the data dir, and a file in it can be read', async () => {
	const _data = fs.mkdtempSync( path.join( PRIVATE, 'data ü,1-' ) );
	fs.writeFileSync( path.join( _data, 'answers.csv' ), 'team,n\ndesign,5\n' );
	const _result = await run( 'import os\nprint(os.environ["AGENCY_DATA"])\nprint(open(os.path.join(os.environ["AGENCY_DATA"], "answers.csv")).read().splitlines()[1])', { dataDir: _data } );
	assert.deepEqual( _result.stdout.trim().split( '\n' ), [ _data, 'design,5' ] );
} );

attack( SUBJECT, 'the work folder is private to the core\'s user while the script runs (mode 0700)', async () => {
	const _mode = await run( 'import os, stat\nprint(oct(stat.S_IMODE(os.stat(os.path.dirname(os.path.abspath(__file__))).st_mode)))' );
	assert.equal( _mode.stdout.trim(), '0o700' );
} );

attack( SUBJECT, 'the script does not start in the core\'s working directory (the repository with its .env)', async () => {
	const _cwd = ( await run( 'import os\nprint(os.getcwd())' ) ).stdout.trim();
	assert.notEqual( _cwd, process.cwd() );
	assert.ok( _cwd.startsWith( os.tmpdir() ), `the script started in ${_cwd}` );
} );

attacks( SUBJECT, hostile( 'strings' ).filter( ( _item, i ) => i % 3 === 0 ).map( item => ( { ...item, name: `the input reaches stdin unchanged: ${item.label}` } ) ),
	async ( { value } ) => {
		const _result = await run( 'import sys\nsys.stdout.write(sys.stdin.read())', { input: { value } } );
		assert.deepEqual( JSON.parse( _result.stdout ), { value } );
	} );

attack( SUBJECT, 'without an input the script reads an empty JSON object', async () => {
	const _result = await runtime().run( { script: 'import sys\nprint(sys.stdin.read())' } );
	assert.equal( _result.stdout, '{}\n' );
} );

// ── exits, errors and output ─────────────────────────────────────────────────────────────────────────────────────

attack( SUBJECT, 'a syntax error comes back as exit 1 with SyntaxError on stderr and nothing on stdout', async () => {
	const _result = await run( 'def broken(:\n    pass' );
	assert.equal( _result.exitCode, 1 );
	assert.match( _result.stderr, /SyntaxError/ );
	assert.equal( _result.stdout, '' );
} );

attack( SUBJECT, 'an exception comes back as exit 1 with the end of the traceback', async () => {
	const _result = await run( 'raise ValueError("bad value 42")' );
	assert.equal( _result.exitCode, 1 );
	assert.match( _result.stderr, /ValueError: bad value 42/ );
} );

attack( SUBJECT, 'the exit code the script chose comes back', async () => {
	assert.equal( ( await run( 'import sys\nsys.exit(3)' ) ).exitCode, 3 );
	assert.equal( ( await run( 'import os\nos._exit(9)' ) ).exitCode, 9 );
} );

attack( SUBJECT, 'a script killed by a signal comes back as -1 (timeout passes the signal on to itself)', async () => {
	const _result = await run( 'import os, signal\nos.kill(os.getpid(), signal.SIGKILL)' );
	assert.equal( _result.exitCode, -1 );
	assert.equal( _result.stdout, '' );
} );

attack( SUBJECT, 'stderr longer than 2000 characters keeps its end', async () => {
	const _result = await run( 'import sys\nsys.stderr.write("E" * 9000 + "LAST")' );
	assert.equal( _result.stderr.length, 2000 );
	assert.ok( _result.stderr.endsWith( 'LAST' ) );
} );

attack( SUBJECT, 'two megabytes of output come back exactly', async () => {
	const _result = await run( 'import sys\nsys.stdout.write("0123456789abcdef" * 131072)' );
	assert.equal( _result.stdout.length, 2 * 1024 * 1024 );
	assert.equal( _result.stdout.slice( -16 ), '0123456789abcdef' );
} );

attack( SUBJECT, 'unicode output comes back as UTF-8, whatever the locale of the empty environment', async () => {
	const _result = await run( 'import sys\nsys.stdout.buffer.write("Ünïcödé ß 😀\\n".encode("utf-8"))' );
	assert.equal( _result.stdout, 'Ünïcödé ß 😀\n' );
} );

attack( SUBJECT, 'output without a trailing newline and output only on stderr come back as they are', async () => {
	assert.equal( ( await run( 'import sys\nsys.stdout.write("42")' ) ).stdout, '42' );
	const _err = await run( 'import sys\nsys.stderr.write("only err")' );
	assert.deepEqual( [ _err.stdout, _err.stderr ], [ '', 'only err' ] );
} );

attack( SUBJECT, 'ten scripts at once each return their own result', async () => {
	const _rt = runtime();
	const _results = await Promise.all( Array.from( { length: 10 }, ( _x, i ) => _rt.run( { script: `print(${i} * 7)` } ) ) );
	assert.deepEqual( _results.map( item => item.stdout.trim() ), Array.from( { length: 10 }, ( _x, i ) => String( i * 7 ) ) );
} );

attack( SUBJECT, 'a script that ignores a small input still finishes', async () => {
	const _result = await run( 'print("done")', { input: { a: 1 } } );
	assert.deepEqual( [ _result.exitCode, _result.stdout ], [ 0, 'done\n' ] );
} );

// ── the time limit ───────────────────────────────────────────────────────────────────────────────────────────────

attack( SUBJECT, 'a script that runs past its limit is ended by timeout with 124, and its process is gone', async () => {
	const _sleep = sleeper( 20 );
	const _started = Date.now();
	const _result = await within( run( _sleep.script, {}, { timeoutSeconds: 1 } ), 4000 );
	const _pid = await pidOf( _sleep.file );
	try {
		assert.equal( _result.exitCode, 124 );
		assert.ok( Date.now() - _started < 3000 );
		assert.ok( await gone( _pid ), 'the script is gone' );
	} finally {
		endPid( _pid );
	}
} );

attack( SUBJECT, 'what a script printed before its limit ran out is kept', async () => {
	const _result = await within( run( 'import time\nprint("started", flush=True)\ntime.sleep(20)', {}, { timeoutSeconds: 1 } ), 4000 );
	assert.equal( _result.exitCode, 124 );
	assert.equal( _result.stdout, 'started\n' );
} );

attack( SUBJECT, 'a script that ignores SIGTERM is killed two seconds later (-k 2)', async () => {
	const _sleep = sleeper( 20, 'import signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\n' );
	const _started = Date.now();
	const _result = await within( run( _sleep.script, {}, { timeoutSeconds: 1 } ), 6000 );
	const _pid = await pidOf( _sleep.file );
	try {
		// The KILL goes to timeout's whole process group, timeout included: the run ends as killed by a signal.
		assert.equal( _result.exitCode, -1 );
		assert.ok( Date.now() - _started >= 2000, 'the grace period of -k 2 was kept' );
		assert.ok( await gone( _pid ), 'the script is gone' );
	} finally {
		endPid( _pid );
	}
}, { timeout: 15000 } );

// A small core in a process of its own: boots the app, runs body (which ends with a console.log of JSON) and reports.
function core( body, { survive = false } = {} ) {
	const _code = [
		`import { boot } from ${JSON.stringify( path.join( ROOT, 'lib/node.mjs' ) )};`,
		survive ? 'process.on( \'uncaughtException\', () => {} );' : '',
		'const app = boot( { overrides: \'\' } );',
		'const [ ProcessRuntime ] = await app.use( [ \'Core.Sandbox.ProcessRuntime\' ] );',
		body,
	].join( '\n' );
	return spawnSync( process.execPath, [ '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', _code ], {
		encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH },
	} );
}

attack( SUBJECT, 'a negative or non-numeric limit fails closed: nothing runs, nothing is printed', () => {
	const _child = core( [
		'const _run = t => new ProcessRuntime( { timeoutSeconds: t } ).run( { script: \'print("ran")\' } );',
		'const _all = await Promise.all( [ _run( -1 ), _run( Number( \'ten\' ) ) ] );',
		'console.log( JSON.stringify( _all.map( r => [ r.exitCode, r.stdout ] ) ) );',
	].join( '\n' ), { survive: true } );
	const [ _negative, _nan ] = JSON.parse( _child.stdout.trim().split( '\n' ).at( -1 ) );
	assert.ok( _negative[ 0 ] !== 0 && _nan[ 0 ] !== 0 );
	assert.deepEqual( [ _negative[ 1 ], _nan[ 1 ] ], [ '', '' ] );
}, { timeout: 25000 } );

attack( SUBJECT, 'a run whose process exits at once (timeout refusing its limit) never crashes the core, even with the 2-byte input {}', () => {
	const _child = core( [
		'const _rt = new ProcessRuntime( { timeoutSeconds: -1 } );',
		'for ( let i = 0; i < 40; i++ ) { await _rt.run( { script: \'print(1)\' } ); }',
		'console.log( JSON.stringify( { survived: true } ) );',
	].join( '\n' ) );
	assert.equal( _child.status, 0, `the core died: ${_child.stderr.split( '\n' ).find( line => /EPIPE/.test( line ) ) || _child.stderr.slice( 0, 200 )}` );
}, { timeout: 25000 } );

attack( SUBJECT, 'the log of a run says process, not isolated, and the exit code of a timeout', async () => {
	const _log = recorder();
	await runtime( { timeoutSeconds: 0.2, log: _log } ).run( { script: 'import time\ntime.sleep(5)', node: 'n-log' } );
	assert.deepEqual( _log.events.map( event => event.kind ), [ 'sandbox_started', 'sandbox_finished', 'sandbox_destroyed' ] );
	assert.deepEqual( _log.events[ 0 ].data, { runtime: 'process', isolated: false } );
	assert.equal( _log.events[ 1 ].data.exitCode, 124 );
	assert.ok( _log.events.every( event => event.node === 'n-log' ) );
} );

// ── the work folder ──────────────────────────────────────────────────────────────────────────────────────────────

attack( SUBJECT, 'the work folder is gone after the run, with everything the script wrote into it', async () => {
	const _result = await run( 'import os\nd = os.path.dirname(os.path.abspath(__file__))\nopen(os.path.join(d, "left.txt"), "w").write("x")\nprint(d)' );
	const _dir = _result.stdout.trim();
	assert.ok( _dir.length > 0 );
	assert.equal( fs.existsSync( _dir ), false );
} );

attack( SUBJECT, 'the work folder is gone after a script that failed', async () => {
	const _result = await run( 'import os, sys\nprint(os.path.dirname(os.path.abspath(__file__)), flush=True)\nsys.exit(2)' );
	assert.equal( _result.exitCode, 2 );
	assert.equal( fs.existsSync( _result.stdout.trim() ), false );
} );

attack( SUBJECT, 'the work folder is gone after a script that ran out of time', async () => {
	const _result = await run( 'import os, time\nprint(os.path.dirname(os.path.abspath(__file__)), flush=True)\ntime.sleep(10)', {}, { timeoutSeconds: 1 } );
	assert.equal( _result.exitCode, 124 );
	assert.equal( fs.existsSync( _result.stdout.trim() ), false );
} );

// ── stop( node ) ─────────────────────────────────────────────────────────────────────────────────────────────────

attack( SUBJECT, 'stop( node ) ends the python process of that node, not only its timeout wrapper (16.5)', async () => {
	const _rt = runtime( { timeoutSeconds: 30 } );
	const _sleep = sleeper( 20 );
	const _run = _rt.run( { script: _sleep.script, node: 'n-stop' } );
	const _pid = await pidOf( _sleep.file );
	try {
		_rt.stop( 'n-stop' );
		assert.ok( await gone( _pid ), 'the script still runs after stop, now without any time limit' );
	} finally {
		endPid( _pid );
		await within( _run, 3000 );
	}
} );

attack( SUBJECT, 'after stop( node ) the run settles at once', async () => {
	const _rt = runtime( { timeoutSeconds: 30 } );
	const _sleep = sleeper( 20 );
	const _run = _rt.run( { script: _sleep.script, node: 'n-settle' } );
	const _pid = await pidOf( _sleep.file );
	try {
		_rt.stop( 'n-settle' );
		const _result = await within( _run, 1000, 'the stopped run' );
		assert.notEqual( _result.exitCode, 0 );
	} finally {
		endPid( _pid );
		await within( _run, 3000 ).catch( () => {} );
	}
} );

attack( SUBJECT, 'stop for another node leaves a running script alone', async () => {
	const _rt = runtime();
	const _run = _rt.run( { script: 'import time\ntime.sleep(0.2)\nprint("finished")', node: 'mine' } );
	await new Promise( resolve => setTimeout( resolve, 50 ) );
	_rt.stop( 'someone-else' );
	const _result = await within( _run, 3000 );
	assert.deepEqual( [ _result.exitCode, _result.stdout ], [ 0, 'finished\n' ] );
} );

attack( SUBJECT, 'after a run ended nothing is left to stop for its node', async () => {
	const _rt = runtime();
	await _rt.run( { script: 'print(1)', node: 'n-done' } );
	assert.equal( _rt._running.get( 'n-done' )?.size ?? 0, 0 );
} );

attacks( SUBJECT, hostile( 'keys' ).slice( 0, 4 ).map( item => ( { ...item, name: `a node id like ${item.label} is tracked and released like any other` } ) ), async ( { value } ) => {
	const _rt = runtime();
	await _rt.run( { script: 'print(1)', node: value } );
	assert.equal( _rt._running.get( value )?.size ?? 0, 0 );
	assert.doesNotThrow( () => _rt.stop( value ) );
	assert.equal( Object.getPrototypeOf( _rt._running ), Map.prototype );
} );

attack( SUBJECT, 'two runtimes keep their own limits', async () => {
	const [ _short, _long ] = await Promise.all( [
		run( 'import time\ntime.sleep(0.6)\nprint("x")', {}, { timeoutSeconds: 0.2 } ),
		run( 'import time\ntime.sleep(0.6)\nprint("x")', {}, { timeoutSeconds: 5 } ),
	] );
	assert.deepEqual( [ _short.exitCode, _long.exitCode ], [ 124, 0 ] );
} );

attack( SUBJECT, 'a script that exits without reading a large input does not crash the core', () => {
	const _code = [
		`import { boot } from ${JSON.stringify( path.join( ROOT, 'lib/node.mjs' ) )};`,
		'const app = boot( { overrides: \'\' } );',
		'const [ ProcessRuntime ] = await app.use( [ \'Core.Sandbox.ProcessRuntime\' ] );',
		'const r = await new ProcessRuntime( { timeoutSeconds: 5 } ).run( { script: \'pass\', input: { rows: \'x\'.repeat( 4 << 20 ) } } );',
		'console.log( JSON.stringify( { exitCode: r.exitCode } ) );',
	].join( '\n' );
	const _child = spawnSync( process.execPath, [ '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', _code ], {
		encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH },
	} );
	assert.equal( _child.status, 0, `the core died: ${_child.stderr.split( '\n' ).find( line => /EPIPE/.test( line ) ) || _child.stderr.slice( 0, 200 )}` );
	assert.deepEqual( JSON.parse( _child.stdout.trim() ), { exitCode: 0 } );
} );
