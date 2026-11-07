// Case 12 of tests/usecases/CASES.md: the agent writes a calculator in PHP, through the real loop and the real
// (in-process) gate, with the stub model and a scripted person. The mission and this test were written by an agent
// that knew nothing of the engine but the README and docs/missions.md. The stub only plays the coder: it hands over a
// PHP file, and everything that decides (red lines, the hidden suite, the repair report, the goal) is the system's
// own: the mission's trusted frame (calculator/tools/php_frame.py), the core's executor and the test_green criterion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname( fileURLToPath( import.meta.url ) );
const MISSIONS = HERE;
process.env.AGENCY_MISSIONS = 'missions,tests/usecases';
const { office, Mission, app } = await import( '../office.mjs' );
const [ StubProvider ] = await app.use( [ 'Core.Ai.StubProvider' ] );

const php = name => fs.readFileSync( path.join( HERE, 'fixtures', 'calculator', `${name}.php` ), 'utf8' );
const STRATEGIES = JSON.parse( fs.readFileSync( path.join( MISSIONS, 'calculator/strategies.json' ), 'utf8' ) );
const CASES = STRATEGIES[ 0 ].steps[ 2 ].params.cases;
const SPEC = fs.readFileSync( path.join( MISSIONS, 'calculator/data/SPEC.md' ), 'utf8' );
// Hidden cases whose input the specification does not show: no model may ever see one of them.
const HIDDEN_ONLY = CASES.map( item => item.input ).filter( input => input.trim().length >= 3 && !SPEC.includes( input ) );
const wait = ms => new Promise( resolve => setTimeout( resolve, ms ) );
// A deadline that does not keep the process alive after the run ended.
const deadline = ms => new Promise( resolve => setTimeout( resolve, ms ).unref() );

// The stub model, recording every request it gets (every role), so a test can read what the model heard.
class Recording extends StubProvider {
	constructor( options ) {
		super( options );
		this.requests = [];
	}

	async _complete( request ) {
		this.requests.push( structuredClone( request ) );
		return super._complete( request );
	}
}

// The scripted person: confirms the goal (office does), approves what is asked, answers a ticket with its recommendation.
// It never looks at code and never decides whether a test passed.
async function run( coder, { ms = 90000 } = {} ) {
	const mission = Mission.load( 'calculator' );
	const provider = new Recording( { answers: { ...mission.stub, ...( coder ? { coder } : {} ) } } );
	const o = await office( { mission, provider, approve: () => true, person: ticket => ticket.recommendation ?? ticket.options[ 0 ] } );
	const started = Date.now();
	const root = await Promise.race( [ o.run(), deadline( ms ).then( () => null ) ] );
	const seconds = ( Date.now() - started ) / 1000;
	await wait( 100 );
	o.stop();
	return { ...o, root: root || o.runner.root, finished: Boolean( root ), seconds, provider };
}

const facts = ( o, kind ) => [ ...o.runner.nodes.values() ].flatMap( node => node.facts.filter( item => item.kind === kind ) );
const coderCalls = o => o.provider.requests.filter( item => item.role === 'coder' );
// What the coder heard for its repair: the core appends it to the instructions after this sentence.
const heard = request => ( request.instructions.split( 'Your previous answer could not be used; write it again. ' )[ 1 ] ?? null );
const commit = JSON.parse( fs.readFileSync( path.join( MISSIONS, 'calculator/contract.json' ), 'utf8' ) ).criteria[ 0 ].values.commit;

function neverSawHiddenCases( o ) {
	assert.ok( HIDDEN_ONLY.length >= 10, 'enough hidden-only cases to look for' );
	for ( const request of o.provider.requests ) {
		const text = `${request.instructions}\n${JSON.stringify( request.input )}`;
		for ( const input of HIDDEN_ONLY ) {
			assert.ok( !text.includes( input ), `the ${request.role} model saw the hidden case ${JSON.stringify( input )}` );
		}
	}
}

