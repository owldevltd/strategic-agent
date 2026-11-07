// Attacks on the money rules and on the rules themselves: sum caps with negative, non-numeric and floating amounts,
// "exactly once" with key variants and action classes, master data with lists, malformed and unknown rules.
import assert from 'node:assert/strict';
import { attack, attacks, hostile } from '../hostile.mjs';
import { gate, invoiceSpec, pay, reply, people, actionsWith, Rules, IBAN, DEADLINE, MINUTE } from './fixture.mjs';

const S = 'gate/rules.js';
const evaluate = ( g, rules, request ) => g.egress.rules.evaluate( {
	root: g.hash, hash: g.hash, rules: { gate: [], flow: [], allow: [], ...rules },
}, request );
const money = g => g.db.all( 'SELECT * FROM outbox WHERE action = \'payment\'' );

// A second money action next to payment, as a real bank channel would add (actions name classes, not missions).
const transfer = () => actionsWith( { transfer: { criticality: 'money_or_law', carries: [ 'money' ], sensitive: [ 'iban' ], idempotencyH: 168 } } );

attack( S, 'sum_max: a negative amount is refused instead of making room under the cap', async () => {
	const g = gate( { spec: invoiceSpec() } );
	const _negative = await g.submit( pay( 'R-1', -10000 ) );
	assert.equal( _negative.status, 'refused' );
	const _big = await g.submit( pay( 'R-2', 9000 ) );
	assert.equal( _big.status, 'refused', 'nothing above the cap passes' );
} );

attack( S, 'sum_max: an amount that is not a number is refused', async () => {
	const g = gate( { spec: invoiceSpec() } );
	const _text = await g.submit( pay( 'R-1', 'five thousand and one' ) );
	assert.equal( _text.status, 'refused' );
} );

attack( S, 'sum_max: one waiting payment with a non-numeric amount does not switch the cap off for all later payments', async () => {
	const g = gate( { spec: invoiceSpec() } );
	await g.submit( pay( 'R-1', 'n/a' ) );
	const _huge = await g.submit( pay( 'R-2', 1e9 ) );
	assert.equal( _huge.status, 'refused' );
	assert.match( _huge.reasons.map( item => item.reason ).join(), /> 5000/ );
} );

attack( S, 'sum_max: a negative payment that only waits for a person cannot carry 9000 past a cap of 5000', async () => {
	const g = gate( { spec: invoiceSpec() } );
	await g.submit( pay( 'R-1', -10000 ) );
	await g.send( pay( 'R-2', 9000 ) );
	const _paid = money( g ).map( row => JSON.parse( row.params ).amount );
	assert.ok( _paid.reduce( ( sum, amount ) => sum + amount, 0 ) <= 5000, `paid ${_paid.join( ', ' )}` );
} );

attack( S, 'sum_max: while a payment with a non-numeric amount waits, a payment of a billion is never executed', async () => {
	const g = gate( { spec: invoiceSpec() } );
	await g.submit( pay( 'R-1', 'n/a' ) );
	await g.send( pay( 'R-2', 1e9 ) );
	assert.equal( money( g ).length, 0 );
} );

attack( S, 'sum_max: a payment without an amount is refused, not counted as zero', async () => {
	const g = gate( { spec: invoiceSpec() } );
	const _result = await g.submit( { ...pay( 'R-1' ), params: { invoiceId: 'R-1', iban: IBAN } } );
	assert.equal( _result.status, 'refused' );
} );

attacks( S, [
	{ name: 'sum_max: the amount "6000" as text counts as 6000', amount: '6000' },
	{ name: 'sum_max: the amount "6e3" counts as 6000', amount: '6e3' },
	{ name: 'sum_max: the amount [ "6000" ] counts as 6000', amount: [ '6000' ] },
	{ name: 'sum_max: the amount " 6000 " with spaces counts as 6000', amount: ' 6000 ' },
	{ name: 'sum_max: the amount "0x1771" counts as 6001', amount: '0x1771' },
], async ( { amount } ) => {
	const g = gate( { spec: invoiceSpec() } );
	assert.equal( ( await g.submit( pay( 'R-1', amount ) ) ).status, 'refused' );
} );

