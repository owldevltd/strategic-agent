// Stress tests of core/sandbox/dockerruntime.js: the production sandbox. No Docker runs here: Runtime.spawn is replaced
// for each test by a recorder (and put back afterwards), and the exact argv of `docker run` is checked: no network,
// read-only root, a small tmpfs, memory, CPU and process limits, no capabilities, an unprivileged user, no secret,
// read-only mounts, --rm, gVisor by SANDBOX_DOCKER_RUNTIME, a hard timeout inside the container, docker kill on a
// failure and on stop( node ) (7.1, 16.5).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { use } from '../../helper.mjs';
import { attack, attacks, hostile, within } from '../hostile.mjs';

const SUBJECT = 'core/sandbox/dockerruntime.js';
const [ DockerRuntime, Runtime, Vault ] = await use( 'Core.Sandbox.DockerRuntime', 'Core.Sandbox.Runtime', 'Core.Vault.Vault' );
const PRIVATE = fs.mkdtempSync( path.join( os.tmpdir(), 'stress-sandbox-docker-' ) );
process.on( 'exit', () => fs.rmSync( PRIVATE, { recursive: true, force: true } ) );
const NOBODY = 65534;
// The brief decides: the container runs as the core's own user and group (nobody only as a fallback, and for a core that
// runs as root), so the folders the core made for the run stay private (0700) on the host and are readable inside.
const OWN = process.getuid() > 0
	? { uid: process.getuid(), user: `${process.getuid()}:${process.getgid() > 0 ? process.getgid() : NOBODY}` }
	: { uid: NOBODY, user: `${NOBODY}:${NOBODY}` };

// Runs fn( runtime, calls ) with docker intercepted. answer( call ) gives the result of each spawn (default: exit 0).
// For `docker run` the call also records what the host side of each mount looked like at that moment.
async function docker( fn, { options = {}, engine = undefined, answer = () => ( { exitCode: 0, stdout: '{"ok":true}', stderr: '' } ) } = {} ) {
	const _real = Runtime.spawn;
	const _saved = process.env.SANDBOX_DOCKER_RUNTIME;
	const _calls = [];
	if ( engine === undefined ) { delete process.env.SANDBOX_DOCKER_RUNTIME; } else { process.env.SANDBOX_DOCKER_RUNTIME = engine; }
	Runtime.spawn = async ( command, args, spawnOptions ) => {
		const _call = { command, args, options: spawnOptions };
		if ( args[ 0 ] === 'run' ) { _call.mounts = mounts( args ); }
		_calls.push( _call );
		return answer( _call );
	};
	try {
		return await fn( new DockerRuntime( { timeoutSeconds: 10, ...options } ), _calls );
	} finally {
		Runtime.spawn = _real;
		if ( _saved === undefined ) { delete process.env.SANDBOX_DOCKER_RUNTIME; } else { process.env.SANDBOX_DOCKER_RUNTIME = _saved; }
	}
}

// The --mount specs of a docker argv, read the way docker reads them (one CSV line of key=value fields), with the host
// side as it is on disk right now. parts: source, target and mode ("ro" or "rw").
function mounts( args ) {
	return args.flatMap( ( arg, i ) => ( args[ i - 1 ] === '--mount' ? [ arg ] : [] ) ).map( ( spec ) => {
		const _fields = Object.fromEntries( csv( spec ).map( field => ( field.includes( '=' )
			? [ field.slice( 0, field.indexOf( '=' ) ), field.slice( field.indexOf( '=' ) + 1 ) ] : [ field, 'true' ] ) ) );
		const _source = _fields.src ?? _fields.source;
		const _readonly = [ _fields.readonly, _fields.ro ].some( value => value === 'true' || value === '1' );
		const _parts = [ _source, _fields.dst ?? _fields.target ?? _fields.destination, _readonly ? 'ro' : 'rw' ];
		const _stat = fs.existsSync( _source ) ? fs.statSync( _source ) : null;
		const _main = path.join( _source, 'main.py' );
		return {
			spec, fields: _fields, parts: _parts, source: _source, stat: _stat,
			main: fs.existsSync( _main ) ? { text: fs.readFileSync( _main, 'utf8' ), stat: fs.statSync( _main ) } : null,
		};
	} );
}

