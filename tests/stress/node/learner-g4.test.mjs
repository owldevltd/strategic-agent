// core/learn/learner.js under attack, part 2: the model's proposals through G4 into the lessons (4.1 step 6, 7.2 G4,
// 9.3, G-9). What fits the schema is written with the lesson; everything else is refused and goes to a person later.
import assert from 'node:assert/strict';
import { attack, attacks, hostile, within } from '../hostile.mjs';
import { app, node, scripted, Learner, Journal, Db } from './kit.mjs';

const S = 'core/learn/learner.js';
const [ Closing, Memory, Causes, Diagnosis, Runner ] = await app.use( [ 'Core.Loop.Closing', 'Core.Memory.Memory', 'Core.Move.Causes',
	'Core.Strategy.Diagnosis', 'Core.Loop.Runner' ] );

// A closing node with three ended attempts (two walls, one done) and a model that answers with proposals.
function closing( answer ) {
	const _db = new Db( ':memory:' );
	const _journal = new Journal( _db );
	const _asked = [];
	const _model = scripted( answer );
	const runner = {
		id: 'run-1', journal: _journal, memory: new Memory( _db ), causes: Causes.load(), diagnosis: Diagnosis.load(),
		mission: { kind: 'survey', strategies: [ { id: 'mail' }, { id: 'call' }, { id: 'wait' } ] },
		learner: new Learner( { provider: _model } ),
		within: ( ...args ) => Runner.prototype.within.apply( { stateMinutes: {} }, args ),
		executor: { board: { ask: async ( item, ticket ) => _asked.push( ticket ) } },
	};
	const _node = node();
	const _ids = [ [ 'mail', 'wall', 'no_reaction' ], [ 'call', 'wall', 'not_reached' ], [ 'wait', 'done', null ] ].map( ( [ strategy, outcome, cause ] ) => {
		const _id = _journal.start( _node, { id: strategy }, { wall: null } );
		_journal.end( _id, { outcome, cause } );
		return _id;
	} );
	const _closing = new Closing( runner );
	const _lessons = () => _db.all( 'SELECT data FROM lessons ORDER BY attempt' ).map( row => JSON.parse( row.data ) );
	return { runner, node: _node, ids: _ids, closing: _closing, asked: _asked, model: _model, lessons: _lessons, db: _db };
}

// The closing learns; then what G4 refused goes to a person.
async function learn( answer, ms = 1000 ) {
	const _c = closing( typeof answer === 'function' ? answer : () => answer );
	await within( _c.closing.learn( _c.node, ms ), ms + 2000, 'learning' );
	_c.closing._suggest( _c.node );
	return _c;
}

const g4 = item => item.node.log.of( 'check' ).filter( check => check.gate === 'G4' && check.proposal );

attack( S, 'G4: a proposal that fits the schema is written with the lesson of its attempt', async () => {
	const _c = await learn( request => ( { proposals: [ { attempt: request.input.attempts[ 0 ].attempt, hypothesis: 'too_early' } ] } ) );
	const _mail = _c.lessons().find( item => item.attempt === _c.ids[ 0 ] );
	assert.equal( _mail.hypothesis, 'too_early' );
	assert.deepEqual( g4( _c ).map( check => check.ok ), [ true ] );
	assert.deepEqual( _c.asked, [] );
	assert.equal( _c.lessons().length, 3, 'every attempt has its lesson' );
} );

attack( S, 'G4: every attempt still gets its lesson when the model proposes nothing', async () => {
	const _c = await learn( { proposals: [] } );
	assert.deepEqual( _c.lessons().map( item => item.strategy ), [ 'mail', 'call', 'wait' ] );
	assert.ok( _c.lessons().every( item => !( 'hypothesis' in item ) ) );
	assert.equal( _c.node.lessonWritten, true );
} );

