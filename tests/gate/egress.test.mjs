import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';

const [ Registry, Contract, Db, EventLog, Egress, Outbox ] = await use(
	'Core.Criteria.Registry', 'Core.Contract.Contract', 'Lib.Db', 'Lib.EventLog', 'Gate.Egress', 'Gate.Channel.Outbox',
);
const registry = await Registry.load();
const START = Date.parse( '2026-11-05T09:00:00Z' );
const people = n => Array.from( { length: n }, ( _x, i ) => `r${String( i + 1 ).padStart( 2, '0' )}` );

function setup( spec ) {
	const _db = new Db( ':memory:' );
	const _clock = { now: START };
	const _egress = new Egress( { db: _db, log: new EventLog( _db, 'gate' ), channels: { default: new Outbox( _db ) }, now: () => _clock.now } );
	const _store = _egress.store;
	// The recipients the operator listed: where data about a group may go.
	_store.addMaster( 'recipient', [ 'hr', 'ceo' ] );
	const _contract = new Contract( spec, registry );
	_egress.propose( _contract.canonical(), _contract.rules(), _contract.hash );
	// The worker of each request holds a fresh lease, as a move in the core does.
	const _submit = _egress.submit.bind( _egress );
	_egress.submit = ( request ) => {
		const _lease = _egress.lease( { node: 'worker', move: 'test', contract: request.contract, minutes: 5 } );
		return _submit( { lease: _lease.id, fence: _lease.fence, ...request } );
	};
	_egress.submitRaw = _submit;
	// After a person's approval the worker presents the token under a fresh lease (O1, A6).
	_egress.redeemNow = ( result ) => {
		const _lease = _egress.lease( { node: 'worker', move: 'test', contract: _contract.hash, minutes: 5 } );
		return _egress.redeem( { delivery: result.delivery, approval: result.approval, lease: _lease.id, fence: _lease.fence } );
	};
	return { egress: _egress, store: _store, clock: _clock, hash: _contract.hash };
}

const survey = () => setup( {
	id: 'survey', goal: 'Find out why the design team is unhappy', deadline: '2026-11-07T17:00:00Z',
	criteria: [
		{ id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'morale' } },
		{ id: 'k2', type: 'min_group', values: { k: 5 } },
		{ id: 'k3', type: 'no_difference', values: { k: 5 } },
	],
} );

const invoices = () => setup( {
	id: 'invoices', goal: 'Prepare this week\'s supplier payments', deadline: '2026-11-07T17:00:00Z',
	criteria: [
		{ id: 'k1', type: 'items_resolved', values: { collection: 'invoices', items: [ 'R-1186', 'R-1187' ], outcomes: [ 'paid', 'escalated' ] } },
		{ id: 'k2', type: 'exactly_once', values: { key: 'invoiceId', action: 'payment' } },
		{ id: 'k3', type: 'account_from_master', values: { param: 'iban' } },
		{ id: 'k4', type: 'sum_max', values: { max: 5000 } },
		{ id: 'k5', type: 'human_approval', values: { actions: [ 'payment' ] } },
	],
} );

// Every outward action waits for a person's token (G-6); here the person approves at once.
async function send( egress, request ) {
	const _result = await egress.submit( request );
	if ( _result.status !== 'awaiting_approval' ) { return _result; }
	return egress.redeemNow( await egress.decide( _result.approval, 'approve', 'hr-lead' ) );
}

const reply = ( hash, cohort, labels = [ 'own' ] ) => ( {
	contract: hash, action: 'reply', target: 'ceo', params: { body: 'Workload is the main reason' }, labels: { body: labels }, cohort,
} );

const pay = ( hash, invoiceId, iban, ibanLabels, amount = 1200 ) => ( {
	contract: hash, action: 'payment', target: 'bank', params: { invoiceId, iban, amount }, labels: { iban: ibanLabels },
} );

test( 'nothing leaves before a person confirmed the goal at the gate', async () => {
	const { egress, hash } = survey();
	const _result = await egress.submit( reply( hash, people( 12 ) ) );
	assert.equal( _result.status, 'refused' );
	assert.match( _result.reasons[ 0 ].reason, /not confirmed/ );
} );