attacks( S, hostile( 'numbers' ).map( ( { value } ) => {
	const _allowed = Number.isFinite( value ) && value >= 0 && value <= 5000;
	const _label = Object.is( value, -0 ) ? '-0' : String( value );
	return { name: `sum_max: the amount ${_label} is ${_allowed ? 'allowed' : 'refused'}`, value, allowed: _allowed };
} ), async ( { value, allowed } ) => {
	const g = gate( { spec: invoiceSpec() } );
	const _result = evaluate( g, { gate: [ { rule: 'sum_max', actions: [ 'carries:money' ], param: 'amount', max: 5000 } ] }, pay( 'R-1', value ) );
	assert.equal( _result.refusals.length === 0, allowed );
} );

attacks( S, [
	{ name: 'sum_max: exactly the cap is allowed', amounts: [ 3000, 2000 ], last: 'awaiting_approval' },
	{ name: 'sum_max: one cent above the cap is refused', amounts: [ 3000, 2000.01 ], last: 'refused' },
	{ name: 'sum_max: three payments that add up to the cap in cents are allowed', amounts: [ 4030.01, 67.89, 902.1 ], last: 'awaiting_approval' },
], async ( { amounts, last } ) => {
	const g = gate( { spec: invoiceSpec() } );
	let _result;
	for ( const [ i, amount ] of amounts.entries() ) {
		_result = await g.send( pay( `R-${i}`, amount ) );
	}
	assert.equal( _result.status === 'executed' ? 'awaiting_approval' : _result.status, last );
} );

attack( S, 'sum_max: an approved payment that waits for its redeem counts against the cap', async () => {
	const g = gate( { spec: invoiceSpec() } );
	await g.approved( pay( 'R-1', 4000 ) );
	const _second = await g.submit( pay( 'R-2', 4000 ) );
	assert.equal( _second.status, 'refused', '4000 are already promised' );
} );

attack( S, 'sum_max: refused, rejected and withdrawn payments free their amount again', async () => {
	const g = gate( { spec: invoiceSpec() } );
	await g.submit( pay( 'R-1', 9000 ) );
	const _rejected = await g.submit( pay( 'R-2', 4000 ) );
	await g.egress.decide( _rejected.approval, 'reject', 'person' );
	const _withdrawn = await g.submit( pay( 'R-3', 4000 ) );
	g.egress.withdraw( _withdrawn.delivery );
	assert.equal( ( await g.submit( pay( 'R-4', 5000 ) ) ).status, 'awaiting_approval' );
} );

attack( S, 'sum_max: a cap over all money actions cannot be split across two money actions', async () => {
	const g = gate( { spec: invoiceSpec(), actions: transfer() } );
	assert.equal( ( await g.send( pay( 'R-1', 4000 ) ) ).status, 'executed' );
	const _second = await g.submit( { ...pay( 'R-2', 4000 ), action: 'transfer' } );
	assert.equal( _second.status, 'refused', 'the cap counts carries:money, not one action name' );
} );

attack( S, 'exactly_once: the same invoice as a number and as text is the same invoice', async () => {
	const g = gate( { spec: invoiceSpec() } );
	await g.send( pay( '1187', 100 ) );
	assert.equal( ( await g.submit( pay( 1187, 100 ) ) ).status, 'refused' );
} );

attacks( S, [
	{ name: 'exactly_once: the same invoice id with a trailing space is the same invoice', variant: 'R-1187 ' },
	{ name: 'exactly_once: the same invoice id with a leading tab is the same invoice', variant: '\tR-1187' },
	{ name: 'exactly_once: the same invoice id with a trailing no-break space is the same invoice', variant: 'R-1187 ' },
], async ( { variant } ) => {
	const g = gate( { spec: invoiceSpec() } );
	await g.send( pay( 'R-1187', 100 ) );
	assert.equal( ( await g.submit( pay( variant, 100 ) ) ).status, 'refused' );
} );

