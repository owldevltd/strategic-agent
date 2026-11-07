// gate/proposals.js under attack: what the agent proposes and the operator decides at the gate (AGENCY_PROPOSALS).
// Actions the table lacks: never a name it has, never below outward, money only as money_or_law. Master data: never an
// account or a kind an account rule checks against, never a value from outside or of unknown origin, never for a case
// from outside, only a value the confirmed goal names. Nothing changes before a person decided; a decision is taken
// once; what was approved can be taken back; the gate's own copy comes back after a restart.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { gate, surveySpec, invoiceSpec, reply, people, Proposals, Actions } from './fixture.mjs';

const S = 'gate/proposals.js';
const NOTICE = { criticality: 'outward', carries: [ 'message' ], says: 'a short notice to a customer about their order' };

// A gate with proposals on, its goal confirmed; propose( kind, body, labels ) submits as the core would.
function on( options = {} ) {
	const g = gate( { proposals: true, ...options } );
	g.propose = ( kind, body, labels = undefined, extra = {} ) => g.egress.proposals.submit( { contract: g.hash, node: 'n1', kind, body, labels, ...extra } );
	g.action = ( name = 'notice', entry = NOTICE ) => g.propose( 'action', { name, entry } );
	g.master = ( kind, value, labels = [ 'own' ] ) => g.propose( 'master', { kind, value }, labels );
	return g;
}
const refused = ( fn, status = 400, said = /./ ) => assert.throws( fn, error => error.refusal === true && error.status === status && said.test( error.message ) );
const forget = () => Actions.forget( 'notice' );

attack( S, 'off: without AGENCY_PROPOSALS the gate takes no proposal (404)', () => {
	const g = gate();
	refused( () => g.egress.proposals.submit( { contract: g.hash, kind: 'action', body: { name: 'notice', entry: NOTICE } } ), 404, /proposals are off/ );
	assert.equal( g.db.get( 'SELECT COUNT(*) AS n FROM gate_proposals' ).n, 0 );
} );

attacks( S, [
	{ name: 'refused: a goal the gate does not know', request: () => ( { contract: 'no-such-hash' } ), status: 404 },
	{ name: 'refused: a goal that is no text', request: g => ( { contract: { hash: g.hash } } ), status: 404 },
	{ name: 'refused: a goal still waiting for its person', request: () => ( {} ), status: 409, unconfirmed: true },
	{ name: 'refused: a kind that is none of the two', request: g => ( { contract: g.hash, kind: 'channel' } ), status: 400 },
	{ name: 'refused: a proposal without a body', request: g => ( { contract: g.hash, kind: 'action', body: null } ), status: 400 },
	{ name: 'refused: a body that is a list', request: g => ( { contract: g.hash, kind: 'master', body: [ 'recipient', 'hr' ] } ), status: 400 },
], ( { request, status, unconfirmed } ) => {
	const g = on( unconfirmed ? { confirm: false } : {} );
	const _request = unconfirmed ? { contract: g.hash, kind: 'action', body: { name: 'notice', entry: NOTICE } } : { kind: 'action', body: { name: 'notice', entry: NOTICE }, ...request( g ) };
	refused( () => g.egress.proposals.submit( _request ), status );
	assert.equal( g.db.get( 'SELECT COUNT(*) AS n FROM gate_proposals' ).n, 0 );
} );

attack( S, 'refused: a goal whose root names no kind of task proposes nothing', () => {
	const g = on( { spec: surveySpec( { kind: undefined } ) } );
	refused( () => g.action(), 400, /without a kind of task/ );
} );

