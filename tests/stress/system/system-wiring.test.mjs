// Core.System as the place where everything is wired (7.1, B7, 9.1, 18): which sandbox and which model a
// configuration selects, what every runner shares and what each run gets for itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attack, attacks } from '../hostile.mjs';
import { use, memoryDb } from '../../helper.mjs';
import { office, Mission } from '../../office.mjs';
import { coding } from './coding.mjs';

const SUBJECT = 'core/system.js';
const [ System, EventLog, DockerRuntime, ProcessRuntime, OpenAiProvider, StubProvider, Calibration, GateClient ] = await use(
	'Core.System', 'Lib.EventLog', 'Core.Sandbox.DockerRuntime', 'Core.Sandbox.ProcessRuntime', 'Core.Ai.OpenAiProvider',
	'Core.Ai.StubProvider', 'Core.Ai.Calibration', 'Core.Outbound.GateClient' );

const config = ( over = {} ) => ( {
	gate: { url: 'http://127.0.0.1:9/', bufferMinutes: 5 }, maxDepth: 5, beatMs: 50,
	llm: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: '', timeoutSeconds: 3 },
	sandbox: { runtime: 'process', timeoutSeconds: 7, image: 'test-image' },
	...over,
} );
const create = ( over = {} ) => {
	const _db = memoryDb();
	return System.create( { config: config( over ), db: _db, log: new EventLog( _db, 'core' ) } );
};
const sandbox = runtime => ( { sandbox: { runtime, timeoutSeconds: 7, image: 'test-image' } } );
const llm = ( apiKey, model ) => ( { llm: { baseUrl: 'http://127.0.0.1:9/v1/', apiKey, model, timeoutSeconds: 3 } } );

attack( SUBJECT, 'create: "docker" selects the isolated container runtime with the configured limit and image', async () => {
	const _system = await create( sandbox( 'docker' ) );
	assert.ok( _system.runtime instanceof DockerRuntime );
	assert.equal( _system.runtime.constructor.ISOLATED, true );
	assert.equal( _system.runtime.timeoutSeconds, 7 );
	assert.equal( _system.runtime.image, 'test-image' );
} );

attack( SUBJECT, 'create: "process" selects the development runtime, which says it is not isolated', async () => {
	const _system = await create( sandbox( 'process' ) );
	assert.ok( _system.runtime instanceof ProcessRuntime );
	assert.equal( _system.describe().isolated, false );
	assert.equal( _system.describe().runtime, 'process' );
} );

attacks( SUBJECT, [ 'Docker', 'runsc', 'gvisor', 'docker ' ].map( name => ( {
	name: `create: an unknown sandbox runtime ${JSON.stringify( name )} is refused, never replaced by the runtime without isolation`, value: name,
} ) ), async ( { value } ) => {
	await assert.rejects( create( sandbox( value ) ), /runtime/i );
} );

attack( SUBJECT, 'create: the gate client talks to the configured gate url, without a trailing slash', async () => {
	const _system = await create();
	assert.ok( _system.gate instanceof GateClient );
	assert.equal( _system.gate.url, 'http://127.0.0.1:9' );
} );

attack( SUBJECT, 'create: the criteria registry is loaded and knows the catalog types', async () => {
	const _system = await create();
	for ( const type of [ 'test_green', 'min_group', 'exactly_once', 'human_approval' ] ) {
		assert.ok( _system.registry.has( type ), type );
	}
} );

attack( SUBJECT, 'describe: without a key the model is the stub', async () => {
	assert.equal( ( await create( llm( '', 'some-model' ) ) ).describe().provider, 'stub' );
} );

attack( SUBJECT, 'describe: without a model the model is the stub, even with a key', async () => {
	assert.equal( ( await create( llm( 'k-123', '' ) ) ).describe().provider, 'stub' );
} );

attack( SUBJECT, 'describe: with key and model it names the model and never the key', async () => {
	const _described = ( await create( llm( 'k-secret-123', 'glm-test' ) ) ).describe();
	assert.equal( _described.provider, 'glm-test' );
	assert.ok( !JSON.stringify( _described ).includes( 'k-secret-123' ) );
} );

