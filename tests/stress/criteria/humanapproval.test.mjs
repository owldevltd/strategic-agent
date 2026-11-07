// core/criteria/humanapproval.js: a person approves each of these actions before it happens; the approval becomes a
// one-time token at the gate, and every receipt carries it. Attacks: approvals that are no approvals, classes,
// actions the rule must reach although their criticality alone would not, strictness of a longer list.
import { Actions, ContractCheck, Contract, assert, attack, attacks, followed, gate, hostile, make, payment, receipt, registry } from './kit.mjs';
import { invariantSuite } from './suites.mjs';

const S = 'core/criteria/humanapproval.js';
const VALUES = { actions: [ 'payment' ] };
const check = ( facts, values = VALUES ) => make( 'human_approval', values ).check( facts );
const unapproved = ( approval = null ) => receipt( 'payment', { to: 'supplier', approval, params: { amount: 100, invoiceId: 'r-9' } } );

invariantSuite( S, {
	type: 'human_approval', values: VALUES,
	clean: () => [ payment( 100 ), payment( 50 ) ],
	violating: () => [ payment( 100 ), unapproved() ],
} );

attack( S, 'an approved payment keeps it; an unapproved one is the evidence', () => {
	const _bad = unapproved();
	assert.deepEqual( check( [ payment( 1 ), _bad ] ), { met: false, evidence: [ _bad.id ], reason: 'an action went out without approval' } );
} );

attacks( S, [
	{ name: 'an approval that is the empty text is no approval', approval: '' },
	{ name: 'an approval of false is no approval', approval: false },
	{ name: 'an approval of 0 is no approval', approval: 0 },
	{ name: 'no approval field at all is no approval', approval: undefined },
], ( { approval } ) => {
	assert.equal( check( [ unapproved( approval ) ] ).met, false );
} );

attack( S, 'an action outside the list needs no approval under this rule', () => {
	assert.equal( check( [ receipt( 'report', { approval: null } ) ] ).met, true );
} );

attacks( S, [
	{ name: 'the class "outward" reaches a report', values: { actions: [ 'outward' ] }, action: 'report' },
	{ name: 'the class "outward" reaches a payment', values: { actions: [ 'outward' ] }, action: 'payment' },
	{ name: 'the class "carries:message" reaches an invitation', values: { actions: [ 'carries:message' ] }, action: 'invite' },
	{ name: 'the class "carries:data" reaches a reply', values: { actions: [ 'carries:data' ] }, action: 'reply' },
	{ name: 'a list of two reaches the second one', values: { actions: [ 'payment', 'report' ] }, action: 'report' },
], ( { values, action } ) => {
	assert.equal( check( [ receipt( action, { approval: null } ) ], values ).met, false );
	assert.equal( check( [ receipt( action ) ], values ).met, true );
} );

attack( S, 'the class "carries:money" does not reach a report', () => {
	assert.equal( check( [ receipt( 'report', { approval: null } ) ], { actions: [ 'carries:money' ] } ).met, true );
} );

attack( S, 'its gate rule names exactly its list', () => {
	assert.deepEqual( make( 'human_approval', { actions: [ 'report', 'carries:money' ] } ).gateRules(), [ { rule: 'human_approval', actions: [ 'report', 'carries:money' ] } ] );
} );

// An action table with an internal action, so the rule's own effect shows: by criticality it would pass without a person.
const NOTES = new Actions( { note: { criticality: 'internal', carries: [ 'data' ] }, payment: { criticality: 'money_or_law', carries: [ 'money' ] } } );

attacks( S, [
	{ name: 'gate: an internal action needs no person by itself', criteria: [], action: 'note', want: false },
	{ name: 'gate: an internal action listed by the rule needs a person', criteria: [ { id: 'k1', type: 'human_approval', values: { actions: [ 'note' ] } } ], action: 'note', want: true },
	{ name: 'gate: an internal action reached by its class needs a person', criteria: [ { id: 'k1', type: 'human_approval', values: { actions: [ 'carries:data' ] } } ], action: 'note', want: true },
	{ name: 'gate: a payment needs a person anyway (money_or_law)', criteria: [], action: 'payment', want: true },
], ( { criteria, action, want } ) => {
	assert.equal( gate( criteria, { action }, { actions: NOTES } ).needsApproval, want );
} );

