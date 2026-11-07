// core/criteria/summax.js: the total of all payments stays at or below max; the gate refuses a payment that would
// cross it. Attacks: boundaries, amounts that are no amounts (negative, text, NaN, floats), other parameters,
// strictness, and the gate's own sum.
import { Actions, ContractCheck, Contract, assert, attack, attacks, followed, gate, corpus, make, payment, receipt, registry } from './kit.mjs';
import { invariantSuite } from './suites.mjs';

const S = 'core/criteria/summax.js';
const VALUES = { max: 1000 };
const check = ( facts, values = VALUES ) => make( 'sum_max', values ).check( facts );
const sum = ( amounts, values = VALUES ) => check( amounts.map( amount => payment( amount ) ), values );
const row = ( amount, status = 'executed' ) => ( { id: `d-${amount}-${status}`, action: 'payment', status, params: { amount } } );
const SPEC = [ { id: 'k1', type: 'sum_max', values: VALUES } ];

invariantSuite( S, {
	type: 'sum_max', values: VALUES,
	clean: () => [ payment( 400 ), payment( 600 ) ],
	violating: () => [ payment( 600 ), payment( 600 ) ],
} );

attacks( S, [
	{ name: 'below max it holds', amounts: [ 300, 400 ], want: true },
	{ name: 'exactly max it holds', amounts: [ 400, 600 ], want: true },
	{ name: 'one cent above max it breaks', amounts: [ 400, 600.01 ], want: false },
	{ name: 'one payment of max + 1 breaks', amounts: [ 1001 ], want: false },
	{ name: 'amounts as numeric text are summed as numbers', amounts: [ '400', '600' ], want: true },
	{ name: 'amounts as numeric text above max break', amounts: [ '400', '601' ], want: false },
	{ name: 'an infinite amount breaks', amounts: [ Infinity ], want: false },
	{ name: 'two amounts of 1e308 overflow to Infinity and break', amounts: [ 1e308, 1e308 ], want: false },
], ( { amounts, want } ) => {
	assert.equal( sum( amounts ).met, want );
} );

attack( S, 'the reason states the total and the limit, and every payment is evidence', () => {
	const _paid = [ payment( 700 ), payment( 500 ) ];
	assert.deepEqual( check( _paid ), { met: false, evidence: [ _paid[ 0 ].id, _paid[ 1 ].id ], reason: 'paid 1200 > 1000' } );
} );

attack( S, 'money only: an amount on a report is no payment', () => {
	assert.equal( check( [ payment( 900 ), receipt( 'report', { params: { amount: 5000 } } ) ] ).met, true );
} );

attack( S, 'with param "total" the total parameter is summed, not the amount', () => {
	const _paid = [ payment( 1, {}, { total: 600 } ), payment( 1, {}, { total: 600 } ) ];
	assert.equal( check( _paid, { max: 1000, param: 'total' } ).met, false );
	assert.equal( check( _paid ).met, true );
} );

attack( S, 'a negative amount does not buy room for more payments', () => {
	assert.equal( sum( [ 900, -500, 600 ] ).met, false );
} );

attack( S, 'ten cents plus twenty cents stay within a limit of thirty cents', () => {
	assert.equal( sum( [ 0.1, 0.2 ], { max: 0.3 } ).met, true );
} );

attack( S, 'an amount that is no number breaks the sum and says why', () => {
	const _result = sum( [ 100, '1.000,50' ] );
	assert.equal( _result.met, false );
	assert.ok( _result.reason.length > 0 );
} );

attacks( S, [
	{ name: 'max 0: no payment at all holds', amounts: [], want: true },
	{ name: 'max 0: a payment of 0 holds', amounts: [ 0 ], want: true },
	{ name: 'max 0: one cent breaks', amounts: [ 0.01 ], want: false },
], ( { amounts, want } ) => {
	assert.equal( sum( amounts, { max: 0 } ).met, want );
} );

attack( S, 'a thousand payments of 1 meet a max of 1000 exactly; one more breaks', () => {
	const _thousand = Array.from( { length: 1000 }, () => 1 );
	assert.equal( sum( _thousand ).met, true );
	assert.equal( sum( [ ..._thousand, 1 ] ).met, false );
} );

attack( S, 'payments the execution follows after their move ended (O8) still count with their amount', () => {
	const _facts = [ ...followed( { id: 'd-1', action: 'payment', params: { amount: 800, invoiceId: 'r-1' } } ),
		...followed( { id: 'd-2', action: 'payment', params: { amount: 800, invoiceId: 'r-2' } } ) ];
	assert.equal( check( _facts ).met, false );
} );