// One CSV line as Go's encoding/csv reads it (docker's --mount): a field in double quotes may hold commas, "" is a quote.
function csv( line ) {
	const _fields = [ '' ];
	let _quoted = false;
	for ( let i = 0; i < line.length; i++ ) {
		const _char = line[ i ];
		if ( _quoted && _char === '"' && line[ i + 1 ] === '"' ) {
			_fields[ _fields.length - 1 ] += '"';
			i++;
		} else if ( _char === '"' && ( _quoted || _fields.at( -1 ) === '' ) ) {
			_quoted = !_quoted;
		} else if ( _char === ',' && !_quoted ) {
			_fields.push( '' );
		} else {
			_fields[ _fields.length - 1 ] += _char;
		}
	}
	return _fields;
}

const runs = calls => calls.filter( call => call.args[ 0 ] === 'run' );
const kills = calls => calls.filter( call => call.args[ 0 ] === 'kill' );
const nameOf = call => call.args[ call.args.indexOf( '--name' ) + 1 ];
// The image comes right before env -i, which starts the code with its own environment.
const imageAt = call => call.args.indexOf( 'env' ) - 1;
const options = call => call.args.slice( 0, imageAt( call ) );
const valuesOf = ( call, flag ) => options( call ).flatMap( ( arg, i, all ) => ( all[ i - 1 ] === flag ? [ arg ] : [] ) );
const once = ( fn, extra ) => docker( async ( runtime, calls ) => {
	const _result = await runtime.run( { script: 'print(1)', input: { a: 1 }, ...( extra?.run || {} ) } );
	return fn( runs( calls )[ 0 ], calls, _result, runtime );
}, extra );

// Can the container user enter and read this? (Its group is left out: the owner's bits, else the bits of everyone.)
function readableBy( stat, uid, need ) {
	const _bits = stat.uid === uid ? ( stat.mode >> 6 ) & 7 : stat.mode & 7;
	return ( _bits & need ) === need;
}

// The brief decides: the mounts are --mount type=bind,src=<absolute path>,dst=…,readonly (no -v built by string
// concatenation), and the tmpfs is noexec,nosuid. The tests of the argv below say so.

// ── the exact command ────────────────────────────────────────────────────────────────────────────────────────────

attack( SUBJECT, 'docker run gets exactly the argv of a contained run, in this order', () => once( ( run ) => {
	const _work = run.mounts[ 0 ].source;
	assert.equal( run.command, 'docker' );
	assert.deepEqual( run.args, [
		'run', '--rm', '-i', '--name', nameOf( run ),
		'--network', 'none',
		'--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
		'--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5', '--pids-limit', '64',
		'--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
		'--user', OWN.user, '-w', '/tmp',
		'--mount', `type=bind,src=${_work},dst=/work,readonly`,
		'python:3.12-slim', 'env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'AGENCY_DATA=/data', 'LANG=C.UTF-8',
		'timeout', '-k', '2', '10', 'python', '-I', '/work/main.py',
	] );
} ) );

attack( SUBJECT, 'each container has a name of its own, sbx- and sixteen hex digits', () => docker( async ( runtime, calls ) => {
	await Promise.all( Array.from( { length: 20 }, () => runtime.run( { script: 'x' } ) ) );
	const _names = runs( calls ).map( nameOf );
	assert.equal( new Set( _names ).size, 20 );
	assert.ok( _names.every( name => /^sbx-[0-9a-f]{16}$/.test( name ) ) );
} ) );

attack( SUBJECT, 'no network: --network none, exactly once, and no other network option', () => once( ( run ) => {
	assert.deepEqual( valuesOf( run, '--network' ), [ 'none' ] );
	assert.ok( !run.args.some( arg => /^--net(work)?=|^--net$|^--add-host|^--dns|^-p$|^--publish/.test( arg ) ) );
} ) );