attack( SUBJECT, '_provider: key and model give the OpenAI-compatible provider with the configured endpoint and timeout', async () => {
	const _log = { append: () => null };
	const _provider = await System._provider( config( llm( 'k-1', 'glm-test' ) ), _log, coding() );
	assert.ok( _provider instanceof OpenAiProvider );
	assert.deepEqual( [ _provider.baseUrl, _provider.model, _provider.timeoutSeconds, _provider.log ], [ 'http://127.0.0.1:9/v1/', 'glm-test', 3, _log ] );
	assert.equal( _provider.name(), 'glm-test' );
} );

attack( SUBJECT, '_provider: without a key the stub answers with the mission\'s own answers', async () => {
	const _mission = coding();
	const _provider = await System._provider( config(), null, _mission );
	assert.ok( _provider instanceof StubProvider );
	assert.equal( _provider.answers, _mission.stub );
	assert.equal( ( await _provider._complete( { role: 'coder', input: [], contract: { fields: { code: { type: 'string' } } } } ) ).code, _mission.stub.coder.code );
} );

attack( SUBJECT, '_provider: a mission without stub answers gets the template stub', async () => {
	const _provider = await System._provider( config(), null, { stub: {} } );
	const _answer = await _provider.complete( { role: 'anyone', input: 'hello', contract: { fields: { text: { type: 'string' } } } } );
	assert.deepEqual( _answer, { text: 'hello' } );
} );

attack( SUBJECT, 'causes: the cause codes come from the catalog, rule by rule', () => {
	const _causes = System.causes();
	assert.equal( _causes.ofRule( 'min_group' ), 'group_too_small' );
	assert.equal( _causes.ofRule( 'exactly_once' ), 'already_done' );
	assert.ok( _causes.codes().includes( 'move_failed' ) );
} );

attack( SUBJECT, 'board: one ticket board per system, made once', async () => {
	const _system = await create();
	const _board = await _system.board();
	assert.equal( await _system.board(), _board );
	assert.deepEqual( _board.list(), [] );
} );

attack( SUBJECT, 'assemble: the runner works on the system\'s sandbox, gate and journal', async () => {
	const o = await office( { mission: coding() } );
	const _runner = o.runner;
	assert.equal( _runner.executor.runtime, o.system.runtime );
	assert.equal( _runner.executor.gate, o.system.gate );
	assert.equal( _runner.journal, o.system.journal );
	assert.equal( _runner.executor.board, await o.system.board() );
	assert.equal( _runner.supervisor.runtime, o.system.runtime, 'the supervisor ends what still runs (A3)' );
	o.stop();
} );

attack( SUBJECT, 'assemble: a provider without calibration gets one on the system\'s board (B7)', async () => {
	const _provider = new StubProvider( { answers: coding().stub } );
	const o = await office( { mission: coding(), provider: _provider } );
	assert.ok( _provider.calibration instanceof Calibration );
	assert.equal( _provider.calibration.board, await o.system.board() );
	assert.equal( _provider.calibration.log, o.log );
	assert.deepEqual( [ _provider.calibration.every, _provider.calibration.threshold ], [ 20, 0.05 ], 'one in twenty, 5 % (B7)' );
	o.stop();
} );

attack( SUBJECT, 'assemble: a calibration the provider already has is kept', async () => {
	const _provider = new StubProvider( { answers: coding().stub } );
	const _own = { review: async () => null };
	_provider.calibration = _own;
	const o = await office( { mission: coding(), provider: _provider } );
	assert.equal( _provider.calibration, _own );
	o.stop();
} );

attack( SUBJECT, 'assemble: every run works on its own fresh copy of the mission data', async () => {
	const o = await office( { mission: 'invoices' } );
	const _second = await o.system.assemble( Mission.load( 'invoices' ), { pollMs: 5 } );
	assert.notEqual( o.runner.vault.dir, _second.vault.dir );
	for ( const runner of [ o.runner, _second ] ) {
		assert.ok( fs.existsSync( path.join( runner.vault.dir, 'suppliers.csv' ) ) );
		assert.equal( runner.mission.dataDir, runner.vault.dir );
	}
	o.stop();
} );