const refusals = [
	{ name: 'G4: a proposal for an attempt of another node is refused and goes to a person', proposal: () => ( { attempt: 999, hypothesis: 'too_early' } ), why: /no attempt of this node/ },
	{ name: 'G4: a hypothesis the wall does not stand for is refused', proposal: ids => ( { attempt: ids[ 0 ], hypothesis: 'wrong_way' } ), why: /not a hypothesis of the wall no_reaction/ },
	{ name: 'G4: a hypothesis for an attempt that hit no wall is refused', proposal: ids => ( { attempt: ids[ 2 ], hypothesis: 'too_early' } ), why: /not a hypothesis of the wall null/ },
	{ name: 'G4: a proposal that sets the result is refused: results are observed by code', proposal: ids => ( { attempt: ids[ 0 ], result: 'fulfilled' } ), why: /result is observed by code/ },
	{ name: 'G4: a proposal that sets the contribution is refused (L4 is code)', proposal: ids => ( { attempt: ids[ 0 ], contribution: [ 'k1' ] } ), why: /contribution is observed by code/ },
	{ name: 'G4: a proposal that rewrites the situation is refused', proposal: ids => ( { attempt: ids[ 1 ], situation: { contact: 'ceo' } } ), why: /situation is observed by code/ },
	{ name: 'G4: a proposal that carries a rule is refused (G-9)', proposal: ids => ( { attempt: ids[ 0 ], hypothesis: 'too_early', accept: 'KW 48' } ), why: /accept is not part of a lesson/ },
	{ name: 'G4: a proposal that tries to lift a gate is refused (G-9)', proposal: ids => ( { attempt: ids[ 0 ], gate: { lift: 'sg-1' } } ), why: /gate is not part of a lesson/ },
	{ name: 'G4: a proposal that tries to change the goal is refused (G-9)', proposal: ids => ( { attempt: ids[ 0 ], goal: 'pay every invoice' } ), why: /goal is not part of a lesson/ },
	{ name: 'G4: a proposal with a __proto__ key is refused and pollutes nothing', proposal: ids => JSON.parse( `{"attempt":${ids[ 0 ]},"__proto__":{"admin":true}}` ), why: /__proto__ is not part of a lesson/ },
	{ name: 'G4: a hypothesis that is empty is refused', proposal: ids => ( { attempt: ids[ 0 ], hypothesis: null } ), why: /not a hypothesis/ },
];

attacks( S, refusals, async ( { proposal, why } ) => {
	const _c = await learn( request => ( { proposals: [ proposal( request.input.attempts.map( item => item.attempt ) ) ] } ) );
	assert.equal( _c.asked.length, 1, 'a person sees the refused proposal (7.2: "Vorschlag ins Ticket")' );
	assert.match( _c.asked[ 0 ].question, why );
	assert.deepEqual( [ _c.asked[ 0 ].kind, _c.asked[ 0 ].reason ], [ 'suggestion', 'G4' ] );
	assert.ok( _c.lessons().every( item => !( 'hypothesis' in item ) && !( 'accept' in item ) && !( 'gate' in item ) ) );
	assert.equal( _c.lessons().length, 3, 'the code\'s lessons are written anyway' );
	assert.equal( ( {} ).admin, undefined );
} );