attack( SUBJECT, 'the root file system is read-only; the only writable place is a 64 MB tmpfs at /tmp, without exec and setuid', () => once( ( run ) => {
	assert.ok( options( run ).includes( '--read-only' ) );
	assert.deepEqual( valuesOf( run, '--tmpfs' ), [ '/tmp:rw,noexec,nosuid,size=64m' ] );
	assert.ok( !options( run ).some( arg => arg === '--volumes-from' || arg === '-v' || arg === '--volume' ) );
	assert.ok( run.mounts.length === 1 && run.mounts.every( mount => mount.fields.type === 'bind' && mount.parts[ 2 ] === 'ro' ) );
} ) );

attack( SUBJECT, 'memory is capped at 256m with no swap beyond it', () => once( ( run ) => {
	assert.deepEqual( valuesOf( run, '--memory' ), [ '256m' ] );
	assert.deepEqual( valuesOf( run, '--memory-swap' ), [ '256m' ], 'memory-swap equal to memory: no swap' );
} ) );

attack( SUBJECT, 'half a CPU and at most 64 processes (no fork bomb)', () => once( ( run ) => {
	assert.deepEqual( valuesOf( run, '--cpus' ), [ '0.5' ] );
	assert.deepEqual( valuesOf( run, '--pids-limit' ), [ '64' ] );
} ) );

attack( SUBJECT, 'every capability is dropped and none is added; no new privileges', () => once( ( run ) => {
	assert.deepEqual( valuesOf( run, '--cap-drop' ), [ 'ALL' ] );
	assert.deepEqual( valuesOf( run, '--cap-add' ), [] );
	assert.deepEqual( valuesOf( run, '--security-opt' ), [ 'no-new-privileges' ] );
} ) );

attack( SUBJECT, 'the code runs as the core\'s own unprivileged user and group, never as root', () => once( ( run ) => {
	assert.deepEqual( valuesOf( run, '--user' ), [ OWN.user ] );
	assert.ok( !options( run ).some( arg => /^(0|root)(:|$)/.test( arg ) ) );
} ) );

attack( SUBJECT, 'nothing that widens the container is ever passed', () => once( ( run ) => {
	const _wide = /^--(privileged|pid|ipc|uts|userns|cgroupns|device|cap-add|group-add|sysctl|env-file|volumes-from|volume)\b|^-v$/;
	assert.ok( !run.args.some( arg => _wide.test( arg ) ), run.args.join( ' ' ) );
	assert.deepEqual( run.mounts.map( mount => [ mount.fields.type, mount.parts[ 1 ], mount.parts[ 2 ] ] ), [ [ 'bind', '/work', 'ro' ] ], 'only the work folder, read-only' );
	assert.ok( !run.args.some( arg => /docker\.sock|unconfined|apparmor|seccomp/.test( arg ) ) );
} ) );

attack( SUBJECT, 'docker passes no variable in (a bare -e NAME would copy the host\'s value); the code\'s four come with env -i', () => once( ( run ) => {
	assert.deepEqual( valuesOf( run, '-e' ), [] );
	assert.deepEqual( valuesOf( run, '--env' ), [] );
	assert.ok( [ 'HOME=/tmp', 'AGENCY_DATA=/data' ].every( value => run.args.includes( value ) ) );
} ) );

attack( SUBJECT, 'no secret of the core\'s environment ever appears in the docker argv', async () => {
	const _secrets = { LLM_API_KEY: 'sk-live-0001', MEMORY_KEY: 'mem-0002', GATE_PIN: '93571', OPERATOR_PIN: 'op-0003', VULTR_API_KEY: 'vk-0004' };
	Object.assign( process.env, _secrets );
	try {
		await once( ( run ) => {
			const _argv = run.args.join( '\n' );
			assert.ok( Object.entries( _secrets ).every( ( [ key, value ] ) => !_argv.includes( value ) && !_argv.includes( key ) ) );
		} );
	} finally {
		Object.keys( _secrets ).forEach( key => delete process.env[ key ] );
	}
} );

attack( SUBJECT, 'HOME and the working directory lie in the tmpfs, so nothing is written outside it', () => once( ( run ) => {
	assert.deepEqual( valuesOf( run, '-w' ), [ '/tmp' ] );
	assert.ok( run.args.slice( run.args.indexOf( '-i', imageAt( run ) ) ).includes( 'HOME=/tmp' ) );
	assert.ok( valuesOf( run, '--tmpfs' )[ 0 ].startsWith( '/tmp:' ) );
} ) );

