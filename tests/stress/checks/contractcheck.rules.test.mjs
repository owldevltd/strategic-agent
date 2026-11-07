// G1 (3.2, 3.3, 7.3, 14.2, 17): consistency of invariants (only tighten), the two layers of acceptance, the invariants
// the catalog prescribes (K7), feasibility (K8 budget), channels (K4), coverage of the goal (K5), amendments (G-10) and
// the child rules R3, R5 and R6, held against every ancestor.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { ContractCheck, Contract, Node, registry, contract, problems, survey, catalogs, REPORT, inHours } from './fixtures.mjs';

const SUBJECT = 'core/check/contractcheck.js';
const said = list => list.join( '; ' );
const MIN5 = { id: 'k2', type: 'min_group', values: { k: 5 }, immutable: true, origin: 'catalog' };
const rule = ( id, k, origin = 'client', extra = {} ) => ( { id, type: 'min_group', values: { k }, origin, ...extra } );

// Consistency: same rule, other values; the agent only ever tightens (7.3).
attacks( SUBJECT, [
	{ name: 'two group sizes of the same rule are consistent: the stricter one holds', criteria: [ rule( 'k2', 5 ), rule( 'k3', 7 ) ], expected: [] },
	{ name: 'the agent may tighten a rule of the catalog', criteria: [ MIN5, rule( 'a1', 9, 'agent' ) ], expected: [] },
	{ name: 'the agent may loosen nothing: a smaller group after the catalog\'s rule is refused', criteria: [ MIN5, rule( 'a1', 2, 'agent' ) ],
		expected: [ 'a1: the agent may only tighten k2, not loosen it' ] },
	{ name: 'the agent may add a rule of a new type', criteria: [ MIN5, { id: 'a1', type: 'no_difference', values: { k: 3 }, origin: 'agent' } ], expected: [] },
	// Rules are compared only when they are about the same thing (for account_from_master: the same parameter).
	{ name: 'two rules of a type without an order and other values contradict each other',
		criteria: [ { id: 'k2', type: 'account_from_master', values: { param: 'iban', kind: 'account' } },
			{ id: 'k3', type: 'account_from_master', values: { param: 'iban', kind: 'supplier' } } ],
		expected: [ 'k3: contradicts k2 (same rule, other values)' ] },
	{ name: 'two rules of a type about different things are two rules, no contradiction (exactly once per invoice, and per order)',
		criteria: [ { id: 'k2', type: 'exactly_once', values: { key: 'invoiceId', action: 'payment' } },
			{ id: 'k3', type: 'exactly_once', values: { key: 'orderId', action: 'payment' } },
			{ id: 'k4', type: 'account_from_master', values: { param: 'iban' } }, { id: 'k5', type: 'account_from_master', values: { param: 'account' } } ],
		expected: [] },
], ( item ) => {
	assert.deepEqual( problems( contract( {}, [ REPORT, ...item.criteria ] ) ), item.expected );
} );

attack( SUBJECT, 'the agent may loosen nothing, even when its looser rule comes first in the list', () => {
	const _list = problems( contract( {}, [ REPORT, rule( 'a1', 2, 'agent' ), MIN5 ] ) );
	assert.ok( _list.some( text => /a1: the agent may only tighten/.test( text ) ), said( _list ) );
} );

attack( SUBJECT, 'the same values in another key order are the same rule, no contradiction', () => {
	const _list = problems( contract( {}, [ REPORT, { id: 'k2', type: 'exactly_once', values: { key: 'invoiceId', action: 'payment' } },
		{ id: 'k3', type: 'exactly_once', values: { action: 'payment', key: 'invoiceId' } } ] ) );
	assert.deepEqual( _list, [] );
} );