test( 'the goal, the fits and the strategy gate name the commit the frame gives this frozen suite', () => {
	const frame = path.join( MISSIONS, 'calculator/tools/php_frame.py' );
	const out = spawnSync( 'python3', [ '-I', frame, '--version' ], { input: JSON.stringify( { suite: 'calculator-hidden', cases: CASES } ), encoding: 'utf8' } );
	assert.equal( out.stdout.trim(), commit );
	// Both strategies run the same frozen suite, admit only a goal on it (fits), and the strategy gate names it too.
	assert.deepEqual( STRATEGIES[ 1 ].steps[ 2 ].params, STRATEGIES[ 0 ].steps[ 2 ].params );
	for ( const strategy of STRATEGIES ) { assert.deepEqual( strategy.fits, { test: '^calculator-hidden$', commit: `^${commit}$` } ); }
	const [ gate ] = JSON.parse( fs.readFileSync( path.join( MISSIONS, 'calculator/gates.json' ), 'utf8' ) );
	assert.deepEqual( gate.criterion.values, { test: 'calculator-hidden', commit } );
} );

test( '1 a correct calculator from the stub coder meets the goal on a green run of the hidden suite', async () => {
	const o = await run( null );
	assert.equal( o.root.result?.status, 'fulfilled', JSON.stringify( o.root.result ) );
	const [ green ] = facts( o, 'test_run' );
	assert.deepEqual( [ green.data.result, green.data.passed, green.data.of, green.data.commit ], [ 'green', CASES.length, CASES.length, commit ] );
	assert.equal( green.evidenceClass, 'observation' );
	// The fact names exactly the code that passed (by hash); the file itself lives only in the run's plan values.
	const sha = createHash( 'sha256' ).update( php( 'correct' ) ).digest( 'hex' ).slice( 0, 16 );
	assert.equal( green.data.code, sha );
	assert.equal( o.root.plan?.values?.code?.value?.code, php( 'correct' ) );
	assert.equal( coderCalls( o ).length, 1 );
	neverSawHiddenCases( o );
} );

test( '2 an eval calculator that would pass every case is refused before it runs and never counts as green', async () => {
	// The premise, checked outside the system: run bare, the eval shortcut passes every hidden case.
	const casesFile = path.join( process.env.TMPDIR || '/tmp', `cases-${process.pid}.json` );
	fs.writeFileSync( casesFile, JSON.stringify( CASES ) );
	const bare = spawnSync( 'php', [ '-n', path.join( HERE, 'fixtures/calculator/oracle.php' ), path.join( HERE, 'fixtures/calculator/eval.php' ), casesFile ], { encoding: 'utf8' } );
	fs.rmSync( casesFile, { force: true } );
	assert.deepEqual( JSON.parse( bare.stdout ), { failed: [], of: CASES.length } );

	const o = await run( { code: php( 'eval' ) } );
	assert.ok( o.finished, 'the run ended' );
	assert.notEqual( o.root.result?.status, 'fulfilled' );
	assert.equal( facts( o, 'test_run' ).filter( item => item.data?.result === 'green' ).length, 0, 'no green run' );
	// Every answer was eval, and every one was refused by the static check (a PermissionError at the eval line).
	const calls = coderCalls( o );
	assert.ok( calls.length >= 2, `the coder was asked ${calls.length} times` );
	const repairs = calls.map( heard ).filter( Boolean );
	assert.ok( repairs.length >= 1 );
	for ( const text of repairs ) { assert.equal( text, 'Your code raised PermissionError in line 9.' ); }
	neverSawHiddenCases( o );
} );

test( '3 a buggy first answer, then a fixed one, ends green; the repair names no hidden case', async () => {
	const o = await run( [ { code: php( 'buggy' ) }, { code: php( 'correct' ) } ] );
	assert.equal( o.root.result?.status, 'fulfilled', JSON.stringify( o.root.result ) );
	const calls = coderCalls( o );
	assert.equal( calls.length, 2 );
	assert.equal( heard( calls[ 0 ] ), null );
	// Exactly the count, in the core's words: no input, no expected value, no output of the code.
	assert.equal( heard( calls[ 1 ] ), `Your code failed 4 of ${CASES.length} cases.`, JSON.stringify( [ ...o.runner.nodes.values() ].flatMap( node => o.events( node, 'wall' ) ) ) );
	assert.equal( facts( o, 'test_run' ).filter( item => item.data?.result === 'green' ).length, 1 );
	neverSawHiddenCases( o );
} );

test( '4 code that loops forever is stopped by the frame, the run goes on and ends green after the repair', async () => {
	const o = await run( [ { code: php( 'loop' ) }, { code: php( 'correct' ) } ] );
	assert.equal( o.root.result?.status, 'fulfilled', JSON.stringify( o.root.result ) );
	assert.equal( heard( coderCalls( o )[ 1 ] ), 'Your code was not usable: it ran longer than its time limit.', JSON.stringify( [ ...o.runner.nodes.values() ].flatMap( node => o.events( node, 'wall' ) ) ) );
	assert.ok( o.seconds < 30, `took ${o.seconds}s` );
} );