attacks( S, corpus( 'numbers' ).map( item => ( {
	...item, name: `validate: max = ${item.label} is ${!Number.isNaN( item.value ) && item.value >= 0 ? 'a' : 'no'} valid limit`,
} ) ), ( { value } ) => {
	assert.equal( make( 'sum_max', { max: value } ).validate().length === 0, !Number.isNaN( value ) && value >= 0 );
} );

attacks( S, [
	{ name: 'validate: a max given as text is refused', values: { max: '1000' }, want: /max must be a number/ },
	{ name: 'validate: a missing max is refused', values: {}, want: /max is missing/ },
	{ name: 'validate: a param that is no text is refused', values: { max: 1, param: [ 'amount' ] }, want: /param must be text/ },
], ( { values, want } ) => {
	assert.match( make( 'sum_max', values ).validate().join(), want );
} );

attacks( S, [
	{ name: 'strictness: a lower max is stricter', a: { max: 500 }, b: VALUES, want: true },
	{ name: 'strictness: the same max is as strict', a: VALUES, b: VALUES, want: true },
	{ name: 'strictness: a higher max is looser', a: { max: 1001 }, b: VALUES, want: false },
	{ name: 'strictness: a low max on another parameter does not limit the amount', a: { max: 1, param: 'tip' }, b: VALUES, want: false },
], ( { a, b, want } ) => {
	assert.equal( make( 'sum_max', a ).atLeastAsStrict( make( 'sum_max', b ) ), want );
} );

attack( S, 'K7: the prescribed limit on the amount is not met by an immutable limit on another parameter', () => {
	const _contract = new Contract( { id: 'c', goal: 'Pay the invoices', deadline: '2026-12-01T00:00:00Z', budget: 9,
		criteria: [ { id: 'k1', type: 'sum_max', values: { max: 1, param: 'tip' }, immutable: true } ] }, registry );
	assert.ok( new ContractCheck()._mandatory( _contract, [ { type: 'sum_max', values: VALUES } ] ).length > 0 );
} );

attack( S, 'admits: a limit on money admits what a move that carries money commits to, nothing else', () => {
	const _money = Object.keys( Actions.load().table ).find( name => Actions.load().matches( 'carries:money', name ) );
	const _message = Object.keys( Actions.load().table ).find( name => !Actions.load().matches( 'carries:money', name ) );
	assert.ok( _money && _message, 'the action table has an action that carries money and one that does not' );
	assert.equal( make( 'sum_max', VALUES ).admits( 'anything', { action: _money } ), true );
	assert.equal( make( 'sum_max', VALUES ).admits( 'contract', { action: _message } ), false );
	assert.equal( make( 'sum_max', VALUES ).admits( 'contract' ), false );
	assert.equal( make( 'sum_max', VALUES ).admits( '', { action: _money } ), false );
} );

attack( S, 'its gate rule names the money class, the parameter and the limit', () => {
	assert.deepEqual( make( 'sum_max', VALUES ).gateRules(), [ { rule: 'sum_max', actions: [ 'carries:money' ], param: 'amount', max: 1000 } ] );
	assert.equal( make( 'sum_max', { max: 5, param: 'total' } ).gateRules()[ 0 ].param, 'total' );
} );

attacks( S, [
	{ name: 'gate: a payment within the limit passes', amount: 300, earlier: [ row( 600 ) ], refused: false },
	{ name: 'gate: a payment that reaches the limit exactly passes', amount: 400, earlier: [ row( 600 ) ], refused: false },
	{ name: 'gate: a payment that crosses the limit is refused', amount: 401, earlier: [ row( 600 ) ], refused: true },
	{ name: 'gate: an earlier payment awaiting approval counts', amount: 401, earlier: [ row( 600, 'awaiting_approval' ) ], refused: true },
	{ name: 'gate: an earlier unclear payment counts', amount: 401, earlier: [ row( 600, 'unclear' ) ], refused: true },
	{ name: 'gate: an earlier refused payment does not count', amount: 401, earlier: [ row( 600, 'refused' ) ], refused: false },
], ( { amount, earlier, refused } ) => {
	assert.equal( gate( SPEC, { action: 'payment', params: { amount } }, { deliveries: earlier } ).rules.includes( 'sum_max' ), refused );
} );

attack( S, 'gate: an earlier negative "payment" buys no room', () => {
	assert.ok( gate( SPEC, { action: 'payment', params: { amount: 600 } }, { deliveries: [ row( 900 ), row( -500 ) ] } ).rules.includes( 'sum_max' ) );
} );

attack( S, 'gate: twenty cents after ten cents stay within thirty cents', () => {
	assert.ok( !gate( [ { id: 'k1', type: 'sum_max', values: { max: 0.3 } } ], { action: 'payment', params: { amount: 0.2 } }, { deliveries: [ row( 0.1 ) ] } )
		.rules.includes( 'sum_max' ) );
} );
