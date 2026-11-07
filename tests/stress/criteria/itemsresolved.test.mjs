// core/criteria/itemsresolved.js: every item of a collection ends in an allowed outcome, proven per item by a gate
// receipt or an answered ticket. Attacks: weak evidence classes, malformed facts, outcomes outside the list,
// hostile item ids, the payment it admits.
import { DEADLINE, assert, attack, attacks, fact, hostile, make, shift } from './kit.mjs';
import { outcomeSuite } from './suites.mjs';

const S = 'core/criteria/itemsresolved.js';
const VALUES = { collection: 'invoices', items: [ 'r-1', 'r-2' ], outcomes: [ 'paid', 'escalated' ] };
const resolved = ( item, outcome = 'paid', evidenceClass = 'observation', extra = {} ) => fact( 'item_resolved', { item, outcome, about: item, value: outcome }, evidenceClass, extra );
const check = ( facts, values = VALUES ) => make( 'items_resolved', values ).check( facts );

outcomeSuite( S, {
	type: 'items_resolved', values: VALUES, refused: [ 'derivation', 'claim' ],
	good: () => [ resolved( 'r-1' ), resolved( 'r-2', 'escalated', 'confirmation' ) ],
} );

attack( S, 'every item resolved: met, one piece of evidence per item, in item order', () => {
	const [ _b, _a ] = [ resolved( 'r-2' ), resolved( 'r-1' ) ];
	assert.deepEqual( check( [ _b, _a ] ), { met: true, evidence: [ _a.id, _b.id ], reason: '' } );
} );

attack( S, 'one item open: the reason names it', () => {
	assert.deepEqual( check( [ resolved( 'r-1' ) ] ).reason, 'open: r-2' );
} );

attack( S, 'all items open: the reason names them all', () => {
	assert.equal( check( [] ).reason, 'open: r-1, r-2' );
} );

attack( S, 'an outcome outside the allowed ones leaves the item open', () => {
	assert.equal( check( [ resolved( 'r-1' ), resolved( 'r-2', 'ignored' ) ] ).met, false );
} );

attack( S, 'an allowed outcome in another case is another outcome', () => {
	assert.equal( check( [ resolved( 'r-1' ), resolved( 'r-2', 'Paid' ) ] ).met, false );
} );

attack( S, 'a later allowed outcome resolves an item an earlier disallowed one did not', () => {
	assert.equal( check( [ resolved( 'r-1' ), resolved( 'r-2', 'ignored' ), resolved( 'r-2', 'escalated' ) ] ).met, true );
} );

attack( S, 'a gate receipt (observation) and a person\'s answer (confirmation) both resolve an item', () => {
	assert.equal( check( [ resolved( 'r-1', 'paid', 'observation' ), resolved( 'r-2', 'escalated', 'confirmation' ) ] ).met, true );
} );

attack( S, 'the agent\'s claim that an invoice is paid resolves nothing', () => {
	assert.equal( check( [ resolved( 'r-1', 'paid', 'claim' ), resolved( 'r-2' ) ] ).met, false );
} );

attack( S, 'one malformed fact among good ones does not stop the verdict', () => {
	const _broken = { id: 'x', kind: 'item_resolved', evidenceClass: 'observation', time: '2026-11-05T10:00:00Z' };
	assert.equal( check( [ _broken, resolved( 'r-1' ), resolved( 'r-2' ) ] ).met, true );
} );

attack( S, 'one fact cannot resolve two items', () => {
	assert.equal( check( [ resolved( 'r-1' ) ], { ...VALUES, items: [ 'r-1', 'r-1x' ] } ).met, false );
} );

attack( S, 'a fact about another collection\'s item does not resolve this one', () => {
	assert.equal( check( [ resolved( 'r-1' ), resolved( 'R-2' ) ] ).met, false );
} );

attack( S, 'the ticket answer of person.decide (executor shape) resolves its item', () => {
	const _answer = item => fact( 'item_resolved', { item, outcome: 'escalated', choice: 'escalate', about: item, value: 'escalated' }, 'confirmation', { source: 'person lead' } );
	assert.equal( check( [ _answer( 'r-1' ), _answer( 'r-2' ) ] ).met, true );
} );

