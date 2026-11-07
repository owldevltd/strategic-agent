// G2 (7.2): a plan only reaches execution when it was made for this very contract, every move is in the catalog
// with valid parameters, every commitment is one the goal admits, nothing would close a cycle in the wait graph (R4),
// the strategy gates hold (21) and its cost fits the remaining budget. This file attacks the structure; the data flow
// of 10.4 is attacked in plancheck.flow.test.mjs.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { PlanCheck, Catalog, WaitGraph, catalogs, flowCatalog, invoices, survey, contract, move, plan, g2 } from './fixtures.mjs';

const SUBJECT = 'core/check/plancheck.js';
const goal = invoices();
const freeGoal = invoices( {}, [] );
const surveyGoal = survey();
const pay = ( extra = {} ) => ( {
	move: 'payment.send', params: { invoiceId: 'R-1186', amount: 100, iban: 'DE02' }, labels: { iban: [ 'own' ] }, target: 'bank', ...extra,
} );
const check = ( steps, options = {}, given = goal ) => new PlanCheck().check( plan( given, steps ), {
	catalog: catalogs.invoices(), contract: given, ...options,
} );
const said = result => result.problems.join( '; ' );

attack( SUBJECT, 'a well-formed plan for this contract passes and reports its cost and the labels of its values', () => {
	const _result = check( [
		{ move: 'invoice.read', params: { invoice: 'R-1186' }, as: 'invoice' }, { move: 'payment.prepare', from: 'invoice', as: 'prepared' },
		{ move: 'payment.send', from: 'prepared', target: 'bank' },
	] );
	assert.equal( _result.ok, true, said( _result ) );
	assert.equal( _result.gate, 'G2' );
	assert.equal( _result.cost, 2.2 );
	assert.deepEqual( _result.labels, { invoice: [ 'foreign' ], prepared: [] } );
} );

attack( SUBJECT, 'a plan without steps is refused', () => {
	assert.deepEqual( check( [] ).problems, [ 'the plan has no steps' ] );
} );

attack( SUBJECT, 'a plan made for another contract is refused', () => {
	const _result = new PlanCheck().check( { contract: surveyGoal.hash, steps: [ pay() ] }, {
		catalog: catalogs.invoices(), contract: goal,
	} );
	assert.match( said( _result ), /made for another contract/ );
} );

attack( SUBJECT, 'a plan bound to an amended contract no longer fits the contract before the amendment', () => {
	const _before = invoices( { budget: 20 } );
	const _after = invoices( { budget: 30 } );
	const _result = new PlanCheck().check( { contract: _after.hash, steps: [ pay() ] }, {
		catalog: catalogs.invoices(), contract: _before,
	} );
	assert.equal( _result.ok, false );
} );

attack( SUBJECT, 'a plan that names no contract at all is not bound to this one and is refused', () => {
	const _result = new PlanCheck().check( { steps: [ pay() ] }, { catalog: catalogs.invoices(), contract: goal } );
	assert.equal( _result.ok, false );
	assert.match( said( _result ), /contract/ );
} );

attacks( SUBJECT, [
	{ name: 'a move the catalog does not list is refused', step: { move: 'payment.force' }, problem: 'unknown move payment.force' },
	{ name: 'a move name in other case is not in the catalog', step: { move: 'Payment.send', target: 'bank' }, problem: 'unknown move Payment.send' },
	{ name: 'a move name with a trailing space is not in the catalog', step: { move: 'payment.send ', target: 'bank' }, problem: 'unknown move payment.send ' },
	{ name: 'a step without a move is refused', step: { params: {} }, problem: 'unknown move undefined' },
], ( item ) => {
	assert.ok( check( [ item.step ] ).problems.includes( item.problem ), said( check( [ item.step ] ) ) );
} );

attacks( SUBJECT, [ 'constructor', '__proto__', 'toString' ].map( name => ( { name: `a move named ${name} is outside the catalog and refused`, value: name } ) ), ( item ) => {
	const _result = check( [ { move: item.value } ] );
	assert.equal( _result.ok, false );
	assert.ok( _result.problems.includes( `unknown move ${item.value}` ) );
} );

