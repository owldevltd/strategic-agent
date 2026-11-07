// core/criteria/exactlyonce.js: each item gets the action at most once; the gate's ledger refuses a second one and
// the evidence is its receipts. Attacks: classes of actions, key types, missing keys, the gate's own enforcement.
import { ContractCheck, Contract, assert, attack, attacks, followed, gate, hostile, make, payment, receipt, registry } from './kit.mjs';
import { invariantSuite } from './suites.mjs';

const S = 'core/criteria/exactlyonce.js';
const VALUES = { key: 'invoiceId', action: 'payment' };
const pay = invoiceId => payment( 100, {}, { invoiceId } );
const check = ( facts, values = VALUES ) => make( 'exactly_once', values ).check( facts );
const row = ( invoiceId, status = 'executed', action = 'payment' ) => ( { id: `d-${invoiceId}-${status}`, action, status, params: { invoiceId, amount: 100 } } );

invariantSuite( S, {
	type: 'exactly_once', values: VALUES,
	clean: () => [ pay( 'r-1' ), pay( 'r-2' ) ],
	violating: () => [ pay( 'r-1' ), pay( 'r-1' ) ],
} );

attack( S, 'paid twice: both receipts are the evidence', () => {
	const [ _a, _b ] = [ pay( 'r-1' ), pay( 'r-1' ) ];
	assert.deepEqual( check( [ _a, _b ] ), { met: false, evidence: [ _a.id, _b.id ], reason: 'an item got the action twice' } );
} );

attack( S, 'paid three times: all three receipts are the evidence', () => {
	assert.equal( check( [ pay( 'r-1' ), pay( 'r-1' ), pay( 'r-1' ) ] ).evidence.length, 3 );
} );

attack( S, 'two items each paid twice: four receipts are the evidence; clean items are not', () => {
	const _result = check( [ pay( 'r-1' ), pay( 'r-2' ), pay( 'r-1' ), pay( 'r-3' ), pay( 'r-2' ) ] );
	assert.equal( _result.evidence.length, 4 );
} );

attack( S, 'the same invoice in a report and a payment: only the payments count for action "payment"', () => {
	const _report = receipt( 'report', { params: { invoiceId: 'r-1' } } );
	assert.equal( check( [ pay( 'r-1' ), _report ] ).met, true );
} );

attack( S, 'for a class of actions every action of the class counts: a report and a reply about one item are two', () => {
	const _values = { key: 'ticket', action: 'carries:data' };
	const _report = receipt( 'report', { params: { ticket: 't-1' } } );
	const _reply = receipt( 'reply', { params: { ticket: 't-1' } } );
	assert.equal( check( [ _report, _reply ], _values ).met, false );
	assert.equal( check( [ _report, _reply ], { ..._values, action: 'report' } ).met, true );
} );

attack( S, 'the class "carries:money" covers the payment action', () => {
	assert.equal( check( [ pay( 'r-1' ), pay( 'r-1' ) ], { key: 'invoiceId', action: 'carries:money' } ).met, false );
} );

attack( S, 'the invoice 4711 as a number and as text is one invoice paid twice', () => {
	assert.equal( check( [ pay( 4711 ), pay( '4711' ) ] ).met, false );
} );

attack( S, 'the same invoice id in another case is another item (ids are exact)', () => {
	assert.equal( check( [ pay( 'R-1' ), pay( 'r-1' ) ] ).met, true );
} );

attack( S, 'a thousand invoices paid once each hold, quickly', () => {
	const _start = Date.now();
	assert.equal( check( Array.from( { length: 1000 }, ( _x, i ) => pay( `r-${i}` ) ) ).met, true );
	assert.ok( Date.now() - _start < 500 );
} );

attack( S, 'one double payment among a thousand is found, with exactly its two receipts', () => {
	const _list = Array.from( { length: 1000 }, ( _x, i ) => pay( `r-${i}` ) );
	const _again = pay( 'r-512' );
	assert.deepEqual( check( [ ..._list, _again ] ).evidence, [ _list[ 512 ].id, _again.id ] );
} );

attack( S, 'its gate rule names the action and the key', () => {
	assert.deepEqual( make( 'exactly_once', VALUES ).gateRules(), [ { rule: 'exactly_once', actions: [ 'payment' ], key: 'invoiceId' } ] );
	assert.deepEqual( make( 'exactly_once', VALUES ).flowRules(), [] );
} );

const SPEC = [ { id: 'k1', type: 'exactly_once', values: VALUES } ];
const request = invoiceId => ( { action: 'payment', params: { invoiceId, amount: 100, iban: 'DE1' } } );

attacks( S, [
	{ name: 'gate: the first payment of an invoice passes the rule', earlier: [], refused: false },
	{ name: 'gate: a second payment of an executed invoice is refused', earlier: [ row( 'r-1' ) ], refused: true },
	{ name: 'gate: a second payment while the first awaits approval is refused', earlier: [ row( 'r-1', 'awaiting_approval' ) ], refused: true },
	{ name: 'gate: a second payment while the first is unclear is refused', earlier: [ row( 'r-1', 'unclear' ) ], refused: true },
	{ name: 'gate: an earlier refused payment does not block a new one', earlier: [ row( 'r-1', 'refused' ) ], refused: false },
	{ name: 'gate: an earlier payment never sent does not block a new one', earlier: [ row( 'r-1', 'not_sent' ) ], refused: false },
	{ name: 'gate: an earlier payment of another invoice does not block', earlier: [ row( 'r-2' ) ], refused: false },
], ( { earlier, refused } ) => {
	assert.equal( gate( SPEC, request( 'r-1' ), { deliveries: earlier } ).rules.includes( 'exactly_once' ), refused );
} );