attack( S, 'E5: a superseded "paid" no longer resolves; its successor must be allowed itself', () => {
	const _old = resolved( 'r-2', 'paid', 'observation', { superseded: true } );
	assert.equal( check( [ resolved( 'r-1' ), _old, resolved( 'r-2', 'refunded' ) ] ).met, false );
	assert.equal( check( [ resolved( 'r-1' ), _old, resolved( 'r-2', 'escalated' ) ] ).met, true );
} );

attack( S, 'a resolution after the criterion\'s deadline does not count', () => {
	const _late = resolved( 'r-2', 'paid', 'observation', { time: shift( DEADLINE, 1 ) } );
	assert.equal( make( 'items_resolved', VALUES, { deadline: DEADLINE } ).check( [ resolved( 'r-1' ), _late ] ).met, false );
} );

attack( S, 'five hundred items, all resolved, are checked quickly', () => {
	const _items = Array.from( { length: 500 }, ( _x, i ) => `r-${i}` );
	const _start = Date.now();
	assert.equal( check( _items.map( item => resolved( item ) ), { ...VALUES, items: _items } ).met, true );
	assert.ok( Date.now() - _start < 1000 );
} );

attack( S, 'five hundred items with one open: exactly that one is named', () => {
	const _items = Array.from( { length: 500 }, ( _x, i ) => `r-${i}` );
	const _facts = _items.filter( item => item !== 'r-250' ).map( item => resolved( item ) );
	assert.equal( check( _facts, { ...VALUES, items: _items } ).reason, 'open: r-250' );
} );

attacks( S, hostile( 'strings' ).filter( item => item.value.trim() && item.value.length < 100 ).slice( 0, 10 )
	.map( item => ( { ...item, name: `the hostile item id ${item.label} is resolved by exactly its own fact` } ) ), ( { value } ) => {
	const _values = { ...VALUES, items: [ value ] };
	assert.equal( check( [ resolved( `${value}x` ) ], _values ).met, false );
	assert.equal( check( [ resolved( value ) ], _values ).met, true );
} );

// The move that makes the commitment says which outcome it settles an item with; no name of a commitment or an outcome
// is known to the criterion.
const settles = outcome => ( { action: 'x', resolves: { item: 'id', outcome } } );
attacks( S, [
	{ name: 'admits: a move that settles items with an allowed outcome makes a commitment the goal admits', outcomes: [ 'paid', 'escalated' ],
		commitment: 'payment', move: settles( 'paid' ), want: true },
	{ name: 'admits: any name of commitment and outcome a mission uses', outcomes: [ 'refunded' ], commitment: 'refund', move: settles( 'refunded' ), want: true },
	{ name: 'admits: an outcome the goal does not allow admits nothing', outcomes: [ 'escalated' ], commitment: 'payment', move: settles( 'paid' ), want: false },
	{ name: 'admits: a move that settles no item admits nothing', outcomes: [ 'paid' ], commitment: 'payment', move: { action: 'x' }, want: false },
	{ name: 'admits: without the move nothing is admitted', outcomes: [ 'paid' ], commitment: 'payment', move: undefined, want: false },
	{ name: 'admits: an outcome that only contains an allowed one is not it', outcomes: [ 'unpaid' ], commitment: 'payment', move: settles( 'paid' ), want: false },
	{ name: 'admits: an outcome that is no text admits nothing', outcomes: [ 'paid' ], commitment: 'payment', move: settles( [ 'paid' ] ), want: false },
	{ name: 'admits: no commitment is nothing to admit', outcomes: [ 'paid' ], commitment: '', move: settles( 'paid' ), want: false },
], ( { outcomes, commitment, move, want } ) => {
	assert.equal( make( 'items_resolved', { ...VALUES, outcomes } ).admits( commitment, move ), want );
} );

attacks( S, [
	{ name: 'validate: an empty item list is refused', values: { ...VALUES, items: [] }, want: /items must be a non-empty list/ },
	{ name: 'validate: one item as text is refused', values: { ...VALUES, items: 'r-1' }, want: /items must be a non-empty list/ },
	{ name: 'validate: missing outcomes are refused', values: { collection: 'c', items: [ 'r-1' ] }, want: /outcomes is missing/ },
	{ name: 'validate: a missing collection is refused', values: { items: [ 'r-1' ], outcomes: [ 'paid' ] }, want: /collection is missing/ },
	{ name: 'validate: outcomes as text are refused', values: { ...VALUES, outcomes: 'paid' }, want: /outcomes must be a non-empty list/ },
], ( { values, want } ) => {
	assert.match( make( 'items_resolved', values ).validate().join(), want );
} );