attack( SUBJECT, 'the work folder is mounted read-only at /work and already holds main.py when docker starts', () => once( ( run ) => {
	const [ _work ] = run.mounts;
	assert.deepEqual( _work.parts.slice( 1 ), [ '/work', 'ro' ] );
	assert.equal( _work.main.text, 'print(1)' );
	assert.equal( path.dirname( _work.source ), os.tmpdir() );
} ) );

attack( SUBJECT, 'a data dir is mounted read-only at /data, next to the work folder', () => once( ( run ) => {
	assert.equal( run.mounts.length, 2 );
	assert.deepEqual( run.mounts[ 1 ].parts, [ '/srv/vault/survey-1', '/data', 'ro' ] );
	assert.ok( run.args.indexOf( run.mounts[ 1 ].spec ) < imageAt( run ) );
}, { run: { dataDir: '/srv/vault/survey-1' } } ) );

attack( SUBJECT, 'without a data dir there is no /data mount', () => once( ( run ) => {
	assert.equal( run.mounts.length, 1 );
	assert.ok( !run.args.some( arg => arg.includes( '/data,' ) || arg.endsWith( ':/data:ro' ) ) );
} ) );

attack( SUBJECT, 'every mount is read-only', () => once( ( run ) => {
	assert.ok( run.mounts.length === 2 && run.mounts.every( mount => mount.parts[ 2 ] === 'ro' ) );
}, { run: { dataDir: '/srv/vault/x' } } ) );

attack( SUBJECT, 'SANDBOX_DOCKER_RUNTIME=runsc runs the container under gVisor (--runtime runsc, before the image)', () => once( ( run ) => {
	assert.deepEqual( valuesOf( run, '--runtime' ), [ 'runsc' ] );
	assert.equal( run.args[ imageAt( run ) - 2 ], '--runtime' );
}, { engine: 'runsc' } ) );

attack( SUBJECT, 'without SANDBOX_DOCKER_RUNTIME docker uses its default runtime', () => once( ( run ) => {
	assert.deepEqual( valuesOf( run, '--runtime' ), [] );
}, { engine: '' } ) );

attack( SUBJECT, 'a runtime keeps the engine it was made with, whatever the environment says later', () => docker( async ( runtime, calls ) => {
	process.env.SANDBOX_DOCKER_RUNTIME = 'runc';
	await runtime.run( { script: 'x' } );
	assert.deepEqual( valuesOf( runs( calls )[ 0 ], '--runtime' ), [ 'runsc' ] );
}, { engine: 'runsc' } ) );

attack( SUBJECT, 'an engine name with spaces and dashes stays one argv entry and cannot add options', () => once( ( run ) => {
	assert.deepEqual( valuesOf( run, '--runtime' ), [ 'runsc --privileged --network host' ] );
	assert.ok( !run.args.includes( '--privileged' ) && !run.args.includes( 'host' ) );
}, { engine: 'runsc --privileged --network host' } ) );

attack( SUBJECT, 'the image is python:3.12-slim by default, the configured one otherwise, an empty one falls back', () => docker( async ( runtime, calls ) => {
	await runtime.run( { script: 'x' } );
	const _own = new DockerRuntime( { image: 'agency-sandbox@sha256:0123abcd' } );
	await _own.run( { script: 'x' } );
	await new DockerRuntime( { image: '' } ).run( { script: 'x' } );
	assert.deepEqual( runs( calls ).map( call => call.args[ imageAt( call ) ] ), [ 'python:3.12-slim', 'agency-sandbox@sha256:0123abcd', 'python:3.12-slim' ] );
} ) );

attack( SUBJECT, 'after the image comes only an empty environment, the hard timeout and python -I /work/main.py', () => once( ( run ) => {
	assert.deepEqual( run.args.slice( imageAt( run ) + 1 ), [ 'env', '-i', ...DockerRuntime.ENV, 'timeout', '-k', '2', '10', 'python', '-I', '/work/main.py' ] );
} ) );