attacks( S, [
	{ name: 'exactly_once: an invoice id of null is missing, not an item', value: null },
	{ name: 'exactly_once: an empty invoice id is missing, not an item', value: '' },
], async ( { value } ) => {
	const g = gate( { spec: invoiceSpec() } );
	const _result = await g.submit( pay( value, 100 ) );
	assert.equal( _result.status, 'refused' );
	assert.match( _result.reasons.map( item => item.reason ).join(), /missing invoiceId/ );
} );

attack( S, 'exactly_once: a rule key that is a prototype member (toString) is still missing when the request lacks it', () => {
	const g = gate( { spec: invoiceSpec() } );
	const _result = evaluate( g, { gate: [ { rule: 'exactly_once', actions: [ 'payment' ], key: 'toString' } ] }, pay( 'R-1', 10 ) );
	assert.match( _result.refusals.map( item => item.reason ).join(), /missing toString/ );
} );

attack( S, 'exactly_once: an invoice paid by one money action cannot be paid again by another of the same class', async () => {
	const g = gate( { spec: invoiceSpec(), actions: transfer() } );
	const _rules = g.store.contract( g.hash ).rules;
	_rules.gate.find( rule => rule.rule === 'exactly_once' ).actions = [ 'carries:money' ];
	g.db.run( 'UPDATE contracts SET rules = :r WHERE hash = :h', { h: g.hash, r: JSON.stringify( _rules ) } );
	await g.send( pay( 'R-1187', 100 ) );
	const _again = await g.submit( { ...pay( 'R-1187', 100 ), action: 'transfer' } );
	assert.equal( _again.status, 'refused' );
} );

attacks( S, [
	{ name: 'exactly_once: a refused earlier payment does not block the invoice', earlier: 'refused', blocks: false },
	{ name: 'exactly_once: a withdrawn earlier payment does not block the invoice', earlier: 'not_sent', blocks: false },
	{ name: 'exactly_once: an unclear earlier payment blocks the invoice (it may have gone out)', earlier: 'unclear', blocks: true },
	{ name: 'exactly_once: an approved earlier payment blocks the invoice', earlier: 'approved', blocks: true },
], async ( { earlier, blocks } ) => {
	const g = gate( { spec: invoiceSpec() } );
	const _first = await g.submit( pay( 'R-1187', 100 ) );
	g.db.run( 'UPDATE deliveries SET status = :s WHERE id = :id', { s: earlier, id: _first.delivery } );
	const _second = await g.submit( pay( 'R-1187', 100 ) );
	assert.equal( _second.status === 'refused', blocks );
} );

attacks( S, [
	{ name: 'known_account: an IBAN with spaces is not the master entry', iban: 'DE02 1203 0000 0000 2020 51' },
	{ name: 'known_account: an IBAN in lower case is not the master entry', iban: IBAN.toLowerCase() },
	{ name: 'known_account: a missing IBAN is not a master entry', iban: undefined },
	{ name: 'known_account: an IBAN given as a one-element list is refused', iban: [ IBAN ] },
	{ name: 'known_account: an IBAN given as the JSON object {"toString":null} is refused, not a crash', iban: JSON.parse( '{ "toString": null }' ) },
], ( { iban } ) => {
	const g = gate( { spec: invoiceSpec() } );
	const _result = evaluate( g, { gate: [ { rule: 'known_account', actions: [ 'carries:money' ], param: 'iban', kind: 'account' } ] },
		{ action: 'payment', params: { iban, amount: 1, invoiceId: 'R-1' }, labels: { iban: [ 'own' ] } } );
	assert.ok( _result.refusals.some( item => item.rule === 'known_account' ) );
} );

attack( S, 'known_account: master values of another kind do not count', () => {
	const g = gate( { spec: invoiceSpec(), master: [] } );
	g.store.addMaster( 'supplier', [ IBAN ] );
	const _result = evaluate( g, { gate: [ { rule: 'known_account', param: 'iban', kind: 'account' } ] }, pay( 'R-1', 1 ) );
	assert.equal( _result.refusals.length, 1 );
} );