// 3.3: layer 2 serves layer 1.
attacks( SUBJECT, [
	{ name: '3.3: an outcome of the agent that serves the client\'s outcome is accepted', serves: 'k1', ok: true },
	{ name: '3.3: an outcome of the agent that serves an invariant of the catalog is accepted', serves: 'k2', ok: true },
	{ name: '3.3: an outcome of the agent that serves nothing is refused', serves: undefined, ok: false },
	{ name: '3.3: an outcome of the agent that serves a criterion that does not exist is refused', serves: 'k9', ok: false },
	{ name: '3.3: an outcome of the agent that serves itself is refused', serves: 'a7', ok: false },
	{ name: '3.3: an outcome of the agent that serves another criterion of the agent is refused', serves: 'a8', ok: false },
], ( item ) => {
	const _agent = { id: 'a7', type: 'report_delivered', values: { to: 'qa', topic: 'tests' }, origin: 'agent', serves: item.serves };
	const _other = { id: 'a8', type: 'report_delivered', values: { to: 'qa', topic: 'more' }, origin: 'agent', serves: 'k1' };
	const _list = problems( contract( {}, [ REPORT, MIN5, _agent, _other ] ) );
	assert.equal( _list.includes( 'a7: a criterion of the agent must serve a criterion of the client (3.3)' ), !item.ok, said( _list ) );
} );

// K7: the invariants the catalog prescribes for this kind of process.
attacks( SUBJECT, [
	{ name: 'K7: a prescribed invariant that is missing is refused', criteria: [], ok: false },
	{ name: 'K7: a prescribed invariant that is not immutable is refused', criteria: [ { ...MIN5, immutable: false } ], ok: false },
	{ name: 'K7: a prescribed invariant made looser is refused', criteria: [ { ...MIN5, values: { k: 3 } } ], ok: false },
	{ name: 'K7: a prescribed invariant made stricter and immutable is accepted', criteria: [ { ...MIN5, values: { k: 8 } } ], ok: true },
	{ name: 'K7: the prescribed invariant exactly is accepted', criteria: [ MIN5 ], ok: true },
], ( item ) => {
	const _list = problems( contract( {}, [ REPORT, ...item.criteria ] ), { mandatory: [ { type: 'min_group', values: { k: 5 } } ] } );
	assert.equal( _list.includes( 'missing invariant of this kind of process: min_group {"k":5} (K7)' ), !item.ok, said( _list ) );
} );

// K7, 3.3, G-5: the process kind may prescribe an outcome too (a frozen suite that must be green), not only a rule.
const SUITE = { type: 'test_green', values: { test: 'calculator-hidden', commit: '501f0df1e2bdcaa2' } };
const GREEN = { id: 'k2', ...SUITE, origin: 'catalog', immutable: true };
attacks( SUBJECT, [
	{ name: 'K7: a prescribed outcome that is present and immutable is accepted', criteria: [ GREEN ], ok: true },
	{ name: 'K7: a prescribed outcome that is missing is refused (a drafted goal cannot leave the suite out)', criteria: [], ok: false },
	{ name: 'K7: a prescribed outcome that is not immutable is refused', criteria: [ { ...GREEN, immutable: false } ], ok: false },
	{ name: 'K7: a prescribed outcome on another suite is refused', criteria: [ { ...GREEN, values: { ...SUITE.values, test: 'my-own-tests' } } ], ok: false },
	{ name: 'K7: a prescribed outcome at another commit is refused', criteria: [ { ...GREEN, values: { ...SUITE.values, commit: 'ffffffffffffffff' } } ], ok: false },
	{ name: 'K7: a person\'s confirmation instead of the prescribed suite is refused', criteria: [ { id: 'k2', type: 'confirmed_by', values: { role: 'client', question: 'Is the calculator done?' } } ], ok: false },
], ( item ) => {
	const _list = problems( contract( {}, [ REPORT, ...item.criteria ] ), { mandatory: [ SUITE ] } );
	assert.equal( _list.includes( `missing invariant of this kind of process: test_green ${JSON.stringify( SUITE.values )} (K7)` ), !item.ok, said( _list ) );
} );

attack( SUBJECT, 'K7: a prescribed invariant of a type nobody can write is reported as missing', () => {
	assert.match( said( problems( contract(), { mandatory: [ { type: 'teleport', values: {} } ] } ) ), /missing invariant of this kind of process: teleport/ );
} );