attack( SUBJECT, 'the agent\'s code sees no variable of the image: its environment is exactly PATH, HOME, AGENCY_DATA and LANG', () => once( ( run ) => {
	const _env = run.args.slice( imageAt( run ) + 3, run.args.indexOf( 'timeout' ) );
	assert.deepEqual( _env.map( item => item.split( '=' )[ 0 ] ), [ 'PATH', 'HOME', 'AGENCY_DATA', 'LANG' ] );
	assert.ok( !_env.some( item => /KEY|TOKEN|SECRET|PIN|PASS/i.test( item ) ) );
	assert.ok( !run.args.includes( '-e' ) && !run.args.includes( '--env' ), 'nothing passed with -e' );
} ) );

attack( SUBJECT, 'the limit inside the container is the runtime\'s; the client waits 20 s longer, so the container\'s limit fires first', () => once( ( run ) => {
	assert.equal( run.args[ run.args.indexOf( 'timeout' ) + 3 ], '3' );
	assert.equal( run.options.timeoutSeconds, 23 );
}, { options: { timeoutSeconds: 3 } } ) );

attack( SUBJECT, 'stdin open (-i) for the input, no terminal (-t)', () => once( ( run ) => {
	assert.ok( options( run ).includes( '-i' ) );
	assert.ok( !run.args.some( arg => /^-(t|it|ti)$|^--tty/.test( arg ) ) );
} ) );

attack( SUBJECT, 'the input reaches docker\'s stdin as JSON', () => once( ( run ) => {
	assert.equal( run.options.input, '{"rows":[{"team":"design"}],"note":"ü"}' );
}, { run: { input: { rows: [ { team: 'design' } ], note: 'ü' } } } ) );

attack( SUBJECT, '--rm: the container is destroyed after the run, and so is the work folder', () => docker( async ( runtime, calls ) => {
	await runtime.run( { script: 'x' } );
	const [ _run ] = runs( calls );
	assert.ok( options( _run ).includes( '--rm' ) );
	assert.equal( fs.existsSync( _run.mounts[ 0 ].source ), false );
} ) );

attack( SUBJECT, 'the docker runtime calls itself docker and isolated', () => {
	assert.equal( DockerRuntime.NAME, 'docker' );
	assert.equal( DockerRuntime.ISOLATED, true );
	assert.ok( new DockerRuntime() instanceof Runtime );
} );

attack( SUBJECT, 'the log of a run says docker and isolated', () => docker( async ( runtime ) => {
	const _events = [];
	runtime.log = { append: ( kind, data ) => _events.push( [ kind, data ] ) };
	await runtime.run( { script: 'x' } );
	assert.deepEqual( _events[ 0 ], [ 'sandbox_started', { runtime: 'docker', isolated: true } ] );
	assert.deepEqual( _events.map( item => item[ 0 ] ), [ 'sandbox_started', 'sandbox_finished', 'sandbox_destroyed' ] );
} ) );

attack( SUBJECT, 'docker run is called once per run; no retry, no kill after a clean exit', () => docker( async ( runtime, calls ) => {
	await runtime.run( { script: 'x' } );
	assert.equal( calls.length, 1 );
	assert.equal( kills( calls ).length, 0 );
} ) );

attack( SUBJECT, 'the result of docker run comes back unchanged', () => once( ( _run, _calls, result ) => {
	assert.deepEqual( result, { exitCode: 0, stdout: '{"value":42}\n', stderr: 'warn' } );
}, { answer: () => ( { exitCode: 0, stdout: '{"value":42}\n', stderr: 'warn' } ) } ) );

// ── kill on failure and on stop( node ) ──────────────────────────────────────────────────────────────────────────

attacks( SUBJECT, [ 1, 124, 125, 137, -1 ].map( code => ( { code, name: `exit ${code}: the container is killed by its name afterwards` } ) ), ( { code } ) => docker( async ( runtime, calls ) => {
	const _result = await runtime.run( { script: 'x' } );
	assert.equal( _result.exitCode, code );
	const [ _kill ] = kills( calls );
	assert.deepEqual( _kill.args, [ 'kill', nameOf( runs( calls )[ 0 ] ) ] );
	assert.equal( _kill.options.timeoutSeconds, 5 );
	assert.equal( _kill.options.input, '' );
}, { answer: call => ( call.args[ 0 ] === 'run' ? { exitCode: code, stdout: '', stderr: 'x' } : { exitCode: 0, stdout: '', stderr: '' } ) } ) );

