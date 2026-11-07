// core/criteria/accountfrommaster.js: money only goes to accounts from our own master data. The account must be the
// system's own value (10.4, G2 flow rule), the gate checks its own copy of the master data, and the evidence is the
// gate's receipts. Attacks: foreign or unlabelled accounts, receipts not from the gate, hostile parameter names.
import { ContractCheck, Contract, assert, attack, attacks, gate, hostile, make, payment, receipt, registry } from './kit.mjs';
import { invariantSuite } from './suites.mjs';

const S = 'core/criteria/accountfrommaster.js';
const IBAN = { param: 'iban' };
const check = ( facts, values = IBAN ) => make( 'account_from_master', values ).check( facts );
const SPEC = [ { id: 'k1', type: 'account_from_master', values: IBAN } ];
const MASTER = [ 'DE11 1111' ];
const pay = ( iban, labels = [ 'own' ], extra = {} ) => ( { action: 'payment', params: { amount: 10, invoiceId: 'r-1', iban }, labels: { iban: labels }, ...extra } );

invariantSuite( S, {
	type: 'account_from_master', values: IBAN,
	clean: () => [ payment( 100 ), payment( 200 ) ],
	violating: () => [ payment( 100 ), payment( 200, { source: 'agent' } ) ],
} );

attack( S, 'payments the gate executed keep it; every payment is evidence', () => {
	const _paid = [ payment( 1 ), payment( 2 ) ];
	assert.deepEqual( check( _paid ), { met: true, evidence: _paid.map( item => item.id ), reason: '' } );
} );

attacks( S, [
	{ name: 'a payment receipt from the agent instead of the gate breaks it', source: 'agent' },
	{ name: 'a payment receipt from a person breaks it', source: 'person lead' },
	{ name: 'a payment receipt without a source breaks it', source: undefined },
	{ name: 'a payment receipt from "Gate" (another case) breaks it', source: 'Gate' },
	{ name: 'a payment receipt from "gate " (trailing space) breaks it', source: 'gate ' },
	{ name: 'a payment receipt whose origin says gate but source does not breaks it', source: 'world' },
], ( { source } ) => {
	const _result = check( [ payment( 5, { source, origin: 'gate' } ) ] );
	assert.equal( _result.met, false );
	assert.equal( _result.reason, 'a payment without the gate\'s check' );
} );

attack( S, 'messages are no payments: a report from elsewhere does not break it', () => {
	assert.equal( check( [ receipt( 'report', {}, { source: 'agent' } ), receipt( 'reply', {}, { source: 'agent' } ) ] ).met, true );
} );

attack( S, 'an action the table does not know carries no money here', () => {
	assert.equal( check( [ receipt( 'transfer', {}, { source: 'agent' } ) ] ).met, true );
} );

attack( S, 'it derives a flow rule: the account parameter of money actions must carry the label own', () => {
	assert.deepEqual( make( 'account_from_master', IBAN ).flowRules(), [ { actions: [ 'carries:money' ], param: 'iban', mustHave: [ 'own' ] } ] );
} );

attack( S, 'it derives a gate rule: the account must be in the gate\'s master data of kind account', () => {
	assert.deepEqual( make( 'account_from_master', IBAN ).gateRules(), [ { rule: 'known_account', actions: [ 'carries:money' ], param: 'iban', kind: 'account' } ] );
} );

attacks( S, [
	{ name: 'a param "account" moves both rules to that parameter', values: { param: 'account' }, param: 'account', kind: 'account' },
	{ name: 'a kind "supplier" asks the gate for that master data', values: { param: 'iban', kind: 'supplier' }, param: 'iban', kind: 'supplier' },
	{ name: 'an empty kind falls back to account', values: { param: 'iban', kind: '' }, param: 'iban', kind: 'account' },
], ( { values, param, kind } ) => {
	const _item = make( 'account_from_master', values );
	assert.equal( _item.flowRules()[ 0 ].param, param );
	assert.deepEqual( [ _item.gateRules()[ 0 ].param, _item.gateRules()[ 0 ].kind ], [ param, kind ] );
} );

attacks( S, [
	{ name: 'gate: our own account from the master data passes both rules', request: pay( 'DE11 1111' ), rules: [] },
	{ name: 'gate: an account read from a supplier\'s mail (foreign) is refused', request: pay( 'DE11 1111', [ 'foreign' ] ), rules: [ 'sensitive', 'flow' ] },
	{ name: 'gate: an account without any label is refused', request: pay( 'DE11 1111', [] ), rules: [ 'sensitive', 'flow' ] },
	{ name: 'gate: an own account that is not in the master data is refused', request: pay( 'DE99 9999' ), rules: [ 'known_account' ] },
	{ name: 'gate: an own and foreign mixed value is refused', request: pay( 'DE11 1111', [ 'own', 'foreign' ] ), rules: [ 'sensitive' ] },
	{ name: 'gate: a payment without an account is refused', request: pay( undefined, [] ), rules: [ 'sensitive', 'flow', 'known_account' ] },
	{ name: 'gate: a report is not touched by either rule', request: { action: 'report', params: {} }, rules: [] },
], ( { request, rules } ) => {
	const _result = gate( SPEC, request, { master: MASTER } );
	assert.deepEqual( [ ...new Set( _result.rules ) ].sort(), [ ...rules ].sort() );
} );

