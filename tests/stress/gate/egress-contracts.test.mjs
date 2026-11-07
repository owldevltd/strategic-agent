// Attacks on contracts at the gate: proposals whose hash does not match, re-proposals with laxer rules, child
// contracts that try to loosen what the parent confirmed (covers), and requests whose fields have the wrong type.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { gate, settle, invoiceSpec, surveySpec, reply, pay, people, Egress, Contract, registry, DEADLINE, MINUTE } from './fixture.mjs';

const S = 'gate/egress.js';
const twelve = people( 12 );

// A child of the given gate's contract; edit( spec, rules ) may change both before the proposal.
function child( g, { id = 'child', deadline = DEADLINE, edit = null, criteria = null } = {} ) {
	const _spec = { ...g.contract.spec, id, parent: g.hash, deadline, criteria: criteria || g.contract.spec.criteria };
	const _rules = new Contract( _spec, registry ).rules();
	edit?.( _spec, _rules );
	const _contract = new Contract( _spec, registry );
	return g.egress.propose( _contract.canonical(), _rules, _contract.hash );
}

attack( S, 'propose: a hash that does not match the content is refused and nothing is stored', () => {
	const g = gate();
	const _spec = { ...g.contract.canonical(), goal: 'Pay everybody' };
	assert.throws( () => g.egress.propose( _spec, g.contract.rules(), Egress.canonical( _spec ).id ), /does not match/ );
	assert.throws( () => g.egress.propose( _spec, g.contract.rules(), g.hash.toUpperCase() ), /does not match/ );
	assert.equal( g.db.get( 'SELECT COUNT(*) AS n FROM contracts' ).n, 1 );
} );

attack( S, 'propose: proposing the same goal again with no rules does not replace the confirmed rules', async () => {
	const g = gate( { spec: invoiceSpec() } );
	const _again = g.egress.propose( g.contract.canonical(), { gate: [], flow: [], allow: [] }, g.hash );
	assert.ok( _again.rules.gate.length > 3 );
	assert.equal( _again.status, 'confirmed' );
	const _twice = await g.submit( pay( 'R-1187', 9000 ) );
	assert.equal( _twice.status, 'refused', 'the sum cap of the confirmed rules still holds' );
} );

attack( S, 'propose: a spec of null is a clean refusal, not a TypeError', () => {
	const g = gate();
	assert.throws( () => g.egress.propose( null, {}, 'x' ), error => !( error instanceof TypeError ) );
} );

attack( S, 'confirm: an unknown hash confirms nothing and creates nothing', () => {
	const g = gate( { confirm: false } );
	assert.equal( g.egress.confirm( 'f'.repeat( 64 ), 'person' ), null );
	assert.equal( g.db.get( 'SELECT COUNT(*) AS n FROM contracts WHERE status = \'confirmed\'' ).n, 0 );
} );

attack( S, 'confirm: a second confirmation does not overwrite who confirmed or when', () => {
	const g = gate();
	const _first = g.store.contract( g.hash );
	g.clock.now += MINUTE;
	const _second = g.egress.confirm( g.hash, 'intruder' );
	assert.equal( _second.confirmedBy, _first.confirmedBy );
	assert.equal( _second.confirmedAt, _first.confirmedAt );
	assert.equal( g.events( 'contract_confirmed' ).length, 1 );
} );

attack( S, 'nothing leaves under a goal that is only proposed, even with a valid lease', async () => {
	const g = gate( { confirm: false } );
	const _result = await g.submit( reply( twelve ) );
	assert.equal( _result.status, 'refused' );
	assert.equal( _result.reasons[ 0 ].rule, 'contract' );
} );

attack( S, 'covers: a child with the very same rules is confirmed by derivation and shares the root', () => {
	const g = gate( { spec: invoiceSpec() } );
	const _row = child( g );
	assert.equal( _row.status, 'confirmed' );
	assert.equal( _row.root, g.hash );
	assert.match( _row.confirmedBy, /derived from invoices/ );
} );

