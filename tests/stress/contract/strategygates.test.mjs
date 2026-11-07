// core/gates/strategygates.js, part 1: how instances come into force (7.3, 21). The agent may add an instance or
// tighten one, never loosen or remove it; a system gate compares before and after. Every way to loosen (dropping a
// bound, widening the allowed values, replacing the rule, changing the scope, swapping what a precondition measures)
// must be refused, and an order no strategy keeps is paralysis from the start.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { registry, StrategyGates, memoryDb, catalogOf, survey } from './fixtures.mjs';

const SUBJECT = 'core/gates/strategygates.js';
const NOW = Date.parse( '2026-11-04T12:00:00Z' );
const DAY = 86400000;
const store = ( log = null ) => new StrategyGates( memoryDb(), { now: () => NOW, log } );
const known = { scope: 'hr-survey', registry, catalog: catalogOf( survey ), strategies: survey.strategies };
const at = days => new Date( NOW + days * DAY ).toISOString();
const RESTRICT = { rule: 'restrict', move: 'analysis.run', param: 'teams', allowed: [ 'design', 'product' ], expires: at( 30 ) };
const PRECONDITION = { rule: 'precondition', move: 'report.send', criterion: { type: 'number_in_range', values: { quantity: 'answers:design', min: 5 } }, expires: at( 30 ) };

attack( SUBJECT, 'an unknown rule template is refused', () => {
	assert.deepEqual( store().propose( { rule: 'allow_all', move: 'report.send' }, known ).problems, [ 'allow_all is not a rule template' ] );
} );

attacks( SUBJECT, [ '__proto__', 'constructor', 'toString' ].map( rule => ( { name: `a rule named ${rule} is refused as no template, not a crash`, rule } ) ), ( { rule } ) => {
	const _result = store().propose( { rule, move: 'report.send', expires: at( 1 ) }, known );
	assert.deepEqual( _result, { ok: false, problems: [ `${rule} is not a rule template` ] } );
} );

attacks( SUBJECT, [
	{ name: 'a precondition without a move is refused', instance: { ...PRECONDITION, move: undefined }, problem: 'precondition needs move' },
	{ name: 'a precondition without a criterion is refused', instance: { ...PRECONDITION, criterion: undefined }, problem: 'precondition needs criterion' },
	{ name: 'a restrict without a move is refused', instance: { ...RESTRICT, move: '' }, problem: 'restrict needs move' },
	{ name: 'a restrict without a parameter is refused', instance: { ...RESTRICT, param: undefined }, problem: 'restrict needs param' },
	{ name: 'an order without its first move is refused', instance: { rule: 'order', after: 'report.send' }, problem: 'order needs before' },
	{ name: 'an order without its later move is refused', instance: { rule: 'order', before: 'report.draft' }, problem: 'order needs after' },
	{ name: 'a restrict without allowed values or a bound is refused', instance: { ...RESTRICT, allowed: undefined }, problem: 'restrict needs allowed values or a bound' },
	{ name: 'an expiry in the past is refused', instance: { ...RESTRICT, expires: at( -1 ) }, problem: 'an instance needs an expiry in the future' },
	{ name: 'an expiry of exactly now is refused', instance: { ...RESTRICT, expires: at( 0 ) }, problem: 'an instance needs an expiry in the future' },
	{ name: 'an expiry that is no date is refused', instance: { ...RESTRICT, expires: 'never' }, problem: 'an instance needs an expiry in the future' },
	{ name: 'a precondition with a type the registry does not know is refused', instance: { ...PRECONDITION, criterion: { type: 'mood_good', values: {} } },
		problem: 'mood_good is no criterion type' },
], ( { instance, problem } ) => {
	const _result = store().propose( instance, known );
	assert.equal( _result.ok, false );
	assert.ok( _result.problems.includes( problem ), _result.problems.join( '; ' ) );
} );

attack( SUBJECT, 'a precondition naming an Object.prototype member as its type is refused', () => {
	const _result = store().propose( { ...PRECONDITION, criterion: { type: 'constructor', values: {} } }, known );
	assert.equal( _result.ok, false );
} );

attack( SUBJECT, 'without an expiry an instance lasts 180 days', () => {
	const _store = store();
	_store.propose( { ...RESTRICT, expires: undefined }, known );
	assert.equal( _store.active( 'hr-survey' )[ 0 ].expires, at( 180 ) );
} );