attack( SUBJECT, 'assemble: a second run of the same mission object starts from the mission data, not from the first run\'s vault', async () => {
	const _mission = Mission.load( 'invoices' );
	const o = await office( { mission: _mission } );
	fs.writeFileSync( path.join( o.runner.vault.dir, 'suppliers.csv' ), 'supplier,iban\nAttacker Ltd,DE89370400440532013000\n' );
	const _second = await o.system.assemble( _mission, { pollMs: 5 } );
	const _copied = fs.readFileSync( path.join( _second.vault.dir, 'suppliers.csv' ), 'utf8' );
	o.stop();
	assert.ok( !_copied.includes( 'Attacker' ), 'what one run wrote into its vault must not reach the next run' );
} );

attack( SUBJECT, 'assemble: after a restart the run keeps its vault and its id, and logs no new start', async () => {
	const o = await office( { mission: coding() } );
	const _starts = () => o.log.since( 0, 1e9 ).filter( event => event.kind === 'run_started' ).length;
	const _before = _starts();
	const _dir = fs.mkdtempSync( path.join( o.runner.vault.dir, '..', 'kept-' ) );
	const _again = await o.system.assemble( coding(), { vault: _dir, run: 'run-kept', pollMs: 5 } );
	assert.equal( _again.id, 'run-kept' );
	assert.equal( _again.vault.dir, _dir );
	assert.equal( _again.mission.dataDir, _dir );
	assert.equal( _starts(), _before );
	o.stop();
	fs.rmSync( _dir, { recursive: true, force: true } );
} );

// The brief decides: mission.json may set startTokens (default 20), and the system hands it to the runner (R1).
attack( SUBJECT, 'assemble: the root\'s start budget is the mission\'s startTokens, 20 if it names none (R1)', async () => {
	const o = await office( { mission: coding() } );
	const _own = coding();
	_own.startTokens = 3;
	const _broken = coding();
	_broken.startTokens = -1;
	const _runners = await Promise.all( [ _own, coding(), _broken ].map( mission => o.system.assemble( mission, { pollMs: 5 } ) ) );
	o.stop();
	assert.deepEqual( _runners.map( runner => runner.tokensLeft() ), [ 3, 20, 20 ] );
} );

attack( SUBJECT, 'assemble: a fresh run is logged with its mission and its vault', async () => {
	const o = await office( { mission: coding() } );
	const _event = o.log.since( 0, 1e9 ).find( event => event.kind === 'run_started' );
	assert.deepEqual( _event.data, { run: o.runner.id, mission: 'coding', vault: o.runner.vault.dir } );
	o.stop();
} );

attack( SUBJECT, 'assemble: the runner takes buffer, depth and polling from the configuration', async () => {
	const o = await office( { mission: coding() } );
	assert.deepEqual( [ o.runner.bufferMinutes, o.runner.maxDepth, o.runner.pollMs ], [ 5, 5, 5 ] );
	o.stop();
} );

attack( SUBJECT, 'assemble: expectations, memory, start account, proposals, strategy gates and knowledge are one per system', async () => {
	const o = await office( { mission: coding() } );
	const _shared = () => [ o.system.expectations, o.system.memory, o.system.account, o.system.meta, o.system.gates, o.system.knowledge ];
	const _before = _shared();
	const _second = await o.system.assemble( Mission.load( 'invoices' ), { pollMs: 5 } );
	assert.deepEqual( _shared(), _before );
	assert.equal( _second.expectations, o.runner.expectations );
	assert.equal( _second.memory, o.runner.memory );
	o.stop();
} );

attack( SUBJECT, 'assemble: the history of tickets and the journal\'s corrections are wired once, however many runs', async () => {
	const o = await office( { mission: coding() } );
	const _board = await o.system.board();
	const _listeners = _board._listeners.length;
	await o.system.assemble( coding(), { pollMs: 5 } );
	await o.system.assemble( coding(), { pollMs: 5 } );
	assert.equal( _board._listeners.length, _listeners );
	assert.equal( o.system.journal._listeners.length, 1 );
	o.stop();
} );