// Feasibility: a way for every outcome, and a budget that reaches the cheapest (K8), for a kind of task that has ways.
const strategy = ( extra = {} ) => ( { id: 's', kind: 'survey', serves: 'report_delivered', price: 3, ...extra } );
attacks( SUBJECT, [
	{ name: 'K8: an outcome with a strategy that serves it is feasible', strategies: [ strategy() ], ok: true },
	{ name: 'K8: an outcome no strategy serves is refused', strategies: [ strategy( { serves: 'items_resolved' } ) ], problem: 'k1: no strategy can achieve report_delivered' },
	{ name: 'K8: a strategy of another kind of task does not count', strategies: [ strategy( { serves: 'items_resolved' } ), strategy( { kind: 'invoices' } ) ],
		problem: 'k1: no strategy can achieve report_delivered' },
	{ name: 'K8: a strategy for another intent does not count', strategies: [ strategy( { intents: [ 'pay' ] } ) ], problem: 'k1: no strategy can achieve report_delivered' },
	{ name: 'K8, 6.1: a kind with no strategy of its own yet is learned, not refused: its first goal proposes the ways',
		strategies: [ strategy( { kind: 'invoices' } ) ], ok: true },
	{ name: 'K8, 6.1: a kind with no strategy at all is learned too', strategies: [], ok: true },
	{ name: 'K8: a kindless strategy (one of the catalog for every kind) does not make a kind known', strategies: [ strategy( { kind: undefined, serves: 'x' } ) ], ok: true },
	{ name: 'K8: a strategy whose pattern does not fit the values does not count', strategies: [ strategy( { fits: { to: '^ceo$' } } ) ],
		problem: 'k1: no strategy can achieve report_delivered' },
	{ name: 'K8: a strategy whose pattern fits the values counts', strategies: [ strategy( { fits: { to: '^hr$' } } ) ], ok: true },
	{ name: 'K8: a strategy that reaches the type on the way counts', strategies: [ strategy( { serves: 'x', reaches: [ 'report_delivered' ] } ) ], ok: true },
	{ name: 'K8: a budget below the cheapest way is refused', strategies: [ strategy( { price: 30 } ) ], problem: 'k1: budget 20 is below the cheapest way (30)' },
	{ name: 'K8: a budget that just reaches the cheapest way is enough', strategies: [ strategy( { price: 20 } ), strategy( { price: 99 } ) ], ok: true },
	{ name: 'K8: a strategy without a price costs one unit', strategies: [ strategy( { price: undefined } ) ], ok: true },
], ( item ) => {
	const _list = problems( contract( { kind: 'survey', scope: { intent: 'report' } } ), { strategies: item.strategies } );
	assert.deepEqual( _list, item.ok ? [] : [ item.problem ] );
} );

attack( SUBJECT, 'K8: a goal without a kind is checked in full: no way, no goal', () => {
	assert.deepEqual( problems( contract(), { strategies: [] } ), [ 'k1: no strategy can achieve report_delivered' ] );
} );

attack( SUBJECT, 'K8: a criterion a person confirms is feasible through the strategy of asking the person', () => {
	const _list = problems( contract( {}, [ { ...REPORT, byPerson: true } ] ), { strategies: [ strategy( { serves: '@byPerson', kind: undefined } ) ] } );
	assert.deepEqual( _list, [] );
} );

attacks( SUBJECT, [ { name: 'NaN', budget: NaN }, { name: 'a word', budget: 'lots' }, { name: 'an object', budget: { amount: 100 } } ].map( item => ( {
	...item, name: `K8: a budget of ${item.name} reaches no strategy`,
} ) ), ( item ) => {
	assert.ok( problems( contract( { budget: item.budget } ), { strategies: [ strategy() ] } ).length > 0 );
} );

attack( SUBJECT, 'K8: a negative budget reaches no strategy', () => {
	// A negative budget is refused as an amount (K8) and reaches no strategy.
	assert.deepEqual( problems( contract( { budget: -1 } ), { strategies: [ strategy( { price: 0, kind: undefined } ) ] } ),
		[ 'budget must be a number of at least 0 (K8)', 'k1: budget -1 is below the cheapest way (0)' ] );
} );

// K4: a channel for the evidence of every outcome, else a person is the channel.
const meeting = { id: 'k1', type: 'event_occurred', values: { event: 'meeting:t-88', window: [ inHours( 10 ), inHours( 20 ) ] } };
attack( SUBJECT, 'K4: an outcome whose evidence no move of the catalog delivers is reported', () => {
	assert.deepEqual( problems( contract( {}, [ meeting ] ), { catalog: catalogs.survey() } ), [ 'k1: no channel delivers its evidence; a person must confirm it (K4)' ] );
} );