// The gate derives the rules of a goal itself; rules sent along that are laxer than the goal never cover the parent,
// and the proposal that carries them is refused outright, so nothing of it is stored.
attacks( S, [
	{ name: 'covers: a child without the parent\'s exactly-once rule is refused', edit: ( _s, rules ) => {
		rules.gate = rules.gate.filter( rule => rule.rule !== 'exactly_once' );
	} },
	{ name: 'covers: a child with a higher sum cap is refused', edit: ( _s, rules ) => {
		rules.gate.find( rule => rule.rule === 'sum_max' ).max = 9000;
	} },
	{ name: 'covers: a child whose human approval covers another action is refused', edit: ( _s, rules ) => {
		rules.gate.find( rule => rule.rule === 'human_approval' ).actions = [ 'report' ];
	} },
	{ name: 'covers: a child without the parent\'s flow rule (own account only) is refused', edit: ( _s, rules ) => {
		rules.flow = [];
	} },
	{ name: 'covers: a child whose flow rule demands nothing is refused', edit: ( _s, rules ) => {
		rules.flow = rules.flow.map( rule => ( { ...rule, mustHave: [] } ) );
	} },
	{ name: 'covers: a child that adds an allowance for confidential data is refused', edit: ( _s, rules ) => {
		rules.allow = [ { label: 'confidential', actions: [ '*' ], as: 'group' } ];
	} },
	{ name: 'covers: a child whose own expiry rule is later than the parent\'s is refused', edit: ( _s, rules ) => {
		rules.gate = rules.gate.map( rule => ( rule.rule === 'expires' ? { ...rule, at: '2026-12-31T00:00:00Z' } : rule ) );
	} },
	{ name: 'covers: a child without any expiry rule is refused', edit: ( _s, rules ) => {
		rules.gate = rules.gate.filter( rule => rule.rule !== 'expires' );
	} },
	{ name: 'covers: a child whose expiry rule is unparsable is refused', edit: ( _s, rules ) => {
		rules.gate = rules.gate.map( rule => ( rule.rule === 'expires' ? { ...rule, at: 'tomorrow' } : rule ) );
	} },
], ( { edit } ) => {
	const g = gate( { spec: invoiceSpec() } );
	const _rules = new Contract( { ...g.contract.spec, id: 'child', parent: g.hash }, registry ).rules();
	edit( {}, _rules );
	assert.equal( Egress.covers( _rules, g.store.contract( g.hash ).rules ), false, 'laxer rules never cover the parent' );
	assert.throws( () => child( g, { edit } ), /do not follow from the goal/ );
	assert.equal( g.db.get( 'SELECT COUNT(*) AS n FROM contracts' ).n, 1, 'nothing of the proposal is stored' );
} );

// A deadline criterion at the parent's deadline keeps the child's rules (its expiry among them) as strict as the
// parent's, so only the later deadline of the goal itself keeps it from being derived.
attacks( S, [
	{ name: 'covers: a child with a later deadline waits for a person', deadline: '2026-11-08T00:00:00Z' },
	{ name: 'covers: a child with an unparsable deadline waits for a person', deadline: 'next week' },
	{ name: 'covers: a child with a deadline one millisecond after the parent\'s waits for a person', deadline: '2026-11-07T17:00:00.001Z' },
], ( { deadline } ) => {
	const g = gate( { spec: invoiceSpec() } );
	const _criteria = [ ...invoiceSpec().criteria, { id: 'k9', type: 'deadline', values: { at: DEADLINE } } ];
	assert.equal( child( g, { deadline, criteria: _criteria } ).status, 'proposed' );
} );

attack( S, 'propose: a goal whose own expiry cannot be read is refused at the gate (fail closed)', () => {
	const g = gate( { spec: invoiceSpec() } );
	assert.throws( () => child( g, { deadline: 'next week' } ), /cannot be checked/ );
} );

attack( S, 'covers: a child of a goal that is only proposed is never derived', () => {
	const g = gate( { spec: invoiceSpec(), confirm: false } );
	assert.equal( child( g ).status, 'proposed' );
} );

attack( S, 'covers: a child naming a parent the gate does not know becomes its own root and waits for a person', () => {
	const g = gate( { spec: invoiceSpec() } );
	const _spec = { ...invoiceSpec(), id: 'orphan', parent: 'e'.repeat( 64 ) };
	const _contract = new Contract( _spec, registry );
	const _row = g.egress.propose( _contract.canonical(), _contract.rules(), _contract.hash );
	assert.equal( _row.status, 'proposed' );
	assert.equal( _row.root, _contract.hash );
} );

attack( S, 'covers: the parent\'s rules in another key order are still the same rules', () => {
	const g = gate( { spec: invoiceSpec() } );
	const _reorder = rule => Object.fromEntries( Object.entries( rule ).reverse() );
	const _row = child( g, { edit: ( _s, rules ) => {
		rules.gate = rules.gate.map( _reorder ).reverse();
		rules.flow = rules.flow.map( _reorder );
	} } );
	assert.equal( _row.status, 'confirmed' );
} );

attack( S, 'covers: rule lists that are missing altogether do not crash the comparison', () => {
	assert.equal( Egress.covers( {}, { gate: [ { rule: 'min_group', k: 5 } ] } ), false );
	assert.equal( Egress.covers( { gate: [ { rule: 'expires', at: DEADLINE } ] }, { gate: [ { rule: 'expires', at: DEADLINE } ] } ), true );
} );