test( 'survey: two people are blocked, twelve pass, "the same without Anna" is blocked', async () => {
	const { egress, hash } = survey();
	egress.confirm( hash, 'hr-lead' );
	const _two = await egress.submit( reply( hash, [ 'r01', 'r02' ] ) );
	assert.equal( _two.status, 'refused' );
	assert.match( _two.reasons.map( item => item.reason ).join(), /group of 2 < 5/ );
	const _twelve = await send( egress, reply( hash, people( 12 ) ) );
	assert.equal( _twelve.status, 'executed' );
	assert.ok( _twelve.receipt.id );
	const _withoutAnna = await egress.submit( reply( hash, people( 12 ).filter( id => id !== 'r07' ) ) );
	assert.equal( _withoutAnna.status, 'refused' );
	assert.match( _withoutAnna.reasons[ 0 ].reason, /differs from an earlier release by 1 person/ );
	const _again = await send( egress, reply( hash, people( 12 ) ) );
	assert.equal( _again.status, 'executed', 'the very same group may be asked again' );
} );

test( 'confidential data leaves only as a group the goal allows (10.4); single records never', async () => {
	const { egress, hash } = survey();
	egress.confirm( hash, 'hr-lead' );
	const _rows = await egress.submit( reply( hash, null, [ 'confidential' ] ) );
	assert.equal( _rows.status, 'refused' );
	assert.match( _rows.reasons[ 0 ].reason, /without a declared group/ );
	const _group = await egress.submit( reply( hash, people( 12 ), [ 'confidential' ] ) );
	assert.equal( _group.status, 'awaiting_approval', 'the survey goal allows a group of twelve' );
	const { egress: _payments, hash: _invoices } = invoices();
	_payments.confirm( _invoices, 'finance-lead' );
	const _leak = await _payments.submit( { ...reply( _invoices, people( 12 ), [ 'confidential' ] ) } );
	assert.match( _leak.reasons.map( item => item.reason ).join(), /may not leave under this goal/ );
} );

test( 'invoices: foreign account refused, master account waits for a person, second payment refused', async () => {
	const { egress, store, hash } = invoices();
	egress.confirm( hash, 'finance-lead' );
	store.addMaster( 'account', [ 'DE02120300000000202051' ] );
	const _foreign = await egress.submit( pay( hash, 'R-1187', 'DE89370400440532013000', [ 'foreign' ] ) );
	assert.equal( _foreign.status, 'refused' );
	assert.deepEqual( _foreign.reasons.map( item => item.rule ).sort(), [ 'flow', 'known_account', 'sensitive' ] );
	const _first = await egress.submit( pay( hash, 'R-1187', 'DE02120300000000202051', [ 'own' ] ) );
	assert.equal( _first.status, 'awaiting_approval' );
	await assert.rejects( egress.decide( _first.approval, 'approve', 'finance-lead' ), /needs a reason/, 'money needs a reason (5.3)' );
	const _approved = await egress.decide( _first.approval, 'approve', 'finance-lead', { reason: 'invoice checked against the order' } );
	assert.equal( _approved.status, 'approved', 'an approval issues a token; it sends nothing by itself' );
	assert.equal( ( await egress.redeemNow( _approved ) ).status, 'executed' );
	const _twice = await egress.submit( pay( hash, 'R-1187', 'DE02120300000000202051', [ 'own' ] ) );
	assert.equal( _twice.status, 'refused' );
	assert.match( _twice.reasons[ 0 ].reason, /R-1187 already has a payment \(executed\)/ );
	await assert.rejects( egress.decide( _first.approval, 'approve', 'finance-lead' ), /no pending approval/ );
} );

test( 'invoices: sum cap and withdrawal before approval', async () => {
	const { egress, store, hash } = invoices();
	egress.confirm( hash, 'finance-lead' );
	store.addMaster( 'account', [ 'DE02120300000000202051' ] );
	const _big = await egress.submit( pay( hash, 'R-1186', 'DE02120300000000202051', [ 'own' ], 6000 ) );
	assert.match( _big.reasons[ 0 ].reason, /sum would reach 6000 > 5000/ );
	const _waiting = await egress.submit( pay( hash, 'R-1186', 'DE02120300000000202051', [ 'own' ], 900 ) );
	assert.equal( egress.withdraw( _waiting.delivery ).status, 'not_sent' );
	await assert.rejects( egress.decide( _waiting.approval, 'approve', 'finance-lead' ), /no pending approval/ );
} );