attack( SUBJECT, 'K4: an outcome a channel delivers needs no person', () => {
	assert.deepEqual( problems( contract(), { catalog: catalogs.survey() } ), [] );
} );

attack( SUBJECT, 'K4: channelled() makes a person the channel, says so in the back-translation, and G1 then accepts it', () => {
	const _drafted = contract( { understood: { backTranslation: 'You want a meeting.', notCovered: [], coverage: [ { sentence: 'x', criteria: [ 'k1' ] } ] } }, [ meeting ] );
	const _channelled = ContractCheck.channelled( _drafted, catalogs.survey(), registry );
	assert.equal( _channelled.criteria[ 0 ].byPerson, true );
	assert.deepEqual( _channelled.understood.confirmedByYou, [ 'k1' ] );
	assert.notEqual( _channelled.hash, _drafted.hash, 'the person confirms what changed' );
	assert.equal( _drafted.criteria[ 0 ].byPerson, false, 'the draft itself is not changed' );
	assert.deepEqual( ContractCheck.unchannelled( _channelled, catalogs.survey() ), [] );
} );

attack( SUBJECT, 'K4: a goal every channel can deliver comes back from channelled() unchanged', () => {
	const _goal = contract();
	assert.equal( ContractCheck.channelled( _goal, catalogs.survey(), registry ), _goal );
} );

// K5: every sentence of the effect is covered by layer 1 or listed as not covered.
const GOAL = 'Report the morale of the design team to HR. Keep every single answer anonymous.';
const drafted = ( coverage, notCovered = [], criteria = [ REPORT, MIN5 ] ) => contract( {
	goal: GOAL, understood: { coverage, notCovered },
}, criteria );
attacks( SUBJECT, [
	{ name: 'K5: two sentences, each covered by a criterion of layer 1, pass', coverage: [ { sentence: 'Report the morale of the design team to HR', criteria: [ 'k1' ] },
		{ sentence: 'Keep every single answer anonymous.', criteria: [ 'k2' ] } ], uncovered: [] },
	{ name: 'K5: a sentence neither covered nor listed is refused', coverage: [ { sentence: 'Report the morale of the design team to HR', criteria: [ 'k1' ] } ],
		uncovered: [ 'Keep every single answer anonymous' ] },
	{ name: 'K5: a sentence listed as not covered passes', coverage: [ { sentence: 'Report the morale of the design team to HR', criteria: [ 'k1' ] } ],
		notCovered: [ 'Keep every single answer anonymous: not measurable' ], uncovered: [] },
	{ name: 'K5: an entry that only contains the sentence inside a longer one does not list it', coverage: [ { sentence: 'Report the morale of the design team to HR',
		criteria: [ 'k1' ] } ], notCovered: [ 'Keep every single answer anonymously stored for a year: not measurable' ],
	uncovered: [ 'Keep every single answer anonymous' ] },
	{ name: 'K5: coverage by index (1, 2) means k1, k2', coverage: [ { sentence: 'Report the morale of the design team to HR', criteria: [ '1' ] },
		{ sentence: 'Keep every single answer anonymous', criteria: [ ' 2 ' ] } ], uncovered: [] },
	{ name: 'K5: a clause of at least four words covers its sentence', coverage: [ { sentence: 'the morale of the design team', criteria: [ 'k1' ] },
		{ sentence: 'every single answer anonymous', criteria: [ 'k2' ] } ], uncovered: [] },
	{ name: 'K5: a clause of three words covers nothing', coverage: [ { sentence: 'Report the morale', criteria: [ 'k1' ] },
		{ sentence: 'Keep every single answer anonymous', criteria: [ 'k2' ] } ], uncovered: [ 'Report the morale of the design team to HR' ] },
	{ name: 'K5: a sentence covered by a criterion that does not exist is not covered', coverage: [ { sentence: 'Report the morale of the design team to HR',
		criteria: [ 'k1' ] }, { sentence: 'Keep every single answer anonymous', criteria: [ 'k7' ] } ], uncovered: [ 'Keep every single answer anonymous' ] },
], ( item ) => {
	const _list = problems( drafted( item.coverage, item.notCovered ) );
	assert.deepEqual( _list, item.uncovered.map( sentence => `"${sentence}" is neither covered by a criterion nor listed as not covered (K5)` ) );
} );