attack( SUBJECT, 'a kill that fails does not change the result of the run', () => docker( async ( runtime ) => {
	const _result = await runtime.run( { script: 'x' } );
	assert.deepEqual( _result, { exitCode: 137, stdout: 'partial', stderr: 'Killed' } );
}, { answer: call => ( call.args[ 0 ] === 'run' ? { exitCode: 137, stdout: 'partial', stderr: 'Killed' } : { exitCode: 1, stdout: '', stderr: 'No such container' } ) } ) );

// A docker run that only ends when the test releases it.
function held() {
	const _held = [];
	return {
		held: _held,
		answer: call => ( call.args[ 0 ] === 'run' ? new Promise( resolve => _held.push( resolve ) ) : { exitCode: 0, stdout: '', stderr: '' } ),
		release: code => _held.splice( 0 ).forEach( resolve => resolve( { exitCode: code, stdout: '', stderr: '' } ) ),
	};
}

attack( SUBJECT, 'stop( node ) kills the running container of that node by its name', async () => {
	const _hold = held();
	await docker( async ( runtime, calls ) => {
		const _run = runtime.run( { script: 'x', node: 'n-1' } );
		await new Promise( resolve => setImmediate( resolve ) );
		runtime.stop( 'n-1' );
		assert.deepEqual( kills( calls ).map( call => call.args ), [ [ 'kill', nameOf( runs( calls )[ 0 ] ) ] ] );
		_hold.release( 137 );
		await within( _run, 1000 );
	}, { answer: _hold.answer } );
} );

attack( SUBJECT, 'stop for another node kills nothing', async () => {
	const _hold = held();
	await docker( async ( runtime, calls ) => {
		const _run = runtime.run( { script: 'x', node: 'mine' } );
		await new Promise( resolve => setImmediate( resolve ) );
		runtime.stop( 'theirs' );
		assert.equal( kills( calls ).length, 0 );
		_hold.release( 0 );
		await within( _run, 1000 );
	}, { answer: _hold.answer } );
} );

attack( SUBJECT, 'one stop kills every container of the node', async () => {
	const _hold = held();
	await docker( async ( runtime, calls ) => {
		const _runs = [ runtime.run( { script: 'a', node: 'n' } ), runtime.run( { script: 'b', node: 'n' } ) ];
		await new Promise( resolve => setImmediate( resolve ) );
		runtime.stop( 'n' );
		assert.deepEqual( kills( calls ).map( call => call.args[ 1 ] ).sort(), runs( calls ).map( nameOf ).sort() );
		_hold.release( 0 );
		await within( Promise.all( _runs ), 1000 );
	}, { answer: _hold.answer } );
} );

attack( SUBJECT, 'a stop after the run ended kills nothing (the name is no longer tracked)', () => docker( async ( runtime, calls ) => {
	await runtime.run( { script: 'x', node: 'n' } );
	runtime.stop( 'n' );
	assert.equal( kills( calls ).length, 0 );
} ) );

attack( SUBJECT, 'a stop before any run starts nothing', () => docker( async ( runtime, calls ) => {
	runtime.stop( 'n' );
	assert.equal( calls.length, 0 );
} ) );

attack( SUBJECT, 'a stopped run still removes its work folder and returns what docker said', async () => {
	const _hold = held();
	await docker( async ( runtime, calls ) => {
		const _run = runtime.run( { script: 'x', node: 'n' } );
		await new Promise( resolve => setImmediate( resolve ) );
		runtime.stop( 'n' );
		_hold.release( 137 );
		const _result = await within( _run, 1000 );
		assert.equal( _result.exitCode, 137 );
		assert.equal( fs.existsSync( runs( calls )[ 0 ].mounts[ 0 ].source ), false );
	}, { answer: _hold.answer } );
} );

// ── what is written and mounted ──────────────────────────────────────────────────────────────────────────────────