test( '5 code that prints junk and forges result lines is stopped by the output cap; the run ends green after the repair', async () => {
	const o = await run( [ { code: php( 'junk' ) }, { code: php( 'correct' ) } ] );
	assert.equal( o.root.result?.status, 'fulfilled', JSON.stringify( o.root.result ) );
	assert.equal( heard( coderCalls( o )[ 1 ] ), 'Your code was not usable: it printed more than allowed.', JSON.stringify( [ ...o.runner.nodes.values() ].flatMap( node => o.events( node, 'wall' ) ) ) );
} );

test( '6 a shell call the static check cannot see (a callable string built at runtime) finds the function disabled', async () => {
	const o = await run( { code: php( 'hidden' ) } );
	assert.ok( o.finished, 'the run ended' );
	assert.notEqual( o.root.result?.status, 'fulfilled' );
	assert.equal( facts( o, 'test_run' ).filter( item => item.data?.result === 'green' ).length, 0 );
	for ( const text of coderCalls( o ).map( heard ).filter( Boolean ) ) { assert.equal( text, 'Your code raised NameError in line 6.' ); }
} );

// The live app does not read contract.json: POST /api/missions/:id/start drafts the goal from the task with the model
// role "contract" (Core.System.start). These two tests take that path, with a stub drafter, and a person who says yes to
// everything: what keeps the goal honest there is code (the strategies' fits, the mission's strategy gate), not them.
async function start( outcomes, { ms = 60000 } = {} ) {
	const mission = Mission.load( 'calculator' );
	mission.stub = { ...mission.stub, contract: { goal: 'Write the web team calculator', deadlineHours: 24, outcomes, notCovered: [],
		backTranslation: 'You want the calculator library.', coverage: [ { sentence: 'Write the web team calculator', criteria: [ 'k1' ] } ] } };
	const o = await office( { mission, approve: () => true, person: ticket => ( ticket.options.includes( 'yes' ) ? 'yes' : ticket.recommendation ?? ticket.options[ 0 ] ) } );
	const root = await o.system.start( mission );
	const until = Date.now() + ms;
	while ( !root.refused && root.state !== 'closed' && Date.now() < until ) { await wait( 25 ); }
	o.stop();
	return { o, root };
}

test( '7 live path: a drafted test_green must name the frozen suite and its commit; another commit is refused at G1', async () => {
	const wrong = await start( [ { type: 'test_green', values: { test: 'calculator-hidden', commit: 'deadbeefdeadbeef' } } ] );
	assert.equal( wrong.root.refused, true );
	assert.ok( wrong.root.problems.includes( 'k1: no strategy can achieve test_green' ), JSON.stringify( wrong.root.problems ) );
	const right = await start( [ { type: 'test_green', values: { test: 'calculator-hidden', commit } } ] );
	assert.equal( right.root.result?.status, 'fulfilled', JSON.stringify( right.root.result ) );
	assert.equal( right.root.facts.filter( item => item.kind === 'test_run' && item.data.result === 'green' ).length, 1 );
} );

test( '8 live path: a drafted goal a person could confirm carries the frozen suite anyway (K7) and closes only after it ran green', async () => {
	// The model drafts only document_present, which a person confirms (K4). The suite is prescribed for this kind of task
	// (mission.json "invariants", K7): code adds it to every drafted goal, immutable, so the person's yes alone closes
	// nothing; the mission's strategy gate (gates.json) keeps the confirmation behind the green run as well.
	const { o, root } = await start( [ { type: 'document_present', values: { kind: 'php library', ref: 'calculator.php' } } ] );
	assert.equal( root.result?.status, 'fulfilled', JSON.stringify( root.result ) );
	const suite = root.contract.criteria.find( item => item.type === 'test_green' );
	assert.deepEqual( [ suite?.values, suite?.immutable, suite?.origin ], [ { test: 'calculator-hidden', commit }, true, 'catalog' ] );
	const green = o.system.nodes().flatMap( node => node.facts ).find( item => item.kind === 'test_run' && item.data.result === 'green' );
	assert.ok( green, 'the frozen suite ran green' );
	const confirmed = root.facts.find( item => item.kind === 'confirmation' );
	assert.ok( !confirmed || Date.parse( confirmed.time ) >= Date.parse( green.time ), 'a person confirmed only after the green run' );
} );