attack( SUBJECT, 'K5: a sentence covered only by a criterion of the agent is not covered', () => {
	const _agent = { id: 'a1', type: 'report_delivered', values: { to: 'qa', topic: 'x' }, origin: 'agent', serves: 'k1' };
	const _list = problems( drafted( [ { sentence: 'Report the morale of the design team to HR', criteria: [ 'k1' ] },
		{ sentence: 'Keep every single answer anonymous', criteria: [ 'a1' ] } ], [], [ REPORT, MIN5, _agent ] ) );
	assert.deepEqual( _list, [ '"Keep every single answer anonymous" is neither covered by a criterion nor listed as not covered (K5)' ] );
} );

attack( SUBJECT, 'K5: a goal that was not drafted has no back-translation to hold it against', () => {
	assert.deepEqual( problems( contract( { goal: GOAL } ) ), [] );
} );

attack( SUBJECT, 'K5: a coverage that is no list is refused with a problem, not a crash', () => {
	const _list = problems( contract( { goal: GOAL, understood: { coverage: 'all of it', notCovered: 'nothing' } } ) );
	assert.ok( _list.length > 0 );
} );

// G-10: amendments.
attacks( SUBJECT, [
	{ name: 'G-10: changing a mutable criterion changes no immutable one', change: { criterion: 'k1', values: { topic: 'first findings' } }, expected: [] },
	{ name: 'G-10: changing the deadline changes no immutable criterion', change: { deadline: inHours( 72 ) }, expected: [] },
	{ name: 'G-10: changing an immutable criterion is refused', change: { criterion: 'k2', values: { k: 2 } }, expected: [ 'immutable criterion k2 would change (G-10)' ] },
	{ name: 'G-10: making an immutable criterion stricter is a change too', change: { criterion: 'k2', values: { k: 9 } },
		expected: [ 'immutable criterion k2 would change (G-10)' ] },
], ( item ) => {
	const _before = survey();
	const _after = new Contract( _before.amend( item.change ), registry );
	assert.deepEqual( ContractCheck.amendment( _before, _after ), item.expected );
} );

attack( SUBJECT, 'G-10: dropping an immutable criterion is refused; adding one is not', () => {
	const _before = survey();
	const _dropped = new Contract( { ..._before.spec, criteria: _before.spec.criteria.filter( item => item.id !== 'k3' ) }, registry );
	assert.deepEqual( ContractCheck.amendment( _before, _dropped ), [ 'immutable criterion k3 would change (G-10)' ] );
	const _added = new Contract( { ..._before.spec, criteria: [ ..._before.spec.criteria, { id: 'k4', type: 'sum_max', values: { max: 1 }, immutable: true } ] }, registry );
	assert.deepEqual( ContractCheck.amendment( _before, _added ), [] );
} );

// Children (17): R3, R5, R6 and the invariants of every ancestor.
const parent = survey( { id: 'p', deadline: inHours( 48 ) } );
const grand = contract( { id: 'g', goal: 'Improve the morale of the whole company', deadline: inHours( 96 ) },
	[ { id: 'k1', type: 'report_delivered', values: { to: 'board', topic: 'morale' } }, MIN5, { id: 'k5', type: 'sum_max', values: { max: 100 }, immutable: true } ] );
const ANSWERS = { id: 'c1', type: 'number_in_range', values: { quantity: 'answers:design', min: 5 }, origin: 'client' };
const child = ( extra = {}, criteria = [ ANSWERS, MIN5, { ...MIN5, id: 'k3', type: 'no_difference' } ] ) => new Contract( {
	id: 'p/answers', goal: 'Get enough answers from the design team', deadline: inHours( 24 ), budget: 5, serves: { criterion: 'k1', precondition: 'answers' },
	criteria, ...extra,
}, registry );
const g1 = ( given, options = {} ) => new ContractCheck().check( given, { ancestors: [ parent ], ...options } );