attack( SUBJECT, 'an instance about moves the catalog does not know is refused for each of them', () => {
	const _result = store().propose( { rule: 'order', before: 'bribe.hr', after: 'leak.data', expires: at( 1 ) }, known );
	assert.deepEqual( _result.problems, [ 'bribe.hr is not a move of the catalog', 'leak.data is not a move of the catalog' ] );
} );

attack( SUBJECT, 'an order no strategy of the kind keeps would paralyse it from the start', () => {
	const _result = store().propose( { rule: 'order', before: 'report.send', after: 'analysis.write' }, known );
	assert.match( _result.problems.join(), /no strategy of this kind runs analysis.write after report.send/ );
} );

attack( SUBJECT, 'an order the strategies keep is accepted', () => {
	assert.equal( store().propose( { rule: 'order', before: 'analysis.write', after: 'analysis.run' }, known ).ok, true );
} );

attack( SUBJECT, 'an order whose later move no strategy uses paralyses nothing', () => {
	assert.equal( store().propose( { rule: 'order', before: 'report.draft', after: 'reply.send' }, known ).ok, true );
} );

attack( SUBJECT, 'an order kept by one strategy of the kind is no paralysis, even if others break it', () => {
	assert.equal( store().propose( { rule: 'order', before: 'survey.coverage', after: 'report.send' }, known ).ok, true );
} );

attack( SUBJECT, 'paralysis counts only the strategies of this kind', () => {
	const _foreign = survey.strategies.map( item => ( { ...item, kind: 'supplier-payments' } ) );
	assert.equal( store().propose( { rule: 'order', before: 'report.send', after: 'analysis.write' }, { ...known, strategies: _foreign } ).ok, true );
} );

// A precondition that only the blocked move can bring about: seen live, a model drafting a coding goal proposed "write
// the code only once the tests are green" for its kind of task; it would have held every such goal for 180 days.
const CODE = { scope: 'code-new-php', registry, catalog: { get: name => ( [ 'calc.write', 'calc.test', 'person.confirm', 'spec.read' ].includes( name ) ? {} : null ) } };
const GREEN = { type: 'test_green', values: { test: 'calculator-hidden', commit: '501f0df1e2bdcaa2' } };
const way = ( id, moves, extra = {} ) => ( { id, kind: 'code-new-php', serves: 'test_green', steps: moves.map( move => ( { move } ) ), ...extra } );
attacks( SUBJECT, [
	{ name: 'R4: a precondition every way to which runs the blocked move would wait for itself: refused',
		strategies: [ way( 'write-and-test', [ 'spec.read', 'calc.write', 'calc.test' ] ), way( 'write-again', [ 'calc.write', 'calc.test' ] ) ], ok: false },
	{ name: 'R4: one way to the precondition without the blocked move is enough: accepted',
		strategies: [ way( 'write-and-test', [ 'calc.write', 'calc.test' ] ), way( 'test-only', [ 'calc.test' ] ) ], ok: true },
	{ name: 'R4: blocking another move than the one that brings the precondition about is accepted (confirm only once green)',
		strategies: [ way( 'write-and-test', [ 'calc.write', 'calc.test' ] ) ], move: 'person.confirm', ok: true },
	{ name: 'R4: ways of another kind of task do not count', strategies: [ way( 'write-and-test', [ 'calc.write' ], { kind: 'other-kind' } ) ], ok: true },
	{ name: 'R4: no way to the precondition at all is no cycle of this gate', strategies: [], ok: true },
], ( { strategies, move = 'calc.write', ok } ) => {
	const _result = store().propose( { rule: 'precondition', move, criterion: GREEN }, { ...CODE, strategies } );
	assert.equal( _result.ok, ok, _result.problems.join( '; ' ) );
	if ( !ok ) { assert.match( _result.problems.join(), /every strategy that reaches test_green runs calc\.write; the gate would wait for itself \(R4\)/ ); }
} );

attack( SUBJECT, 'a new instance is in force with its scope, expiry and author', () => {
	const _store = store();
	const _result = _store.propose( RESTRICT, known );
	const [ _active ] = _store.active( 'hr-survey' );
	assert.deepEqual( [ _active.id, _active.scope, _active.expires, _active.by, _active.allowed ], [ _result.id, 'hr-survey', at( 30 ), 'agent', RESTRICT.allowed ] );
} );