attack( S, 'gate: a payment without the key is refused, it cannot be counted', () => {
	const _result = gate( SPEC, { action: 'payment', params: { amount: 100 } } );
	assert.ok( _result.refusals.some( item => item.rule === 'exactly_once' && /missing invoiceId/.test( item.reason ) ) );
} );

attack( S, 'gate: under a class rule, a reply after a report about the same item is refused, as the criterion counts it', () => {
	const _spec = [ { id: 'k1', type: 'exactly_once', values: { key: 'ticket', action: 'carries:data' } } ];
	const _result = gate( _spec, { action: 'reply', params: { ticket: 't-1' } }, { deliveries: [ { id: 'd1', action: 'report', status: 'executed', params: { ticket: 't-1' } } ] } );
	assert.ok( _result.rules.includes( 'exactly_once' ) );
} );

attack( S, 'gate: the invoice 4711 paid as a number is refused after it was paid as text', () => {
	assert.ok( gate( SPEC, request( 4711 ), { deliveries: [ row( '4711' ) ] } ).rules.includes( 'exactly_once' ) );
} );

attack( S, 'payments the execution follows after their move ended (O8) are told apart by their invoice', () => {
	const _facts = [ ...followed( { id: 'd-1', action: 'payment', params: { invoiceId: 'r-1', amount: 100 } } ),
		...followed( { id: 'd-2', action: 'payment', params: { invoiceId: 'r-2', amount: 100 } } ) ];
	assert.equal( check( _facts ).met, true );
} );

attacks( S, [
	{ name: 'validate: an unknown action is refused', values: { key: 'invoiceId', action: 'wire' }, want: /action must be one of/ },
	{ name: 'validate: "*" is no action of the table', values: { key: 'invoiceId', action: '*' }, want: /action must be one of/ },
	{ name: 'validate: a list of actions is refused, one action or class only', values: { key: 'invoiceId', action: [ 'payment' ] }, want: /must be text/ },
	{ name: 'validate: a missing key is refused', values: { action: 'payment' }, want: /key is missing/ },
	{ name: 'validate: a key given as a number is refused', values: { key: 1, action: 'payment' }, want: /key must be text/ },
], ( { values, want } ) => {
	assert.match( make( 'exactly_once', values ).validate().join(), want );
} );

attack( S, 'validate: a class and "outward" are valid actions', () => {
	assert.deepEqual( make( 'exactly_once', { key: 'k', action: 'carries:money' } ).validate(), [] );
	assert.deepEqual( make( 'exactly_once', { key: 'k', action: 'outward' } ).validate(), [] );
} );

attack( S, 'K7: the prescribed invariant written in another key order is present, not missing', () => {
	const _contract = new Contract( { id: 'c', goal: 'Pay the invoices', deadline: '2026-12-01T00:00:00Z', budget: 9,
		criteria: [ { id: 'k1', type: 'exactly_once', values: { action: 'payment', key: 'invoiceId' }, immutable: true } ] }, registry );
	const _problems = new ContractCheck()._mandatory( _contract, [ { type: 'exactly_once', values: VALUES } ] );
	assert.deepEqual( _problems, [] );
} );

attack( S, 'strictness: the same key and action are as strict, another key is not', () => {
	assert.equal( make( 'exactly_once', VALUES ).atLeastAsStrict( make( 'exactly_once', VALUES ) ), true );
	assert.equal( make( 'exactly_once', { ...VALUES, key: 'supplier' } ).atLeastAsStrict( make( 'exactly_once', VALUES ) ), false );
} );

attack( S, 'it admits no commitment: ruling out double payments is no permission to pay', () => {
	assert.equal( make( 'exactly_once', VALUES ).admits( 'payment' ), false );
} );

attacks( S, hostile( 'keys' ).filter( item => item.value.trim() ).map( item => ( { ...item, name: `a key named ${item.label}: one value twice is a breach, two values are not` } ) ),
	( { value } ) => {
		const _values = { key: value, action: 'payment' };
		const _paid = id => receipt( 'payment', { params: { [ value ]: id, amount: 1 } } );
		assert.deepEqual( make( 'exactly_once', _values ).validate(), [] );
		assert.equal( check( [ _paid( 'r-1' ), _paid( 'r-1' ) ], _values ).met, false );
		assert.equal( check( [ _paid( 'r-1' ), _paid( 'r-2' ) ], _values ).met, true );
	} );

attack( S, 'gate: the rule for payments leaves reports alone', () => {
	const _result = gate( SPEC, { action: 'report', params: { invoiceId: 'r-1' } }, { deliveries: [ row( 'r-1' ) ] } );
	assert.ok( !_result.rules.includes( 'exactly_once' ) );
} );

attack( S, 'gate: a second payment of an invoice is refused even with another amount', () => {
	const _again = { action: 'payment', params: { invoiceId: 'r-1', amount: 1 } };
	assert.ok( gate( SPEC, _again, { deliveries: [ row( 'r-1' ) ] } ).rules.includes( 'exactly_once' ) );
} );