attack( SUBJECT, 'a child that serves its parent, finishes earlier and keeps every invariant is accepted', () => {
	assert.deepEqual( g1( child() ), { gate: 'G1', ok: true, problems: [], questions: [] } );
} );

attacks( SUBJECT, [
	{ name: 'R6: a child that serves a criterion its parent does not have is refused', extra: { serves: { criterion: 'k9', precondition: 'x' } } },
	{ name: 'R6: a child that names nothing it serves is refused', extra: { serves: null } },
], ( item ) => {
	assert.ok( g1( child( item.extra ) ).problems.includes( 'child must serve an existing criterion of its parent (R6)' ) );
} );

attacks( SUBJECT, [
	{ name: 'R3: a child due later than its parent is refused', minutes: 60, ok: false },
	{ name: 'R3: a child due inside the buffer before its parent is refused', minutes: -4, ok: false },
	{ name: 'R3: a child due exactly one buffer before its parent is accepted', minutes: -5, ok: true },
], ( item ) => {
	const _deadline = new Date( Date.parse( parent.deadline ) + item.minutes * 60000 ).toISOString();
	assert.equal( g1( child( { deadline: _deadline } ) ).problems.includes( 'child must finish before its parent, with buffer (R3)' ), !item.ok );
} );

attack( SUBJECT, 'R3: no buffer setting lets a child finish after its parent', () => {
	const _late = child( { deadline: new Date( Date.parse( parent.deadline ) + 30 * 60000 ).toISOString() } );
	for ( const bufferMinutes of [ -60, NaN ] ) {
		assert.ok( g1( _late, { bufferMinutes } ).problems.includes( 'child must finish before its parent, with buffer (R3)' ), String( bufferMinutes ) );
	}
} );

attack( SUBJECT, 'a child that drops an invariant of its parent is refused, naming the parent', () => {
	assert.deepEqual( g1( child( {}, [ ANSWERS, MIN5 ] ) ).problems, [ 'child drops invariant no_difference of p' ] );
} );

attack( SUBJECT, 'a child is held against every ancestor: an invariant of the grandparent may not be dropped either', () => {
	const _list = new ContractCheck().check( child(), { ancestors: [ grand, parent ] } ).problems;
	assert.ok( _list.includes( 'child drops invariant sum_max of g' ), said( _list ) );
} );

attack( SUBJECT, 'R5: a child that restates an outcome of its parent is refused', () => {
	const _list = g1( child( {}, [ { ...REPORT, id: 'c1' }, MIN5, { ...MIN5, id: 'k3', type: 'no_difference' } ] ) ).problems;
	assert.ok( _list.includes( 'child restates outcome k1 of p (R5)' ), said( _list ) );
} );

attack( SUBJECT, 'R5: a restated outcome is found even with its values in another key order', () => {
	const _restated = { id: 'c1', type: 'report_delivered', values: { topic: 'morale', to: 'hr' }, origin: 'client' };
	const _list = g1( child( {}, [ _restated, MIN5, { ...MIN5, id: 'k3', type: 'no_difference' } ] ) ).problems;
	assert.ok( _list.includes( 'child restates outcome k1 of p (R5)' ), said( _list ) );
} );

attacks( SUBJECT, [
	{ name: 'R5: a child with the very goal of its parent is a question, not a refusal', goal: 'Report the morale of the design team to HR', asked: true },
	{ name: 'R5: seven of ten words in common are a question', goal: 'a b c d e f g', parentGoal: 'a b c d e f g h i j', asked: true },
	{ name: 'R5: six of ten words in common are no question', goal: 'a b c d e f', parentGoal: 'a b c d e f g h i j', asked: false },
	{ name: 'R5: a goal in other case and with punctuation is the same goal', goal: 'REPORT the morale, of the design team -- to HR!', asked: true },
], ( item ) => {
	const _parent = item.parentGoal ? survey( { id: 'p', deadline: inHours( 48 ), goal: item.parentGoal } ) : parent;
	const _result = new ContractCheck().check( child( { goal: item.goal } ), { ancestors: [ _parent ] } );
	assert.equal( _result.ok, true, said( _result.problems ) );
	assert.equal( _result.questions.some( text => /the goal resembles/.test( text ) ), item.asked );
} );