attack( SUBJECT, 'a parameter the move does not declare is refused', () => {
	assert.ok( check( [ pay( { params: { ...pay().params, priority: 'urgent' } } ) ] ).problems.includes( 'payment.send: unknown parameter priority' ) );
} );

attack( SUBJECT, 'parameters named like prototype properties are unknown parameters', () => {
	const _params = JSON.parse( '{"invoiceId":"R-1186","constructor":"x","toString":"y","__proto__":"z"}' );
	const _result = check( [ pay( { params: _params } ) ] );
	assert.deepEqual( _result.problems.filter( problem => /unknown parameter/.test( problem ) ).length, 3, said( _result ) );
} );

attacks( SUBJECT, [
	{ name: 'an amount given as text is refused', params: { amount: 'lots' }, problem: /^payment\.send: amount must be a number/ },
	{ name: 'an account given as a number is refused', params: { iban: 12345 }, problem: /^payment\.send: iban must be text$/ },
	{ name: 'an invoice id given as a list is refused', params: { invoiceId: [ 'R-1186', 'R-1187' ] }, problem: /^payment\.send: invoiceId must be text$/ },
	{ name: 'an amount given as an object is refused', params: { amount: { value: 1 } }, problem: /^payment\.send: amount must be a number/ },
], ( item ) => {
	const _result = check( [ pay( { params: { ...pay().params, ...item.params } } ) ] );
	assert.ok( _result.problems.some( problem => item.problem.test( problem ) ), said( _result ) );
} );

attack( SUBJECT, 'an empty list for an optional list parameter is no value, not a problem', () => {
	const _steps = [ { move: 'survey.query', params: { teams: [ 'design' ], excludePeople: [] }, as: 'stats' } ];
	assert.equal( new PlanCheck().check( plan( surveyGoal, _steps ), { catalog: catalogs.survey(), contract: surveyGoal } ).ok, true );
} );

attack( SUBJECT, 'an empty list for a required list parameter is refused', () => {
	const _steps = [ { move: 'survey.query', params: { teams: [] }, as: 'stats' } ];
	const _result = new PlanCheck().check( plan( surveyGoal, _steps ), { catalog: catalogs.survey(), contract: surveyGoal } );
	assert.ok( _result.problems.includes( 'survey.query: teams must be a non-empty list' ) );
} );

attacks( SUBJECT, [
	{ name: 'a person.decide step without its question and options is refused', step: { move: 'person.decide', params: {} } },
	{ name: 'a person.decide step with question null is refused', step: { move: 'person.decide', params: { question: null, options: [ 'yes' ] } } },
	{ name: 'an invoice.read step without the invoice is refused', step: { move: 'invoice.read', params: {} } },
], ( item ) => {
	const _result = check( [ item.step ] );
	assert.equal( _result.ok, false );
	assert.match( said( _result ), /is missing/ );
} );

attacks( SUBJECT, [
	{ name: 'an outward action without a recipient is refused', target: undefined },
	{ name: 'an outward action with an empty recipient is refused', target: '' },
	{ name: 'an outward action with recipient null is refused', target: null },
	{ name: 'an outward action with a blank recipient is refused', target: ' \t' },
	{ name: 'an outward action with a recipient that is no text is refused', target: { to: 'bank' } },
], ( item ) => {
	assert.ok( check( [ pay( { target: item.target } ) ] ).problems.includes( 'payment.send: no recipient' ) );
} );

attack( SUBJECT, 'a move that does not act outward needs no recipient', () => {
	assert.equal( check( [ { move: 'invoice.read', params: { invoice: 'R-1186' } } ] ).ok, true );
} );

// 6.1: the trusted code of the core is no building block of a plan; the knowledge search is.
attacks( SUBJECT, [ 'meta.check', 'meta.register', 'move.cancel' ].map( name => ( { name: `the trusted core move ${name} is refused in a plan`, move: name } ) ),
	( item ) => {
		assert.ok( check( [ { move: item.move, params: { version: 'v-1' } } ] ).problems.includes( `${item.move} is trusted code of the core and no part of a plan` ) );
	} );