attack( SUBJECT, 'an instance cannot set its own id, scope or author', () => {
	const _store = store();
	_store.propose( { ...RESTRICT, id: 'sg-mine', scope: '*', by: 'person' }, known );
	const [ _active ] = _store.active( 'hr-survey' );
	assert.deepEqual( [ _active.scope, _active.by ], [ 'hr-survey', 'agent' ] );
	assert.notEqual( _active.id, 'sg-mine' );
	assert.deepEqual( _store.active( 'supplier-payments' ), [] );
} );

// Tightening: the system gate compares the new instance with the one in force.
const TIGHTEN = [
	{ name: 'dropping the allowed values for a bound is loosening', before: RESTRICT, after: { ...RESTRICT, allowed: undefined, max: 2 }, ok: false },
	{ name: 'allowing one more value is loosening', before: RESTRICT, after: { ...RESTRICT, allowed: [ 'design', 'product', 'sales' ] }, ok: false },
	{ name: 'allowing other values is loosening', before: RESTRICT, after: { ...RESTRICT, allowed: [ 'sales' ] }, ok: false },
	{ name: 'allowing fewer values is tightening', before: RESTRICT, after: { ...RESTRICT, allowed: [ 'design' ] }, ok: true },
	{ name: 'allowing no value at all is tightening', before: RESTRICT, after: { ...RESTRICT, allowed: [] }, ok: true },
	{ name: 'the same allowed values again are accepted', before: RESTRICT, after: RESTRICT, ok: true },
	{ name: 'raising the upper bound is loosening', before: { ...RESTRICT, allowed: undefined, max: 5 }, after: { ...RESTRICT, allowed: undefined, max: 6 }, ok: false },
	{ name: 'dropping the upper bound for a lower one is loosening', before: { ...RESTRICT, allowed: undefined, max: 5 }, after: { ...RESTRICT, allowed: undefined, min: 1 }, ok: false },
	{ name: 'an upper bound of NaN is loosening', before: { ...RESTRICT, allowed: undefined, max: 5 }, after: { ...RESTRICT, allowed: undefined, max: Number.NaN }, ok: false },
	{ name: 'lowering the upper bound is tightening', before: { ...RESTRICT, allowed: undefined, max: 5 }, after: { ...RESTRICT, allowed: undefined, max: 4 }, ok: true },
	{ name: 'lowering the lower bound is loosening', before: { ...RESTRICT, allowed: undefined, min: 3 }, after: { ...RESTRICT, allowed: undefined, min: 2 }, ok: false },
	{ name: 'dropping the lower bound for an upper one is loosening', before: { ...RESTRICT, allowed: undefined, min: 3 }, after: { ...RESTRICT, allowed: undefined, max: 9 }, ok: false },
	{ name: 'raising the lower bound is tightening', before: { ...RESTRICT, allowed: undefined, min: 3 }, after: { ...RESTRICT, allowed: undefined, min: 4 }, ok: true },
	{ name: 'ending earlier than the instance in force is loosening', before: RESTRICT, after: { ...RESTRICT, expires: at( 10 ) }, ok: false },
	{ name: 'lasting longer than the instance in force is tightening', before: RESTRICT, after: { ...RESTRICT, expires: at( 300 ) }, ok: true },
	{ name: 'a weaker precondition is loosening', before: PRECONDITION, after: { ...PRECONDITION, criterion: { type: 'number_in_range', values: { quantity: 'answers:design', min: 3 } } }, ok: false },
	{ name: 'a stricter precondition is tightening', before: PRECONDITION, after: { ...PRECONDITION, criterion: { type: 'number_in_range', values: { quantity: 'answers:design', min: 7 } } }, ok: true },
	{ name: 'an upper limit added to a precondition is tightening', before: PRECONDITION, after: { ...PRECONDITION, criterion: { type: 'number_in_range', values: { quantity: 'answers:design', min: 5, max: 40 } } }, ok: true },
];
attacks( SUBJECT, TIGHTEN, ( { before, after, ok } ) => {
	const _store = store();
	assert.equal( _store.propose( before, known ).ok, true );
	const _result = _store.propose( after, known );
	assert.equal( _result.ok, ok, _result.problems.join( '; ' ) );
	if ( !ok ) {
		assert.match( _result.problems.join(), /the agent may only tighten \(21\)/ );
		assert.deepEqual( _store.active( 'hr-survey' ).map( item => item.expires ), [ before.expires ], 'the instance in force stays' );
	}
} );