test( 'the criticality of the action decides: unknown actions never leave, outward ones wait for a person', async () => {
	const { egress, hash } = survey();
	egress.confirm( hash, 'hr-lead' );
	const _unknown = await egress.submit( { ...reply( hash, people( 12 ) ), action: 'delete_files' } );
	assert.equal( _unknown.status, 'refused' );
	assert.match( _unknown.reasons[ 0 ].reason, /not a known action/ );
	const _reply = await egress.submit( reply( hash, people( 12 ) ) );
	assert.equal( _reply.status, 'awaiting_approval' );
	assert.equal( egress.pendingApprovals()[ 0 ].summary.criticality, 'outward' );
} );

test( 'leases: a stale fencing token or an expired lease starts nothing; no lease outlives the deadline plus buffer (A4, A6, A7)', async () => {
	const { egress, hash, clock } = survey();
	egress.confirm( hash, 'hr-lead' );
	const _old = egress.lease( { node: 'n1', move: 'reply.send', contract: hash, minutes: 5 } );
	const _new = egress.lease( { node: 'n1', move: 'reply.send', contract: hash, minutes: 5 } );
	assert.equal( _new.fence, _old.fence + 1 );
	const _late = await egress.submitRaw( { ...reply( hash, people( 12 ) ), lease: _old.id, fence: _old.fence } );
	assert.equal( _late.status, 'refused' );
	assert.equal( _late.reasons[ 0 ].rule, 'lease' );
	const _none = await egress.submitRaw( reply( hash, people( 12 ) ) );
	assert.equal( _none.reasons[ 0 ].rule, 'lease', 'without a lease nothing starts (A8)' );
	const _current = await egress.submitRaw( { ...reply( hash, people( 12 ) ), lease: _new.id, fence: _new.fence } );
	assert.equal( _current.status, 'awaiting_approval' );
	clock.now += 6 * 60000;
	assert.equal( egress.leases.beat( _new.id, _new.fence ).ok, false, 'an expired lease cannot be renewed' );
	const _long = egress.lease( { node: 'n2', move: 'wait', contract: hash, minutes: 60 * 24 * 30 } );
	assert.equal( _long.maxUntil, '2026-11-07T17:05:00.000Z', 'root deadline plus five minutes' );
} );

test( 'nothing new leaves after deadline plus buffer', async () => {
	const { egress, hash, clock } = survey();
	egress.confirm( hash, 'hr-lead' );
	clock.now = Date.parse( '2026-11-07T17:06:00Z' );
	const _late = await egress.submit( reply( hash, people( 12 ) ) );
	assert.equal( _late.status, 'refused' );
	assert.match( _late.reasons[ 0 ].reason, /expired/ );
} );

test( 'a child is confirmed by derivation only when it is at least as strict: every gate and flow rule, no wider allowance', () => {
	const _rules = ( flow, allow ) => ( {
		gate: [ { rule: 'min_group', k: 5, criterion: 'k2' }, { rule: 'expires', actions: [ '*' ], at: '2026-11-07T17:00:00Z', criterion: 'contract' } ],
		flow, allow,
	} );
	const _noForeignIban = { param: 'iban', mustNot: [ 'foreign' ], actions: [ 'payment' ], criterion: 'k4' };
	const _groupMayLeave = { label: 'confidential', as: 'group', actions: [ 'report' ], criterion: 'k1' };
	const _parent = _rules( [ _noForeignIban ], [ _groupMayLeave ] );
	assert.equal( Egress.covers( _rules( [ { ..._noForeignIban, criterion: 'c9' } ], [] ), _parent ), true, 'the same rules from other criteria, less allowed' );
	assert.equal( Egress.covers( _rules( [], [ _groupMayLeave ] ), _parent ), false, 'a flow rule of the parent is missing' );
	const _wider = { label: 'confidential', as: 'raw', actions: [ 'report' ], criterion: 'k1' };
	assert.equal( Egress.covers( _rules( [ _noForeignIban ], [ _groupMayLeave, _wider ] ), _parent ), false, 'the child would allow more to leave' );
} );
