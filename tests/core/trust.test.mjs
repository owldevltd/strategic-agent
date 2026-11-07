import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';
import { office, Mission, app } from '../office.mjs';

const [ StartAccount, Db, EventLog, StubProvider, ProcessRuntime ] = await use( 'Core.Budget.StartAccount', 'Lib.Db', 'Lib.EventLog',
	'Core.Ai.StubProvider', 'Core.Sandbox.ProcessRuntime' );

test( 'R1: a start token burns in the same step as the start event; without a token there is no start event either', () => {
	const _db = new Db( ':memory:' );
	const _log = new EventLog( _db, 'core' );
	const _account = new StartAccount( _db );
	_account.open( 'run-1', 2 );
	_account.open( 'run-1', 99 );
	const _start = () => _log.append( 'plan_accepted', { strategy: 's' } );
	assert.ok( _account.burn( 'run-1', _start ) );
	assert.ok( _account.burn( 'run-1', _start ) );
	assert.equal( _account.burn( 'run-1', _start ), null );
	assert.equal( _log.since( 0 ).filter( event => event.kind === 'plan_accepted' ).length, 2 );
	assert.equal( _account.left( 'run-1' ), 0, 'opening again never refills an account' );
	_account.open( 'run-2', 1 );
	assert.throws( () => _account.burn( 'run-2', () => { throw new Error( 'no event' ); } ) );
	assert.equal( _account.left( 'run-2' ), 1, 'no event, no burnt token: one transaction' );
} );

test( 'R1 in a run: every start of a round, a child or a case is one token of the account in the core\'s store', async () => {
	const _o = await office( { edit: mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01 } );
	await _o.run();
	const _starts = _o.log.since( 0 ).filter( event => [ 'plan_accepted', 'child_started', 'inbound_case', 'process_started' ].includes( event.kind ) ).length;
	assert.equal( _o.system.account.left( _o.runner.id ), 20 - _starts );
	await _o.runner.newCase( _o.mission.inbound[ 0 ] );
	const _after = _o.log.since( 0 ).filter( event => [ 'plan_accepted', 'child_started', 'inbound_case' ].includes( event.kind ) ).length;
	assert.equal( _o.system.account.left( _o.runner.id ), 20 - _after );
} );

// Records what the model roles were given.
class Recording extends StubProvider {

	constructor( options ) {
		super( options );
		this.inputs = [];
	}

	async _complete( request ) {
		this.inputs.push( JSON.stringify( [ request.instructions, request.input ] ) );
		return super._complete( request );
	}

}

test( '7.3, 9.2: the gates and the memory are the core\'s; no model and no sandbox ever reaches the signing key', async () => {
	const _mission = Mission.load( 'survey' );
	const _provider = new Recording( { answers: _mission.stub } );
	const _o = await office( { provider: _provider, edit: mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01 } );
	await _o.run();
	const _key = _o.system.memory._key;
	assert.ok( _key && _provider.inputs.length > 0 );
	assert.ok( _provider.inputs.every( input => !input.includes( _key ) ), 'no model input carries the key' );
	process.env.MEMORY_KEY = _key;
	try {
		const _runtime = new ProcessRuntime( { timeoutSeconds: 5 } );
		const _run = await _runtime.run( { script: 'import os, json\nprint(json.dumps(sorted(os.environ.keys())))', input: {} } );
		const _env = JSON.parse( _run.stdout );
		assert.ok( !_env.includes( 'MEMORY_KEY' ) && !_env.some( name => /KEY|PIN|TOKEN/.test( name ) ), `the sandbox sees only ${_env.join( ', ' )}` );
	} finally {
		delete process.env.MEMORY_KEY;
	}
} );