attack( SUBJECT, 'tightening replaces the instance in force; the old one is kept as tightened', () => {
	const _store = store();
	const _first = _store.propose( RESTRICT, known );
	const _second = _store.propose( { ...RESTRICT, allowed: [ 'design' ] }, known );
	assert.deepEqual( _store.active( 'hr-survey' ).map( item => item.id ), [ _second.id ] );
	assert.equal( _store.db.get( 'SELECT status FROM strategy_gates WHERE id = :id', { id: _first.id } ).status, 'tightened' );
} );

attack( SUBJECT, 'a bound given as text still compares as a number', () => {
	const _store = store();
	_store.propose( { ...RESTRICT, allowed: undefined, max: 5 }, known );
	assert.equal( _store.propose( { ...RESTRICT, allowed: undefined, max: '9' }, known ).ok, false );
	assert.equal( _store.propose( { ...RESTRICT, allowed: undefined, max: '3' }, known ).ok, true );
} );

attack( SUBJECT, 'a precondition that measures another quantity is no tightening', () => {
	const _store = store();
	_store.propose( PRECONDITION, known );
	const _swapped = { ...PRECONDITION, criterion: { type: 'number_in_range', values: { quantity: 'answers:nobody', min: 5 } } };
	assert.equal( _store.propose( _swapped, known ).ok, false );
	assert.equal( _store.active( 'hr-survey' )[ 0 ].criterion.values.quantity, 'answers:design' );
} );

attack( SUBJECT, 'tightening a global instance for one kind leaves it in force for every other kind', () => {
	const _store = store();
	_store.propose( RESTRICT, { ...known, scope: '*' } );
	assert.equal( _store.propose( { ...RESTRICT, allowed: [ 'design' ] }, known ).ok, true );
	assert.deepEqual( _store.active( 'supplier-payments' ).map( item => item.allowed ), [ [ 'design', 'product' ] ] );
} );

attack( SUBJECT, 'an order cannot replace a restrict instance that happens to share its key', () => {
	const _store = store();
	// A restrict on a "parameter" the move does not have is refused outright; and the keys of two templates never meet.
	const _crafted = { rule: 'restrict', move: 'report.draft', param: 'report.send', max: 1, expires: at( 30 ) };
	assert.match( _store.propose( _crafted, known ).problems.join(), /report.send is no parameter of report.draft/ );
	const _order = { rule: 'order', before: 'report.draft', after: 'report.send', expires: at( 60 ) };
	assert.notEqual( StrategyGates.key( _crafted ), StrategyGates.key( _order ) );
	assert.equal( _store.propose( _order, known ).ok, true );
	assert.deepEqual( _store.active( 'hr-survey' ).map( item => item.rule ), [ 'order' ] );
} );

attack( SUBJECT, 'a looser instance for another kind is a new instance there and leaves this kind untouched', () => {
	const _store = store();
	_store.propose( RESTRICT, known );
	assert.equal( _store.propose( { ...RESTRICT, allowed: [ 'everyone' ] }, { ...known, scope: 'supplier-payments', strategies: null } ).ok, true );
	assert.deepEqual( _store.active( 'hr-survey' ).map( item => item.allowed ), [ RESTRICT.allowed ] );
} );

attack( SUBJECT, 'a global instance holds for every kind; a looser one for a single kind is refused', () => {
	const _store = store();
	_store.propose( RESTRICT, { ...known, scope: '*' } );
	assert.equal( _store.active( 'supplier-payments' ).length, 1 );
	assert.equal( _store.propose( { ...RESTRICT, allowed: [ 'everyone' ] }, known ).ok, false );
} );

attack( SUBJECT, 'additions, tightenings and refusals are logged with who proposed them', () => {
	const _events = [];
	const _store = store( { append: ( kind, data ) => _events.push( { kind, data } ) } );
	_store.propose( RESTRICT, known );
	_store.propose( { ...RESTRICT, allowed: [ 'design' ] }, known );
	_store.propose( { ...RESTRICT, allowed: [ 'everyone' ] }, known );
	assert.deepEqual( _events.map( event => [ event.kind, event.data.by ] ), [
		[ 'strategy_gate_added', 'agent' ], [ 'strategy_gate_tightened', 'agent' ], [ 'strategy_gate_refused', 'agent' ],
	] );
} );