attack( SUBJECT, 'R5: an outcome of the same type with nearly the same values is a question to the parent', () => {
	const _near = { id: 'c1', type: 'report_delivered', values: { to: 'hr', topic: 'morale today' }, origin: 'client' };
	const _result = g1( child( {}, [ _near, MIN5, { ...MIN5, id: 'k3', type: 'no_difference' } ] ) );
	assert.deepEqual( _result.questions, [ 'c1 resembles outcome k1 of p (R5)' ] );
} );

// R6 against the parent node itself.
const PRE = { id: 'answers', type: 'number_in_range', values: { quantity: 'answers:design', min: 5 } };
const parentNode = ( { wall = true, met = false, done = false } = {} ) => {
	const _node = new Node( { contract: parent } );
	if ( wall ) { _node.hitWall( 'precondition_missing', [], { precondition: PRE } ); }
	if ( met ) { _node.addFact( { kind: 'precondition_met', evidenceClass: 'observation', origin: 'child', source: 'child', data: { id: 'answers' } } ); }
	if ( done ) { _node.addFact( { kind: 'delivered', evidenceClass: 'observation', origin: 'gate', source: 'gate', data: { action: 'report', to: 'hr' } } ); }
	return _node;
};
attacks( SUBJECT, [
	{ name: 'R6: a child that expresses exactly the precondition its parent named is accepted', node: {}, criteria: [ ANSWERS ], expected: [] },
	{ name: 'R6: a child with a weaker form of the precondition is refused', node: {}, criteria: [ { ...ANSWERS, values: { quantity: 'answers:design', min: 3 } } ],
		expected: [ 'the child\'s outcomes do not express exactly precondition answers (R6)' ] },
	{ name: 'R6: a child with the precondition and one more outcome is refused', node: {}, criteria: [ ANSWERS, { ...REPORT, id: 'c2', values: { to: 'x', topic: 'y' } } ],
		expected: [ 'the child\'s outcomes do not express exactly precondition answers (R6)' ] },
	{ name: 'R6, R8: a precondition already met in the parent is refused', node: { met: true }, criteria: [ ANSWERS ],
		expected: [ 'precondition answers is already met in the parent (R6, R8)' ] },
	{ name: 'R6: serving a criterion that is no longer open in the parent is refused', node: { done: true }, criteria: [ ANSWERS ],
		expected: [ 'child serves k1, which is not open in its parent (R6)' ] },
], ( item ) => {
	assert.deepEqual( ContractCheck.contribution( child( {}, item.criteria ), parentNode( item.node ) ), item.expected );
} );

attack( SUBJECT, 'R6: a child from a template expresses a part of the criterion it serves: a subset of each list, the rest equal', () => {
	const _invoices = contract( { id: 'inv' }, [ { id: 'k1', type: 'items_resolved', values: { collection: 'invoices', items: [ 'R-1', 'R-2' ], outcomes: [ 'paid', 'escalated' ] } } ] );
	const _node = new Node( { contract: _invoices } );
	const _part = values => ContractCheck.contribution( child( { serves: { criterion: 'k1', precondition: 'R-1' } },
		[ { id: 'c1', type: 'items_resolved', values, origin: 'client' } ] ), _node );
	assert.deepEqual( _part( { collection: 'invoices', items: [ 'R-1' ], outcomes: [ 'paid', 'escalated' ] } ), [] );
	assert.equal( _part( { collection: 'invoices', items: [ 'R-9' ], outcomes: [ 'paid' ] } ).length, 1, 'an item the parent does not have' );
	assert.equal( _part( { collection: 'invoices', items: [], outcomes: [ 'paid' ] } ).length, 1, 'an empty part is no part' );
	assert.equal( _part( { collection: 'payroll', items: [ 'R-1' ], outcomes: [ 'paid' ] } ).length, 1, 'another collection' );
} );

attack( SUBJECT, 'R6: without a parent node or without serves nothing is held against the parent', () => {
	assert.deepEqual( ContractCheck.contribution( child(), null ), [] );
	assert.deepEqual( ContractCheck.contribution( child( { serves: null } ), parentNode() ), [] );
} );