attack( SUBJECT, 'assemble: the mission\'s knowledge is indexed under the mission\'s own scope with its labels', async () => {
	const o = await office( { mission: 'invoices' } );
	const [ _found ] = o.system.knowledge.find( 'supplier bank details account', { scope: 'invoices' } );
	assert.equal( _found.path, 'payments.md' );
	assert.deepEqual( o.system.knowledge.find( 'supplier bank details account', { scope: 'survey' } ), [] );
	o.stop();
} );

attack( SUBJECT, 'assemble: a mission without a knowledge folder still assembles', async () => {
	const o = await office( { mission: coding() } );
	assert.equal( fs.existsSync( path.join( o.mission.dir, 'knowledge' ) ), false );
	assert.ok( o.runner );
	o.stop();
} );

attack( SUBJECT, 'assemble: the simulated world starts only where the mission has one and the configuration allows it', async () => {
	const o = await office( { mission: coding() } );
	assert.equal( o.runner.world, undefined );
	o.system.config = { ...o.system.config, world: false };
	const _survey = await o.system.assemble( Mission.load( 'survey' ), { pollMs: 5 } );
	assert.equal( _survey.world, undefined, 'world: false keeps the simulation off' );
	o.system.config = { ...o.system.config, world: true };
	const _live = await o.system.assemble( Mission.load( 'survey' ), { pollMs: 5 } );
	assert.ok( _live.world );
	_live.world.stop();
	o.stop();
} );

attack( SUBJECT, 'assemble: every runner gets its intake for messages from outside and the neighbour office', async () => {
	const o = await office( { mission: 'invoices' } );
	assert.equal( o.runner.intake.runner, o.runner );
	assert.equal( o.runner.intake.vault, o.runner.vault );
	assert.equal( o.runner.baseline.mission, o.runner.mission );
	o.stop();
} );

attack( SUBJECT, 'assemble: strategy gates a mission brings are proposed for its kind once, and only ever add', async () => {
	const _gate = { rule: 'order', before: 'code.write', after: 'code.test' };
	const _mission = coding();
	_mission.gates = [ _gate ];
	const o = await office( { mission: _mission } );
	const _active = o.system.gates.active( 'code-change' ).length;
	assert.equal( _active, 1 );
	const _again = coding();
	_again.gates = [ { rule: 'order', before: 'code.test', after: 'code.write' } ];
	await o.system.assemble( _again, { pollMs: 5 } );
	assert.equal( o.system.gates.active( 'code-change' ).length, 1, 'a kind that has gates gets none from a later mission object' );
	o.stop();
} );

attack( SUBJECT, 'latest, running and nodes: per mission, the last runner; nothing runs before a start', async () => {
	const o = await office( { mission: coding() } );
	const _invoices = await o.system.assemble( Mission.load( 'invoices' ), { pollMs: 5 } );
	assert.equal( o.system.latest( 'invoices' ), _invoices );
	assert.equal( o.system.latest( 'coding' ), o.runner );
	assert.equal( o.system.running( 'coding' ), false );
	assert.equal( o.system.running( 'nowhere' ), false );
	assert.deepEqual( o.system.nodes(), [] );
	assert.throws( () => o.system.latest( 'nowhere' ), /mission nowhere has not been started/ );
	o.stop();
} );

attack( SUBJECT, 'nodes and running: the nodes of every runner, open while the goal is open, closed after', async () => {
	const o = await office( { mission: coding() } );
	const _done = o.run();
	for ( let i = 0; i < 200 && !o.system.running( 'coding' ); i++ ) { await new Promise( resolve => setTimeout( resolve, 2 ) ); }
	assert.equal( o.system.running( 'coding' ), true );
	const _root = await _done;
	assert.equal( o.system.running( 'coding' ), false );
	assert.deepEqual( o.system.nodes().map( node => node.id ), [ _root.id ] );
	o.stop();
} );