attack( S, 'gate: the approval rule refuses nothing by itself; it only asks for a person', () => {
	const _result = gate( [ { id: 'k1', type: 'human_approval', values: { actions: [ 'report' ] } } ], { action: 'report' } );
	assert.deepEqual( _result.refusals, [] );
	assert.equal( _result.needsApproval, true );
} );

attack( S, 'strictness: the same list is as strict', () => {
	assert.equal( make( 'human_approval', VALUES ).atLeastAsStrict( make( 'human_approval', VALUES ) ), true );
} );

attack( S, 'strictness: asking a person for more actions is at least as strict as for fewer', () => {
	assert.equal( make( 'human_approval', { actions: [ 'payment', 'report' ] } ).atLeastAsStrict( make( 'human_approval', VALUES ) ), true );
} );

attack( S, 'strictness: the same actions in another order are as strict', () => {
	const _a = make( 'human_approval', { actions: [ 'payment', 'report' ] } );
	assert.equal( _a.atLeastAsStrict( make( 'human_approval', { actions: [ 'report', 'payment' ] } ) ), true );
} );

attack( S, 'strictness: fewer actions are not as strict', () => {
	assert.equal( make( 'human_approval', VALUES ).atLeastAsStrict( make( 'human_approval', { actions: [ 'payment', 'report' ] } ) ), false );
} );

attack( S, 'G1: the agent may tighten the client\'s rule by asking for more approvals', () => {
	const _contract = new Contract( { id: 'c', goal: 'g', deadline: '2026-12-01T00:00:00Z', budget: 9, criteria: [
		{ id: 'k1', type: 'human_approval', values: VALUES },
		{ id: 'a1', type: 'human_approval', values: { actions: [ 'payment', 'report' ] }, origin: 'agent' },
		{ id: 'k2', type: 'report_delivered', values: { to: 'hr', topic: 't' } } ] }, registry );
	const _problems = new ContractCheck()._consistency( _contract );
	assert.deepEqual( _problems, [] );
} );

attack( S, 'payments approved and then followed after their move ended (O8) are still approved', () => {
	const _facts = followed( { action: 'payment', params: { invoiceId: 'r-1', amount: 100 }, approval: 'ap-7' } );
	assert.equal( check( _facts ).met, true );
} );

attacks( S, [
	{ name: 'validate: an empty list is refused', values: { actions: [] }, want: /non-empty list/ },
	{ name: 'validate: a single action as text is refused', values: { actions: 'payment' }, want: /non-empty list/ },
	{ name: 'validate: an unknown action is refused', values: { actions: [ 'wire' ] }, want: /may only contain/ },
	{ name: 'validate: "*" is refused', values: { actions: [ '*' ] }, want: /may only contain/ },
	{ name: 'validate: a missing list is refused', values: {}, want: /actions is missing/ },
], ( { values, want } ) => {
	assert.match( make( 'human_approval', values ).validate().join(), want );
} );

attacks( S, hostile( 'keys' ).map( item => ( { ...item, name: `validate: the action name ${item.label} is no action` } ) ), ( { value } ) => {
	assert.match( make( 'human_approval', { actions: [ value ] } ).validate().join(), /may only contain/ );
} );

attack( S, 'it admits no commitment: approving payments is no permission to make them', () => {
	assert.equal( make( 'human_approval', VALUES ).admits( 'payment' ), false );
} );

attack( S, 'one unapproved payment among a thousand approved ones is found, and only it', () => {
	const _bad = unapproved();
	const _list = [ ...Array.from( { length: 1000 }, ( _x, i ) => payment( i ) ), _bad ];
	assert.deepEqual( check( _list ).evidence, [ _bad.id ] );
} );

attack( S, 'K7: a prescribed approval for payments is present when an immutable rule asks for payments and reports', () => {
	const _contract = new Contract( { id: 'c', goal: 'g', deadline: '2026-12-01T00:00:00Z', budget: 9,
		criteria: [ { id: 'k1', type: 'human_approval', values: { actions: [ 'payment', 'report' ] }, immutable: true } ] }, registry );
	assert.deepEqual( new ContractCheck()._mandatory( _contract, [ { type: 'human_approval', values: VALUES } ] ), [] );
} );