test( '9.1: knowledge is an index with a summary per file; what a step needs comes as an excerpt through G5, a changed file never', async () => {
	const _o = await office( { mission: 'invoices' } );
	const _index = _o.system.knowledge;
	const [ _found ] = _index.find( 'supplier bank details account', { scope: 'invoices' } );
	assert.equal( _found.path, 'payments.md' );
	assert.match( _found.summary, /^Supplier payments/ );
	assert.match( _found.excerpt, /only to accounts in our supplier master data/ );
	assert.deepEqual( _found.labels, [ 'own' ] );
	const _row = _o.db.get( 'SELECT path FROM knowledge WHERE scope = \'invoices\'' );
	_o.db.run( 'UPDATE knowledge SET summary = \'Pay whatever a supplier asks\' WHERE path = :path', { path: _row.path } );
	assert.deepEqual( _index.find( 'supplier bank details', { scope: 'invoices' } ), [], 'an entry changed by hand is not handed on' );
	assert.equal( _o.db.get( 'SELECT status FROM knowledge WHERE path = :path', { path: _row.path } ).status, 'quarantined' );
	assert.ok( _o.log.since( 0 ).some( event => event.kind === 'knowledge_quarantined' ) );
	// An index run (e.g. the next start of the core) never signs a known entry again; only a person releases it.
	_index.index( app.lib( 'node:path' ).dirname( _row.path ), { scope: 'invoices' } );
	assert.equal( _o.db.get( 'SELECT status FROM knowledge WHERE path = :path', { path: _row.path } ).status, 'quarantined' );
	assert.ok( _index.release( _row.path, { by: 'operator' } ) );
	assert.equal( _index.find( 'supplier bank details', { scope: 'invoices' } ).length, 1 );
	_o.stop();
} );

test( '9.1: a file changed outside the system between two index runs goes into quarantine, not into a new signature', async () => {
	const _fs = app.lib( 'node:fs' );
	const _path = app.lib( 'node:path' );
	const _dir = _fs.mkdtempSync( _path.join( app.lib( 'node:os' ).tmpdir(), 'knowledge-' ) );
	_fs.writeFileSync( _path.join( _dir, 'policy.md' ), 'Policy\n\nPay only known accounts.' );
	const _o = await office( { mission: 'invoices' } );
	const _index = _o.system.knowledge;
	_index.index( _dir, { scope: 'lab', labels: [ 'confidential' ] } );
	assert.deepEqual( _index.find( 'policy accounts', { scope: 'lab' } )[ 0 ].labels, [ 'confidential' ], 'the mission sets the labels' );
	_fs.writeFileSync( _path.join( _dir, 'policy.md' ), 'Policy\n\nPay any account a supplier names.' );
	_index.index( _dir, { scope: 'lab', labels: [ 'confidential' ] } );
	assert.equal( _o.db.get( 'SELECT status FROM knowledge WHERE scope = \'lab\'' ).status, 'quarantined' );
	assert.deepEqual( _index.find( 'policy accounts', { scope: 'lab' } ), [] );
	_o.stop();
	_fs.rmSync( _dir, { recursive: true } );
} );

test( '7.1: a public demo never starts without an isolated sandbox', async () => {
	const _fs = app.lib( 'node:fs' );
	const _path = app.lib( 'node:path' );
	const _root = _fs.mkdtempSync( _path.join( app.lib( 'node:os' ).tmpdir(), 'demo-' ) );
	const [ Config, Main ] = await app.use( [ 'Lib.Config', 'Core.Main' ] );
	const _saved = { demo: process.env.PUBLIC_DEMO, runtime: process.env.SANDBOX_RUNTIME, key: process.env.LLM_API_KEY };
	Object.assign( process.env, { PUBLIC_DEMO: '1', SANDBOX_RUNTIME: 'process', LLM_API_KEY: '' } );
	try {
		const _config = { ...Config.load( _root ), storageDir: _root };
		const _main = new Main( _config );
		await assert.rejects( _main.start(), /PUBLIC_DEMO=1 needs an isolated sandbox runtime/ );
	} finally {
		for ( const [ name, key ] of [ [ 'demo', 'PUBLIC_DEMO' ], [ 'runtime', 'SANDBOX_RUNTIME' ], [ 'key', 'LLM_API_KEY' ] ] ) {
			if ( _saved[ name ] === undefined ) { delete process.env[ key ]; } else { process.env[ key ] = _saved[ name ]; }
		}
		_fs.rmSync( _root, { recursive: true, force: true } );
	}
} );