attack( S, 'gate: the rule asks the master data of its kind, and the account in its param', () => {
	const _spec = [ { id: 'k1', type: 'account_from_master', values: { param: 'account', kind: 'supplier' } } ];
	const _result = gate( _spec, { action: 'payment', params: { account: 'S-1', amount: 1 }, labels: { account: [ 'own' ] } }, { master: [ 'S-1' ] } );
	assert.deepEqual( _result.kinds, [ 'supplier' ] );
	assert.ok( !_result.rules.includes( 'known_account' ) && !_result.rules.includes( 'flow' ) );
} );

attacks( S, [ '__proto__', 'constructor' ].map( param => ( { name: `a param named ${param} is refused at validation, or the gate refuses the payment cleanly`, param } ) ),
	( { param } ) => {
		const _values = { param };
		if ( make( 'account_from_master', _values ).validate().length ) { return; }
		const _result = gate( [ { id: 'k1', type: 'account_from_master', values: _values } ], pay( 'DE11 1111' ), { master: MASTER } );
		assert.ok( _result.refusals.length > 0 );
	} );

attack( S, 'gate: a foreign account is refused even if it happens to be in the master data', () => {
	assert.ok( gate( SPEC, pay( 'DE11 1111', [ 'foreign' ] ), { master: MASTER } ).rules.includes( 'flow' ) );
} );

attack( S, 'gate: a known account in the wrong parameter does not pass', () => {
	const _request = { action: 'payment', params: { amount: 1, note: 'DE11 1111' }, labels: { note: [ 'own' ] } };
	assert.deepEqual( [ ...new Set( gate( SPEC, _request, { master: MASTER } ).rules ) ].sort(), [ 'flow', 'known_account' ] );
} );

attack( S, 'its rules are tagged with the criterion inside a contract, flow and gate alike', () => {
	const _rules = new Contract( { id: 'c', goal: 'g', deadline: '2026-12-01T00:00:00Z', criteria: [ { id: 'k4', type: 'account_from_master', values: IBAN } ] }, registry ).rules();
	assert.deepEqual( [ _rules.flow[ 0 ].criterion, _rules.gate.find( rule => rule.rule === 'known_account' ).criterion ], [ 'k4', 'k4' ] );
} );

attack( S, 'it offers the drafter the account parameter and the kind; the parameter must be named', () => {
	assert.deepEqual( Object.keys( registry.list().find( entry => entry.type === 'account_from_master' ).params ), [ 'param', 'kind' ] );
	assert.deepEqual( make( 'account_from_master', IBAN ).validate(), [] );
} );

attacks( S, [
	{ name: 'validate: without a param no account parameter is guessed: refused', values: {}, want: /param/ },
	{ name: 'validate: an empty param is refused', values: { param: '' }, want: /param must name the parameter that holds the account/ },
	{ name: 'validate: a param of blanks is refused', values: { param: '   ' }, want: /param must name the parameter that holds the account/ },
], ( { values, want } ) => {
	assert.match( make( 'account_from_master', values ).validate().join(), want );
	assert.deepEqual( make( 'account_from_master', values ).flowRules()[ 0 ].param, typeof values.param === 'string' ? values.param : '' );
} );

attacks( S, hostile( 'types' ).filter( item => item.value !== null && item.value !== undefined ).slice( 0, 8 )
	.map( item => ( { ...item, name: `validate: a param ${item.label} is refused` } ) ), ( { value } ) => {
	assert.deepEqual( make( 'account_from_master', { param: value } ).validate(), [ 'k1: param must be text' ] );
} );

attack( S, 'strictness: the same values are as strict; another param is not', () => {
	assert.equal( make( 'account_from_master', IBAN ).atLeastAsStrict( make( 'account_from_master', IBAN ) ), true );
	assert.equal( make( 'account_from_master', { param: 'account' } ).atLeastAsStrict( make( 'account_from_master', IBAN ) ), false );
} );

attack( S, 'strictness: the same param and kind in another key order are the same rule (K7)', () => {
	const _contract = new Contract( { id: 'c', goal: 'Pay', deadline: '2026-12-01T00:00:00Z', budget: 9,
		criteria: [ { id: 'k1', type: 'account_from_master', values: { kind: 'account', param: 'iban' }, immutable: true } ] }, registry );
	assert.deepEqual( new ContractCheck()._mandatory( _contract, [ { type: 'account_from_master', values: { param: 'iban', kind: 'account' } } ] ), [] );
} );

attack( S, 'it admits no commitment: an allowed account is no permission to pay', () => {
	assert.equal( make( 'account_from_master', IBAN ).admits( 'payment' ), false );
} );

attack( S, 'five hundred gate payments and one from elsewhere: the breach is found', () => {
	const _list = [ ...Array.from( { length: 500 }, ( _x, i ) => payment( i ) ), payment( 1, { source: 'agent' } ) ];
	assert.equal( check( _list ).met, false );
	assert.equal( check( _list ).evidence.length, 501 );
} );