// Actions.
attacks( S, [
	{ name: 'action: a name the table has (report)', name2: 'report', entry: NOTICE, said: /exists already/ },
	{ name: 'action: a name a mission brings (payment)', name2: 'payment', entry: NOTICE, said: /exists already/ },
	{ name: 'action: a name in capitals', name2: 'Notice', entry: NOTICE, said: /no action's name/ },
	{ name: 'action: a name with path parts', name2: '../notice', entry: NOTICE, said: /no action's name/ },
	{ name: 'action: __proto__ as the name', name2: '__proto__', entry: NOTICE, said: /no action's name/ },
	{ name: 'action: constructor as the name', name2: 'constructor', entry: NOTICE, said: /no action's name/ },
	{ name: 'action: criticality read', entry: { ...NOTICE, criticality: 'read' }, said: /at least outward/ },
	{ name: 'action: criticality internal', entry: { ...NOTICE, criticality: 'internal' }, said: /at least outward/ },
	{ name: 'action: no criticality', entry: { carries: [ 'message' ], says: 'x' }, said: /at least outward/ },
	{ name: 'action: money that is only outward', entry: { ...NOTICE, carries: [ 'money' ] }, said: /money is money_or_law/ },
	{ name: 'action: money that is irreversible but not money_or_law', entry: { ...NOTICE, criticality: 'irreversible', carries: [ 'money' ] }, said: /money is money_or_law/ },
	{ name: 'action: a carried kind nobody knows', entry: { ...NOTICE, carries: [ 'cash' ] }, said: /carries is a list/ },
	{ name: 'action: carries as one text', entry: { ...NOTICE, carries: 'message' }, said: /carries is a list/ },
	{ name: 'action: no text that says what it does', entry: { criticality: 'outward', carries: [] }, said: /says what the action does/ },
	{ name: 'action: a text of 201 characters', entry: { ...NOTICE, says: 'x'.repeat( 201 ) }, said: /says what the action does/ },
	{ name: 'action: a recipient type the gate does not know', entry: { ...NOTICE, recipient: 'email' }, said: /recipient is contact/ },
	{ name: 'action: inside for an action that carries no message', entry: { ...NOTICE, carries: [ 'data' ], inside: true }, said: /inside is true or false/ },
	{ name: 'action: an idempotency window below zero', entry: { ...NOTICE, idempotencyH: -1 }, said: /idempotencyH/ },
	{ name: 'action: an idempotency window of a thousand hours', entry: { ...NOTICE, idempotencyH: 1000 }, said: /idempotencyH/ },
	{ name: 'action: an idempotency window as text', entry: { ...NOTICE, idempotencyH: '72' }, said: /idempotencyH/ },
	{ name: 'action: a commitment that is no plain name', entry: { ...NOTICE, commits: 'Pay Now' }, said: /commits is a plain name/ },
	{ name: 'action: a parameter of a type nobody knows', entry: { ...NOTICE, params: { amount: 'money' } }, said: /params maps/ },
	{ name: 'action: a field the table does not have', entry: { ...NOTICE, channel: 'smtp' }, said: /channel is no field/ },
	{ name: 'action: sensitive as one text', entry: { ...NOTICE, sensitive: 'iban' }, said: /sensitive is a list/ },
], ( { name2 = 'notice', entry, said } ) => {
	const g = on();
	refused( () => g.action( name2, entry ), 400, said );
	assert.equal( g.egress.rules.actions.known( name2 ), name2 === 'report' || name2 === 'payment' );
} );

attacks( S, [
	{ name: 'action: a message to the outside is a proposal', entry: NOTICE },
	{ name: 'action: a payment of its own as money_or_law is a proposal', entry: { criticality: 'money_or_law', carries: [ 'money' ], says: 'a deposit', sensitive: [ 'iban' ] } },
	{ name: 'action: an irreversible action that carries nothing is a proposal', entry: { criticality: 'irreversible', carries: [], says: 'closes an account', params: { ref: 'string' } } },
	{ name: 'action: a message to contacts only is a proposal', entry: { ...NOTICE, recipient: 'contact', idempotencyH: 72 } },
], ( { entry } ) => {
	const g = on();
	const _row = g.action( 'notice', entry );
	assert.equal( _row.status, 'proposed' );
	assert.equal( g.egress.rules.actions.known( 'notice' ), false, 'nothing changes before a person decided' );
	assert.equal( _row.scope, 'hr-survey' );
} );

attack( S, 'action: the same open proposal twice is one proposal', () => {
	const g = on();
	assert.equal( g.action().id, g.action().id );
	assert.equal( g.db.get( 'SELECT COUNT(*) AS n FROM gate_proposals' ).n, 1 );
} );

attack( S, 'decide: an approved action is in the gate\'s table at once, and a request for it is checked like any other', async () => {
	const g = on();
	try {
		const _row = g.action();
		g.egress.proposals.decide( _row.id, 'approve', 'ops-lead', 'a notice is fine' );
		assert.equal( g.egress.rules.actions.criticality( 'notice' ), 'outward' );
		const _asked = await g.submit( { action: 'notice', target: 'ceo', params: { body: 'Late by two days.' }, labels: { body: [ 'own' ] } } );
		assert.equal( _asked.status, 'awaiting_approval', 'each use still waits for a person (G-6)' );
	} finally {
		forget();
	}
} );

attack( S, 'decide: a rejected action changes nothing', () => {
	const g = on();
	const _row = g.action();
	assert.equal( g.egress.proposals.decide( _row.id, 'reject', 'ops-lead' ).status, 'rejected' );
	assert.equal( g.egress.rules.actions.known( 'notice' ), false );
} );

attacks( S, [
	{ name: 'decide: a second decision is refused (409)', setup: ( g, id ) => g.egress.proposals.decide( id, 'reject' ), decision: 'approve', status: 409 },
	{ name: 'decide: "yes" is no decision', setup: () => null, decision: 'yes', status: 400 },
	{ name: 'decide: an empty decision is none', setup: () => null, decision: '', status: 400 },
	{ name: 'decide: an unknown proposal is 404', setup: () => null, decision: 'approve', status: 404, id: 'gp-nothing' },
	{ name: 'decide: an action whose name the table got meanwhile is refused (409)', setup: ( g ) => {
		g.egress.rules.actions.table.notice = { ...NOTICE };
	}, decision: 'approve', status: 409 },
], ( { setup, decision, status, id } ) => {
	const g = on();
	const _row = g.action();
	setup( g, _row.id );
	refused( () => g.egress.proposals.decide( id || _row.id, decision, 'ops-lead' ), status );
} );

attack( S, 'revoke: a revoked action leaves the table; a request for it is refused as unknown', async () => {
	const g = on();
	try {
		const _row = g.action();
		g.egress.proposals.decide( _row.id, 'approve' );
		assert.equal( g.egress.proposals.revoke( _row.id, 'ops-lead', 'not needed any more' ).status, 'revoked' );
		assert.equal( g.egress.rules.actions.known( 'notice' ), false );
		const _asked = await g.submit( { action: 'notice', target: 'ceo', params: { body: 'x' }, labels: { body: [ 'own' ] } } );
		assert.equal( _asked.status, 'refused' );
	} finally {
		forget();
	}
} );

attacks( S, [
	{ name: 'revoke: an open proposal is not revoked (409)', approve: false, id: null, status: 409 },
	{ name: 'revoke: an unknown proposal is 404', approve: false, id: 'gp-nothing', status: 404 },
], ( { id, status } ) => {
	const g = on();
	const _row = g.action();
	refused( () => g.egress.proposals.revoke( id || _row.id ), status );
} );

attack( S, 'list: the proposals of one kind of task only, when a scope is named', () => {
	const g = on();
	g.action();
	assert.equal( g.egress.proposals.list( 'proposed', 'hr-survey' ).length, 1 );
	assert.equal( g.egress.proposals.list( 'proposed', 'supplier-payments' ).length, 0 );
	assert.equal( g.egress.proposals.list( 'proposed' ).length, 1, 'without a scope, every kind' );
} );

attack( S, 'learned: only approved actions, never rejected, revoked or master data', () => {
	const g = on();
	try {
		g.egress.proposals.decide( g.action( 'notice' ).id, 'approve' );
		g.egress.proposals.decide( g.action( 'memo', { ...NOTICE, says: 'a memo' } ).id, 'reject' );
		g.egress.proposals.decide( g.master( 'recipient', 'morale' ).id, 'approve' );
		assert.deepEqual( Object.keys( g.egress.proposals.learned() ), [ 'notice' ] );
	} finally {
		forget();
	}
} );

attack( S, 'load: after a restart the approved actions are in the gate\'s table again; one the files have meanwhile is left out', () => {
	const g = on();
	try {
		g.egress.proposals.decide( g.action().id, 'approve' );
		forget();
		const _fresh = gate( { db: g.db, proposals: true } );
		assert.equal( _fresh.egress.rules.actions.known( 'notice' ), false, 'not before load' );
		_fresh.egress.proposals.load();
		assert.equal( _fresh.egress.rules.actions.known( 'notice' ), true );
		forget();
		const _shadowed = gate( { db: g.db, proposals: true } );
		_shadowed.egress.rules.actions.table.notice = { criticality: 'irreversible', carries: [], says: 'the operator\'s own' };
		_shadowed.egress.proposals.load();
		assert.equal( _shadowed.egress.rules.actions.criticality( 'notice' ), 'irreversible', 'the files win' );
		assert.ok( _shadowed.events( 'proposal_shadowed' ).length >= 1 );
	} finally {
		forget();
	}
} );

// Master data.
attacks( S, [
	{ name: 'master: an account is never proposed', kind: 'account', value: 'hr', said: /only the operator enters it/ },
	{ name: 'master: a kind an account rule of the goal checks against is never proposed', kind: 'supplier', value: 'hr', said: /only the operator enters it/,
		spec: () => invoiceSpec( { criteria: [ { id: 'k3', type: 'account_from_master', values: { param: 'iban', kind: 'supplier' } }, { id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'morale' } } ] } ) },
	{ name: 'master: a value labelled foreign is never proposed', kind: 'recipient', value: 'morale', labels: [ 'foreign' ], said: /from outside/ },
	{ name: 'master: a value own and foreign at once is never proposed', kind: 'recipient', value: 'morale', labels: [ 'own', 'foreign' ], said: /from outside/ },
	{ name: 'master: a value without labels is never proposed', kind: 'recipient', value: 'morale', labels: [], said: /of unknown origin/ },
	{ name: 'master: labels that are no list are none', kind: 'recipient', value: 'morale', labels: 'own', said: /of unknown origin/ },
	{ name: 'master: a value the goal does not name', kind: 'recipient', value: 'finance', said: /the confirmed goal itself names/ },
	{ name: 'master: a contact pair of which one part is not named', kind: 'contact', value: 'hr someone@else.example', said: /the confirmed goal itself names/ },
	{ name: 'master: a value already on file for the kind', kind: 'recipient', value: 'hr', said: /on file already/ },
	{ name: 'master: an empty value', kind: 'recipient', value: '   ', said: /at most 200 characters/ },
	{ name: 'master: a value of 201 characters', kind: 'recipient', value: 'x'.repeat( 201 ), said: /at most 200 characters/ },
	{ name: 'master: a value that is no text', kind: 'recipient', value: 42, said: /at most 200 characters/ },
	{ name: 'master: a kind with path parts', kind: '../recipient', value: 'morale', said: /plain name/ },
	{ name: 'master: a kind that is no text', kind: [ 'recipient' ], value: 'morale', said: /plain name/ },
], ( { kind, value, labels = [ 'own' ], said, spec } ) => {
	const g = on( spec ? { spec: { ...spec(), kind: 'hr-survey' }, master: [] } : {} );
	refused( () => g.master( kind, value, labels ), 400, said );
} );

attack( S, 'master: a case that came from outside proposes no master data', () => {
	const g = on();
	const { contract } = g.child( { id: 'survey/in-1', goal: 'Answer the sender', deadline: g.contract.deadline, kind: 'request', parent: g.hash,
		criteria: [ { id: 'k1', type: 'report_delivered', values: { to: 'morale', topic: 'x', action: 'reply' } } ] } );
	g.egress.confirm( contract.hash, 'person' );
	refused( () => g.egress.proposals.submit( { contract: contract.hash, kind: 'master', body: { kind: 'recipient', value: 'morale' }, labels: [ 'own' ] } ),
		400, /case that came from outside/ );
} );

attack( S, 'master: a value the goal names is a proposal; approved, it serves the goals of this kind only', () => {
	const g = on();
	const _row = g.master( 'recipient', 'morale' );
	assert.equal( g.store.isMaster( 'recipient', 'morale', 'hr-survey' ), false, 'nothing before a person decided' );
	g.egress.proposals.decide( _row.id, 'approve', 'ops-lead' );
	assert.equal( g.store.isMaster( 'recipient', 'morale', 'hr-survey' ), true );
	assert.equal( g.store.isMaster( 'recipient', 'morale', 'supplier-payments' ), false );
	assert.equal( g.store.isMaster( 'recipient', 'morale' ), false, 'not for every goal' );
} );

attack( S, 'master: a contact pair whose parts the goal both names is a proposal', () => {
	const g = on();
	assert.equal( g.master( 'contact', 'hr morale' ).status, 'proposed' );
} );

attack( S, 'master: a revoked value serves nobody any more', () => {
	const g = on();
	const _row = g.master( 'recipient', 'morale' );
	g.egress.proposals.decide( _row.id, 'approve' );
	g.egress.proposals.revoke( _row.id );
	assert.equal( g.store.isMaster( 'recipient', 'morale', 'hr-survey' ), false );
} );

attack( S, 'master: what a proposal added a restart keeps (it is master data of its kind, from a person)', () => {
	const g = on();
	g.egress.proposals.decide( g.master( 'recipient', 'morale' ).id, 'approve' );
	const _fresh = gate( { db: g.db, proposals: true } );
	assert.equal( _fresh.store.isMaster( 'recipient', 'morale', 'hr-survey' ), true );
} );

attack( S, 'log: received, approved, rejected and revoked are each an event with who decided', () => {
	const g = on();
	try {
		const _a = g.action();
		g.egress.proposals.decide( _a.id, 'approve', 'ops-lead' );
		g.egress.proposals.revoke( _a.id, 'ops-lead' );
		g.egress.proposals.decide( g.master( 'recipient', 'morale' ).id, 'reject', 'ops-lead' );
		assert.deepEqual( [ 'proposal_received', 'proposal_approved', 'proposal_revoked', 'proposal_rejected' ].map( kind => g.events( kind ).length ), [ 2, 1, 1, 1 ] );
		assert.equal( g.events( 'proposal_approved' )[ 0 ].by, 'ops-lead' );
	} finally {
		forget();
	}
} );

attacks( S, [
	{ name: 'named: a value among the criteria\'s values', value: 'hr', want: true },
	{ name: 'named: a value in a list of values', value: 'design', spec: { criteria: [ { values: { teams: [ 'design', 'product' ] } } ] }, want: true },
	{ name: 'named: a value only in the goal\'s text is not named by a criterion', value: 'unhappy', want: false },
	{ name: 'named: a part of a value is not the value', value: 'h', want: false },
	{ name: 'named: no criteria name nothing', value: 'hr', spec: {}, want: false },
], ( { value, spec = surveySpec(), want } ) => {
	assert.equal( Proposals.named( spec, value ), want );
} );

attack( S, 'way out: an approved reply to a person on file still needs its own approval each time (G-6)', async () => {
	const g = on();
	const _asked = await g.submit( reply( people( 12 ) ) );
	assert.equal( _asked.status, 'awaiting_approval' );
} );