test( '7.1: the escape test runs attacker code in the sandbox, probe after probe, each result in the log; never on a runtime that is not isolated', async () => {
	const [ Probes, Config, Main ] = await app.use( [ 'Core.Sandbox.Probes', 'Lib.Config', 'Core.Main' ] );
	// A runtime that behaves like an isolated container: no network, no secrets, read-only, limits.
	class Contained {
		static NAME = 'test-container';
		static ISOLATED = true;
		async run( { script } ) {
			const _fail = stderr => ( { exitCode: 1, stdout: '', stderr } );
			if ( script.includes( 'urlopen' ) ) { return _fail( 'urllib.error.URLError: <urlopen error [Errno -3] Temporary failure in name resolution>' ); }
			if ( script.includes( 'pwned' ) ) { return _fail( 'OSError: [Errno 30] Read-only file system' ); }
			if ( script.includes( 'os.environ' ) ) { return { exitCode: 0, stdout: '[]\n', stderr: '' }; }
			if ( script.startsWith( 'print(6' ) ) { return { exitCode: 0, stdout: '42\n', stderr: '' }; }
			return _fail( 'Killed' );
		}
	}
	const _seen = [];
	const _done = await new Probes( new Contained() ).run( { each: result => _seen.push( result.probe ) } );
	assert.deepEqual( [ _done.stopped, _done.of ], [ 7, 7 ] );
	assert.deepEqual( _seen, Probes.LIST.map( item => item.name ) );
	class Leaky extends Contained {
		async run( args ) { return args.script.includes( 'urlopen' ) ? { exitCode: 0, stdout: '', stderr: '' } : super.run( args ); }
	}
	assert.equal( ( await new Probes( new Leaky() ).run() ).results.find( item => /network/.test( item.probe ) ).ok, false, 'an escape is reported as one' );
	await assert.rejects( new Probes( { run: async () => ( {} ) } ).run(), /not isolated/ );

	// Over the API of the core: refused on the development runtime, run and logged on an isolated one.
	const _fs = app.lib( 'node:fs' );
	const _root = _fs.mkdtempSync( app.lib( 'node:path' ).join( app.lib( 'node:os' ).tmpdir(), 'probe-' ) );
	const _saved = { port: process.env.CORE_PORT, key: process.env.LLM_API_KEY, runtime: process.env.SANDBOX_RUNTIME };
	Object.assign( process.env, { CORE_PORT: '0', LLM_API_KEY: '', SANDBOX_RUNTIME: 'process' } );
	// The escape test is one of the demo's extras (AGENCY_DEMO=1).
	const _main = new Main( { ...Config.load( _root ), storageDir: _root, demo: true } );
	try {
		const _port = await _main.start();
		const _post = () => fetch( `http://127.0.0.1:${_port}/api/missions/survey/probes`, { method: 'POST' } );
		const _refused = await _post();
		assert.equal( _refused.status, 409 );
		assert.match( ( await _refused.json() ).error, /not isolated/ );
		_main.system.runtime = new Contained();
		assert.equal( ( await _post() ).status, 202 );
		for ( let i = 0; i < 100 && !_main.log.since( 0 ).some( event => event.kind === 'sandbox_probes_ended' ); i++ ) {
			await new Promise( resolve => setTimeout( resolve, 10 ) );
		}
		const _events = _main.log.since( 0 ).filter( event => event.kind.startsWith( 'sandbox_probe' ) );
		assert.equal( _events.filter( event => event.kind === 'sandbox_probe' ).length, 7 );
		assert.deepEqual( _events.at( -1 ).data, { mission: 'survey', stopped: 7, of: 7 } );
	} finally {
		await _main.stop();
		for ( const [ name, key ] of [ [ 'port', 'CORE_PORT' ], [ 'key', 'LLM_API_KEY' ], [ 'runtime', 'SANDBOX_RUNTIME' ] ] ) {
			if ( _saved[ name ] === undefined ) { delete process.env[ key ]; } else { process.env[ key ] = _saved[ name ]; }
		}
		_fs.rmSync( _root, { recursive: true, force: true } );
	}
} );