attacks( SUBJECT, hostile( 'strings' ).filter( ( _item, i ) => i % 5 === 1 ).map( item => ( { ...item, name: `main.py in the mounted folder holds the script exactly: ${item.label}` } ) ),
	( { value } ) => docker( async ( runtime, calls ) => {
		await runtime.run( { script: value } );
		assert.equal( runs( calls )[ 0 ].mounts[ 0 ].main.text, value );
	} ) );

attack( SUBJECT, 'a data dir with spaces or commas stays one argv entry with an unambiguous mount spec', () => once( ( run ) => {
	const _data = run.mounts[ 1 ];
	assert.deepEqual( _data.parts, [ '/srv/vault/a b,c', '/data', 'ro' ] );
}, { run: { dataDir: '/srv/vault/a b,c' } } ) );

attack( SUBJECT, 'a data dir with a colon cannot change the mount (target, mode)', () => once( ( run ) => {
	const _data = run.mounts[ 1 ];
	assert.deepEqual( _data.parts, [ '/srv/vault/a:b', '/data', 'ro' ], `docker would read ${_data.spec} as source, target and mode` );
}, { run: { dataDir: '/srv/vault/a:b' } } ) );

// The brief decides that a relative path is refused (the core gives the sandbox absolute vault paths).
attack( SUBJECT, 'a relative data dir is refused, never mounted as a named docker volume', () => docker( async ( runtime, calls ) => {
	await assert.rejects( runtime.run( { script: 'x', dataDir: 'vault' } ), /absolute path/ );
	assert.equal( runs( calls ).length, 0, 'docker never started' );
} ) );

attack( SUBJECT, 'a data dir with a quote or a comma stays one field of the mount', () => once( ( run ) => {
	assert.deepEqual( run.mounts[ 1 ].parts, [ '/srv/vault/a"b,dst=/etc,c', '/data', 'ro' ] );
}, { run: { dataDir: '/srv/vault/a"b,dst=/etc,c' } } ) );

attack( SUBJECT, 'a data dir with a line break is refused', () => docker( async ( runtime, calls ) => {
	await assert.rejects( runtime.run( { script: 'x', dataDir: '/srv/vault/a\nb' } ), /absolute path/ );
	assert.equal( runs( calls ).length, 0 );
} ) );

attacks( SUBJECT, [ '-v', '--privileged', 'python:3.12 --rm', 'python:3.12\nx', '' ].map( image => ( { name: `the image ${JSON.stringify( image )} is no plain image reference and is refused`, image } ) ),
	( { image } ) => {
		if ( image === '' ) {
			assert.equal( new DockerRuntime( { image } ).image, 'python:3.12-slim', 'an empty image falls back' );
			return;
		}
		assert.throws( () => new DockerRuntime( { image } ), /no plain image reference/ );
	} );

attacks( SUBJECT, [ 'agency-sandbox', 'python:3.12-slim', 'registry.example.com:5000/team/agency-sandbox:1.2', 'agency-sandbox@sha256:0123abcd' ]
	.map( image => ( { name: `the image ${image} is a plain image reference`, image } ) ), ( { image } ) => {
	assert.equal( new DockerRuntime( { image } ).image, image );
} );

attacks( SUBJECT, [
	{ name: 'a core that runs as root gives the container nobody, never root', uid: () => 0, gid: () => 0, want: '65534:65534' },
	{ name: 'a platform without a uid gives the container nobody', uid: undefined, gid: undefined, want: '65534:65534' },
	{ name: 'a core in the root group keeps its uid, but not the root group', uid: () => 1234, gid: () => 0, want: '1234:65534' },
	{ name: 'a core with its own user and group gives the container exactly these', uid: () => 1234, gid: () => 2345, want: '1234:2345' },
], async ( { uid, gid, want } ) => {
	const [ _uid, _gid ] = [ process.getuid, process.getgid ];
	Object.assign( process, { getuid: uid, getgid: gid } );
	try {
		await once( ( run ) => {
			assert.deepEqual( valuesOf( run, '--user' ), [ want ] );
		} );
	} finally {
		Object.assign( process, { getuid: _uid, getgid: _gid } );
	}
} );