attacks( S, [
	{ name: 'expires: exactly at deadline plus buffer the goal still holds', at: Date.parse( DEADLINE ) + 5 * MINUTE, expired: false },
	{ name: 'expires: one millisecond later it has expired', at: Date.parse( DEADLINE ) + 5 * MINUTE + 1, expired: true },
], ( { at, expired } ) => {
	const g = gate();
	g.clock.now = at;
	const _result = evaluate( g, { gate: [ { rule: 'expires', actions: [ '*' ], at: DEADLINE } ] }, reply( people( 12 ) ) );
	assert.equal( _result.refusals.some( item => /expired/.test( item.reason ) ), expired );
} );

attack( S, 'expires: an unparsable expiry is a refusal (fail closed), not a goal that never ends', () => {
	const g = gate();
	const _result = evaluate( g, { gate: [ { rule: 'expires', actions: [ '*' ], at: 'end of quarter' } ] }, reply( people( 12 ) ) );
	assert.ok( _result.refusals.length > 0 );
} );

attacks( S, [
	{ name: 'malformed rule: min_group without k refuses everything', rule: { rule: 'min_group', actions: [ '*' ] }, request: reply( [ 'r01' ] ) },
	{ name: 'malformed rule: sum_max without max refuses everything', rule: { rule: 'sum_max', param: 'amount' }, request: pay( 'R-1', 1e9 ) },
	{ name: 'malformed rule: no_difference with k "five" refuses everything', rule: { rule: 'no_difference', k: 'five' }, request: reply( [ 'r01' ] ),
		setup: async g => g.send( reply( people( 12 ) ) ) },
], async ( { rule, request, setup } ) => {
	const g = gate( { spec: invoiceSpec() } );
	await setup?.( g );
	const _result = evaluate( g, { gate: [ rule ] }, { ...request, cohort: request.cohort ?? people( 2 ) } );
	assert.ok( _result.refusals.length > 0, 'a rule the gate cannot read must not pass (A8)' );
} );

attacks( S, [
	{ name: 'unknown rule: a rule the gate does not know refuses', rule: { rule: 'trust_me' } },
	{ name: 'unknown rule: a rule without a name refuses instead of crashing', rule: { k: 5 } },
	{ name: 'unknown rule: a rule named after a helper (system) refuses', rule: { rule: 'system' } },
	{ name: 'unknown rule: a rule named after a helper (others) refuses instead of crashing', rule: { rule: 'others' } },
	{ name: 'unknown rule: a rule named constructor refuses', rule: { rule: 'constructor' } },
], ( { rule } ) => {
	const g = gate();
	const _result = evaluate( g, { gate: [ rule ] }, reply( people( 12 ) ) );
	assert.ok( _result.refusals.length > 0 );
} );

attack( S, 'malformed contract: rules without a flow list refuse instead of crashing', () => {
	const g = gate();
	const _result = g.egress.rules.evaluate( { root: g.hash, rules: { gate: [] } }, reply( people( 12 ) ) );
	assert.ok( _result.refusals.length > 0 );
} );

attacks( S, hostile( 'keys' ).map( ( { label, value } ) => ( { name: `unknown action: ${label} is not an action (fail closed)`, action: value } ) ),
	( { action } ) => {
		const g = gate();
		const _result = evaluate( g, {}, { action, params: {}, labels: {} } );
		assert.equal( _result.refusals[ 0 ]?.rule, 'action' );
	} );

attack( S, 'Rules.method: rule names map to their checks and nothing else', () => {
	assert.equal( Rules.method( 'min_group' ), '_minGroup' );
	assert.equal( Rules.method( 'known_account' ), '_knownAccount' );
	assert.equal( Rules.method( 'no_difference' ), '_noDifference' );
} );

attack( S, 'payments leave only once each even when submitted at the same moment', async () => {
	const g = gate( { spec: invoiceSpec() } );
	const _both = await Promise.all( [ g.submit( pay( 'R-1187', 100 ) ), g.submit( pay( 'R-1187', 100 ) ) ] );
	assert.deepEqual( _both.map( item => item.status ).sort(), [ 'awaiting_approval', 'refused' ] );
	await Promise.all( _both.filter( item => item.approval ).map( async item => g.redeem( await g.approve( item ) ) ) );
	assert.equal( money( g ).length, 1 );
} );