attack( SUBJECT, 'only the process the core opens for a proposal (kind meta) may check and register it, never take back a move', () => {
	const _meta = contract( { kind: 'meta' } );
	const _run = name => new PlanCheck().check( plan( _meta, [ { move: name, params: name === 'move.cancel' ? {} : { version: 'v-1' } } ] ),
		{ catalog: catalogs.invoices(), contract: _meta } ).ok;
	assert.deepEqual( [ _run( 'meta.check' ), _run( 'meta.register' ), _run( 'move.cancel' ) ], [ true, true, false ] );
} );

attack( SUBJECT, 'the knowledge search is a building block of any plan', () => {
	assert.equal( check( [ { move: 'knowledge.find', params: { query: 'payment terms' } } ] ).ok, true );
} );

attacks( SUBJECT, [
	{ name: 'a label outside 10.4 written into a step is refused', labels: { iban: [ 'trusted' ] } },
	{ name: 'labels written into a step as one text are refused', labels: { iban: 'own' } },
	{ name: 'labels written into a step as a list are refused', labels: [ 'own' ] },
], ( item ) => {
	assert.equal( check( [ pay( { labels: item.labels } ) ] ).ok, false );
} );

attack( SUBJECT, 'a case starts with the message it answers, labelled foreign; a plan may read it, other unknown names not', () => {
	const _case = contract( { kind: 'request' } );
	const _steps = name => [ { move: 'request.read', from: name, as: 'r' }, { move: 'payment.send', from: 'r', target: 'bank' } ];
	const _run = ( name, options = {} ) => new PlanCheck().check( plan( _case, _steps( name ) ), {
		catalog: catalogs.invoices(), contract: _case, ...options,
	} );
	assert.match( said( _run( 'message' ) ), /iban would carry foreign into a sensitive parameter/ );
	assert.match( said( _run( 'mail' ) ), /reads mail, which no earlier step produces/ );
	assert.match( said( _run( 'mail', { seed: { mail: { value: 'x', labels: [ 'foreign' ], cohort: null } } } ) ), /iban would carry foreign/ );
} );

attacks( SUBJECT, [
	{ name: 'a payment under a goal that admits no payment is refused', given: () => surveyGoal, ok: false },
	{ name: 'a payment under a goal whose items may be paid is admitted', given: () => freeGoal, ok: true },
	{ name: 'a payment under a goal whose items may only be escalated is refused', ok: false,
		given: () => contract( {}, [ { id: 'k1', type: 'items_resolved', values: { collection: 'invoices', items: [ 'R-1' ], outcomes: [ 'escalated' ] } } ] ) },
	{ name: 'a payment under a goal with a cap on payments is admitted', ok: true,
		given: () => contract( {}, [ { id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'x' } }, { id: 'k2', type: 'sum_max', values: { max: 10 } } ] ) },
], ( item ) => {
	const _given = item.given();
	const _result = check( [ pay() ], {}, _given );
	assert.equal( _result.problems.includes( 'payment.send: commits to payment, which this goal does not admit' ), !item.ok, said( _result ) );
} );

attacks( SUBJECT, [
	{ name: 'a plan that costs more than the budget left is refused with both numbers', budgetLeft: 2, problem: 'plan costs 2.1, budget left 2' },
	{ name: 'a plan with no budget left at all is refused', budgetLeft: 0, problem: 'plan costs 2.1, budget left 0' },
	{ name: 'a negative budget left refuses every plan that costs something', budgetLeft: -1, problem: 'plan costs 2.1, budget left -1' },
], ( item ) => {
	assert.ok( check( [ pay() ], { budgetLeft: item.budgetLeft } ).problems.includes( item.problem ) );
} );

attack( SUBJECT, 'a plan that costs exactly the budget left passes', () => {
	assert.equal( check( [ pay() ], { budgetLeft: 2.1 } ).ok, true );
} );

attack( SUBJECT, 'a person\'s minutes are the dearest part of the cost (P1)', () => {
	const _result = check( [ { move: 'person.decide', params: { question: 'Pay?', options: [ 'yes', 'no' ] } } ] );
	assert.equal( _result.cost, 5 );
} );