attack( S, 'tree: a grandchild derived twice still shares the root, and cannot pay an invoice its grandparent paid', async () => {
	const g = gate( { spec: invoiceSpec() } );
	await g.send( pay( 'R-1187', 100 ) );
	const _child = child( g );
	const _spec = { ...invoiceSpec(), id: 'grandchild', parent: _child.hash };
	const _grand = new Contract( _spec, registry );
	const _row = g.egress.propose( _grand.canonical(), _grand.rules(), _grand.hash );
	assert.equal( _row.status, 'confirmed' );
	assert.equal( _row.root, g.hash );
	const _again = await g.submit( { ...pay( 'R-1187', 100 ), contract: _grand.hash } );
	assert.equal( _again.status, 'refused' );
	assert.match( _again.reasons[ 0 ].reason, /already has a payment/ );
} );

attack( S, 'tree: two sibling children together cannot exceed the sum cap of the root', async () => {
	const g = gate( { spec: invoiceSpec() } );
	const _a = child( g, { id: 'a' } );
	const _b = child( g, { id: 'b' } );
	assert.equal( ( await g.send( { ...pay( 'R-1186', 3000 ), contract: _a.hash } ) ).status, 'executed' );
	const _over = await g.submit( { ...pay( 'R-1187', 2500 ), contract: _b.hash } );
	assert.equal( _over.status, 'refused' );
	assert.match( _over.reasons[ 0 ].reason, /5500 > 5000/ );
} );

attack( S, 'G-1b: under a child a person confirmed with a later deadline, nothing is sent after the root deadline plus buffer', async () => {
	const g = gate( { service: { failures: 1 } } );
	const _late = child( g, { id: 'late', deadline: '2026-11-20T00:00:00Z' } );
	assert.equal( _late.status, 'proposed' );
	g.egress.confirm( _late.hash, 'person' );
	g.clock.now = Date.parse( '2026-11-07T16:50:00Z' );
	const _asked = await g.submit( { ...reply( twelve ), contract: _late.hash }, g.lease( 'w', 5, _late.hash ) );
	const _first = await g.redeem( await g.approve( _asked ), g.lease( 'w', 5, _late.hash ) );
	assert.equal( _first.status, 'open', 'the first attempt failed before the end' );
	g.clock.now = Date.parse( '2026-11-07T17:05:00.001Z' );
	await settle( g, _first.delivery );
	assert.equal( g.outbox().length, 0, 'the retry after the root deadline plus buffer must not send' );
} );

attack( S, 'A7: an action under a goal whose deadline already passed is refused at once', async () => {
	const g = gate( { spec: surveySpec( { deadline: '2026-11-05T08:00:00Z' } ) } );
	const _result = await g.submit( reply( twelve ) );
	assert.equal( _result.status, 'refused' );
	assert.match( _result.reasons.map( item => item.reason ).join(), /expired/ );
} );

attacks( S, [
	{ name: 'submit: an empty request is refused and booked, not thrown', request: () => ( {} ) },
	{ name: 'submit: a request without an action is refused and booked', request: g => ( { contract: g.hash } ) },
	{ name: 'submit: a contract given as an object is refused', request: () => ( { contract: { hash: 'x' }, action: 'reply' } ) },
	{ name: 'submit: a contract given as a number is refused', request: () => ( { contract: 42, action: 'reply' } ) },
	{ name: 'submit: a recipient given as a list is refused', request: g => ( { ...reply( twelve ), contract: g.hash, target: [ 'ceo', 'press' ] } ) },
	{ name: 'submit: a node given as an object is refused', request: g => ( { ...reply( twelve ), contract: g.hash, node: { id: 'n1' } } ) },
	{ name: 'submit: a lease id given as an object is refused', request: g => ( { ...reply( twelve ), contract: g.hash, lease: { id: 'x' }, fence: 1 } ) },
	{ name: 'submit: a fence given as an object is refused', request: g => ( { ...reply( twelve ), contract: g.hash, lease: 'ls-x', fence: { n: 1 } } ) },
], async ( { request } ) => {
	const g = gate();
	const _lease = g.lease();
	const _result = await g.egress.submit( { lease: _lease.id, fence: _lease.fence, ...request( g ) } );
	assert.equal( _result.status, 'refused' );
	assert.equal( g.db.get( 'SELECT COUNT(*) AS n FROM deliveries WHERE status = \'refused\'' ).n, 1, 'the refusal is in the ledger' );
} );