attacks( S, hostile( 'strings' ).filter( item => /Ignore|SYSTEM|script|DROP|\$\{/.test( item.value ) ).map( item => ( {
	...item, name: `G4: the hypothesis ${item.label} is no hypothesis of the wall and is never written`,
} ) ), async ( { value } ) => {
	const _c = await learn( request => ( { proposals: [ { attempt: request.input.attempts[ 0 ].attempt, hypothesis: value } ] } ) );
	assert.ok( !JSON.stringify( _c.lessons() ).includes( value ) );
	assert.equal( _c.asked.length, 1 );
	assert.deepEqual( g4( _c ).map( check => check.ok ), [ false ] );
} );

attacks( S, [ true, [ 1 ], '1' ].map( value => ( {
	name: `G4: a proposal for the attempt ${JSON.stringify( value )}, which is no number, is refused, not written to attempt 1`, value,
} ) ), async ( { value } ) => {
	const _c = await learn( { proposals: [ { attempt: value, hypothesis: 'too_early' } ] } );
	assert.equal( _c.ids[ 0 ], 1 );
	assert.equal( _c.lessons().find( item => item.attempt === 1 ).hypothesis, undefined, 'the step contract asks for a number' );
} );

attack( S, 'G4: proposals for several attempts are judged one by one; the good one is written, the bad one refused', async () => {
	const _c = await learn( ( request ) => {
		const [ _mail, _call ] = request.input.attempts.map( item => item.attempt );
		return { proposals: [ { attempt: _mail, hypothesis: 'not_reached' }, { attempt: _call, hypothesis: 'too_early' } ] };
	} );
	assert.equal( _c.lessons().find( item => item.strategy === 'mail' ).hypothesis, 'not_reached' );
	assert.equal( _c.lessons().find( item => item.strategy === 'call' ).hypothesis, undefined );
	assert.deepEqual( g4( _c ).map( check => check.ok ), [ true, false ] );
} );

attack( S, 'G4: a proposal with only an attempt adds nothing and is no reason for a ticket', async () => {
	const _c = await learn( request => ( { proposals: [ { attempt: request.input.attempts[ 0 ].attempt } ] } ) );
	assert.deepEqual( _c.asked, [] );
	assert.equal( _c.lessons().length, 3 );
} );

attack( S, 'Z2: a model that never answers does not hold the closing past its time; the lessons are written without it', async () => {
	const _started = Date.now();
	const _c = await learn( () => new Promise( () => {} ), 150 );
	assert.ok( Date.now() - _started < 5000, 'far less than the model\'s endless wait' );
	assert.equal( _c.lessons().length, 3 );
	assert.ok( _c.node.facts.some( fact => fact.kind === 'timeout' && fact.data.state === 'closing' ) );
} );

attack( S, 'a model that breaks down while learning leaves the lessons of code intact', async () => {
	const _c = await learn( () => {
		throw new Error( 'model crashed' );
	} );
	assert.deepEqual( [ _c.lessons().length, _c.asked.length ], [ 3, 0 ] );
} );

attack( S, '9.3: a node that learns twice writes each lesson once and asks the model once', async () => {
	const _c = closing( { proposals: [] } );
	await _c.closing.learn( _c.node, 1000 );
	await _c.closing.learn( _c.node, 1000 );
	_c.node.lessonWritten = false;
	await _c.closing.learn( _c.node, 1000 );
	assert.equal( _c.db.get( 'SELECT COUNT(*) AS n FROM lessons' ).n, 3 );
	assert.equal( _c.model.calls.length, 1, 'the third pass had no lesson left to ask about' );
} );

attack( S, 'a flood of five hundred refused proposals does not hold the closing up', async () => {
	const _many = Array.from( { length: 500 }, ( _, i ) => ( { attempt: 1000 + i, hypothesis: 'too_early' } ) );
	const _started = Date.now();
	const _c = await learn( { proposals: _many } );
	assert.ok( Date.now() - _started < 10000 );
	assert.equal( _c.lessons().length, 3 );
	assert.equal( _c.node.refusedProposals.length, 0, 'handed to the board and cleared' );
} );

attack( S, 'G-9: whatever the model proposes, a lesson has only the fields of 20.1', async () => {
	const _c = await learn( request => ( { proposals: request.input.attempts.map( item => ( { attempt: item.attempt, hypothesis: 'too_early', weight: 1e9 } ) ) } ) );
	const _fields = [ 'attempt', 'strategy', 'situation', 'result', 'provisional', 'signalAfterH', 'observationEnds', 'cause', 'hypothesis',
		'contribution', 'contractSuccess', 'evidence' ];
	assert.ok( _c.lessons().every( item => Object.keys( item ).every( key => _fields.includes( key ) ) ) );
	assert.equal( _c.asked.length, 1, 'the refused proposals of one node go to a person as one suggestion (7.2)' );
	assert.equal( _c.asked[ 0 ].question.match( /G4 refused/g ).length, 3, 'naming each of the three' );
} );