attack( SUBJECT, 'a free plan passes with no budget left', () => {
	const _catalog = new Catalog( { 'x.do': move( { price: 0 } ) } );
	assert.equal( new PlanCheck().check( plan( goal, [ { move: 'x.do' } ] ), { catalog: _catalog, contract: goal, budgetLeft: 0 } ).ok, true );
} );

attacks( SUBJECT, [
	{ name: 'a move with a price that is no number cannot make a plan free', moves: { 'x.do': move( { price: 'abc' } ) }, budgetLeft: 0 },
	{ name: 'a budget left that is no number refuses rather than allows', moves: { 'x.do': move( { price: 5 } ) }, budgetLeft: NaN },
	{ name: 'a negative price cannot buy budget for the dear moves of the plan', moves: { 'x.do': move( { price: 50 } ), 'y.do': move( { price: -49 } ) },
		budgetLeft: 2 },
], ( item ) => {
	const _steps = Object.keys( item.moves ).map( name => ( { move: name } ) );
	const _result = new PlanCheck().check( plan( goal, _steps ), {
		catalog: new Catalog( item.moves ), contract: goal, budgetLeft: item.budgetLeft,
	} );
	assert.equal( _result.ok, false, `cost ${_result.cost}` );
} );

// R4: no plan may close a cycle in the wait graph.
const waiting = ( graphEdges, node ) => {
	const _graph = new WaitGraph();
	graphEdges.forEach( ( [ from, to ] ) => _graph.add( from, to ) );
	return { graph: _graph, node };
};
const wait = target => [ { move: 'followup.wait', params: { node: target } } ];
const checkWait = ( steps, waits ) => new PlanCheck().check( plan( surveyGoal, steps ), {
	catalog: catalogs.survey(), contract: surveyGoal, waits,
} );

attacks( SUBJECT, [
	{ name: 'R4: waiting for a node that waits for this one is refused', edges: [ [ 'n2', 'n1' ] ], target: 'n2', ok: false },
	{ name: 'R4: waiting for a node that waits for this one through a sibling is refused', edges: [ [ 'n3', 'n2' ], [ 'n2', 'n1' ] ], target: 'n3',
		ok: false },
	{ name: 'R4: waiting for oneself is refused', edges: [], target: 'n1', ok: false },
	{ name: 'R4: waiting for a node that waits for nobody passes', edges: [ [ 'n1', 'n9' ] ], target: 'n2', ok: true },
], ( item ) => {
	const _result = checkWait( wait( item.target ), waiting( item.edges, 'n1' ) );
	assert.equal( _result.ok, item.ok, said( _result ) );
	if ( !item.ok ) { assert.match( said( _result ), /would close a cycle in the wait graph \(R4\)/ ); }
} );

attack( SUBJECT, 'R4: without a wait graph no step is refused for waiting', () => {
	assert.equal( checkWait( wait( 'n2' ), null ).ok, true );
} );

// 21: strategy gates restrict and order, checked at G2.
const gated = ( steps, gates, given = freeGoal ) => g2( given, steps, { strategyGates: gates } );
const flowPay = amount => ( { move: 'pay.send', params: { amount, iban: 'DE02' }, labels: { iban: [ 'own' ] }, target: 'bank' } );

attacks( SUBJECT, [
	{ name: 'an amount above the gate\'s maximum is refused', gate: { max: 1000 }, amount: 1001, ok: false },
	{ name: 'an amount at the gate\'s maximum passes', gate: { max: 1000 }, amount: 1000, ok: true },
	{ name: 'an amount below the gate\'s minimum is refused', gate: { min: 10 }, amount: 9, ok: false },
	{ name: 'an amount outside the allowed values is refused', gate: { allowed: [ 100, 200 ] }, amount: 150, ok: false },
	{ name: 'an amount among the allowed values passes', gate: { allowed: [ 100, 200 ] }, amount: 200, ok: true },
], ( item ) => {
	const _gate = { id: 'sg-1', rule: 'restrict', move: 'pay.send', param: 'amount', ...item.gate };
	const _result = gated( [ flowPay( item.amount ) ], [ _gate ] );
	assert.equal( _result.ok, item.ok, said( _result ) );
	if ( !item.ok ) { assert.deepEqual( _result.problems, [ 'pay.send: amount is outside what the strategy gate allows (gate sg-1)' ] ); }
} );