attack( SUBJECT, 'the container user can enter the work folder and read main.py when docker starts; the folder stays private', () => once( ( run ) => {
	const [ _work ] = run.mounts;
	assert.ok( readableBy( _work.stat, OWN.uid, 5 ), `work folder mode ${( _work.stat.mode & 0o777 ).toString( 8 )} owned by ${_work.stat.uid}` );
	assert.ok( readableBy( _work.main.stat, OWN.uid, 4 ), `main.py mode ${( _work.main.stat.mode & 0o777 ).toString( 8 )}` );
	assert.equal( _work.stat.mode & 0o077, 0, 'nobody else on the host may enter the work folder' );
} ) );

attack( SUBJECT, 'the container user can read the vault the core prepared for the run; the vault stays private', async () => {
	const _source = fs.mkdtempSync( path.join( PRIVATE, 'mission-data-' ) );
	fs.writeFileSync( path.join( _source, 'answers.csv' ), 'team\ndesign\n' );
	const _vault = Vault.prepare( { id: 'survey', dataDir: _source }, PRIVATE );
	await once( ( run ) => {
		const _data = run.mounts[ 1 ];
		assert.equal( _data.source, _vault.dir );
		assert.ok( readableBy( _data.stat, OWN.uid, 5 ), `vault mode ${( _data.stat.mode & 0o777 ).toString( 8 )} owned by ${_data.stat.uid}` );
		assert.equal( _data.stat.mode & 0o077, 0, 'the identities in the vault stay private on the host' );
	}, { run: { dataDir: _vault.dir } } );
} );

attack( SUBJECT, 'a time limit of 0 does not switch off the limit inside the container', () => once( ( run ) => {
	const _limit = run.args[ run.args.indexOf( 'timeout' ) + 3 ];
	assert.ok( Number( _limit ) > 0, `timeout got ${_limit}` );
}, { options: { timeoutSeconds: 0 } } ) );

attack( SUBJECT, 'the kill after a failure names exactly the container that ran, not another run\'s', () => docker( async ( runtime, calls ) => {
	await Promise.all( [ runtime.run( { script: 'ok' } ), runtime.run( { script: 'fail' } ) ] );
	const _failed = runs( calls ).find( call => call.mounts[ 0 ].main.text === 'fail' );
	assert.deepEqual( kills( calls ).map( call => call.args[ 1 ] ), [ nameOf( _failed ) ] );
}, { answer: call => ( call.args[ 0 ] === 'run' && call.mounts[ 0 ].main.text === 'fail' ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' } ) } ) );

attack( SUBJECT, 'the options all come before the image; after it no docker option can appear', () => once( ( run ) => {
	const _after = run.args.slice( imageAt( run ) + 1 ).filter( arg => arg.startsWith( '-' ) );
	assert.deepEqual( _after, [ '-i', '-k', '-I' ], 'only the options of env, timeout and python' );
	assert.ok( !run.args[ imageAt( run ) ].startsWith( '-' ) );
}, { engine: 'runsc', run: { dataDir: '/srv/v' } } ) );

attack( SUBJECT, 'the work folder of every run is different and removed afterwards, also for twenty at once', () => docker( async ( runtime, calls ) => {
	await Promise.all( Array.from( { length: 20 }, ( _x, i ) => runtime.run( { script: `print(${i})` } ) ) );
	const _sources = runs( calls ).map( call => call.mounts[ 0 ].source );
	assert.equal( new Set( _sources ).size, 20 );
	assert.ok( _sources.every( source => !fs.existsSync( source ) ) );
} ) );

attack( SUBJECT, 'hostile input values pass to stdin unchanged and never into the argv', () => once( ( run ) => {
	const _input = { a: '--privileged', b: '$(id)', c: '-v /:/host', d: '\u0000' };
	assert.equal( run.options.input, JSON.stringify( _input ) );
	assert.ok( !run.args.includes( '--privileged' ) && !run.args.some( arg => arg.includes( '$(id)' ) ) );
}, { run: { input: { a: '--privileged', b: '$(id)', c: '-v /:/host', d: '\u0000' } } } ) );