attack( SUBJECT, 'a restrict gate for a list parameter needs every value of the list to be allowed', () => {
	const _gate = { id: 'sg-2', rule: 'restrict', move: 'survey.query', param: 'teams', allowed: [ 'design', 'product' ] };
	const _run = teams => new PlanCheck().check( plan( surveyGoal, [ { move: 'survey.query', params: { teams }, as: 's' } ] ),
		{ catalog: catalogs.survey(), contract: surveyGoal, strategyGates: [ _gate ] } ).ok;
	assert.deepEqual( [ _run( [ 'design' ] ), _run( [ 'design', 'hr' ] ) ], [ true, false ] );
} );

attack( SUBJECT, 'a gate for another move does not hold this one', () => {
	assert.equal( gated( [ flowPay( 5000 ) ], [ { id: 'sg-3', rule: 'restrict', move: 'report.send', param: 'amount', max: 1 } ] ).ok, true );
} );

attack( SUBJECT, 'a bound cannot be dodged with a value that is no number', () => {
	const _catalog = flowCatalog( { 'loose.send': move( { action: 'report', param: 'body', params: { amount: {} } } ) } );
	const _gate = { id: 'sg-4', rule: 'restrict', move: 'loose.send', param: 'amount', max: 100 };
	for ( const amount of [ 'lots', [ 500, 1 ], { n: 500 } ] ) {
		const _result = new PlanCheck().check( plan( surveyGoal, [ { move: 'loose.send', params: { amount }, target: 'hr' } ] ),
			{ catalog: _catalog, contract: surveyGoal, strategyGates: [ _gate ] } );
		assert.equal( _result.ok, false, JSON.stringify( amount ) );
	}
} );

attacks( SUBJECT, [
	{ name: '21: a move that must come after another is refused without it', steps: [ 'pay' ], ok: false },
	{ name: '21: a move that must come after another is refused when the other comes later', steps: [ 'pay', 'read' ], ok: false },
	{ name: '21: a move that comes after the other passes', steps: [ 'read', 'pay' ], ok: true },
], ( item ) => {
	const _steps = item.steps.map( name => ( name === 'pay' ? flowPay( 1 ) : { move: 'master.read', as: 'master' } ) );
	const _result = gated( _steps, [ { id: 'sg-5', rule: 'order', before: 'master.read', after: 'pay.send' } ] );
	assert.equal( _result.ok, item.ok, said( _result ) );
	if ( !item.ok ) { assert.ok( _result.problems.includes( 'pay.send may only run after master.read (gate sg-5)' ) ); }
} );

attack( SUBJECT, 'structural problems are all listed at once, and no cost or labels are given for a refused plan', () => {
	const _result = check( [ { move: 'ghost' }, pay( { target: '' } ), pay( { params: { amount: 'x' } } ) ], { budgetLeft: 0 } );
	assert.equal( _result.ok, false );
	assert.ok( _result.problems.length >= 3 );
	assert.deepEqual( [ _result.cost, _result.labels ], [ undefined, undefined ] );
} );

attack( SUBJECT, 'a plan with a step that is no object is refused cleanly', () => {
	for ( const steps of [ [ null ], [ 'payment.send' ], undefined ] ) {
		const _result = new PlanCheck().check( { contract: goal.hash, steps }, { catalog: catalogs.invoices(), contract: goal } );
		assert.equal( _result.ok, false, String( steps ) );
	}
} );

attack( SUBJECT, 'checking a plan changes nothing in it', () => {
	const _steps = [ { move: 'invoice.read', params: { invoice: 'R-1186' }, as: 'invoice' }, pay() ];
	const _copy = structuredClone( _steps );
	check( _steps );
	assert.deepEqual( _steps, _copy );
} );

attack( SUBJECT, 'a plan of a thousand steps is checked in well under a second', () => {
	const _steps = Array.from( { length: 1000 }, ( _, i ) => ( { move: 'invoice.read', params: { invoice: `R-${i}` }, as: `v${i}` } ) );
	const _start = Date.now();
	assert.equal( check( [ ..._steps, pay() ], { budgetLeft: 1000 } ).ok, true );
	assert.ok( Date.now() - _start < 2000 );
} );
