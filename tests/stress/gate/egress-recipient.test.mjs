// gate/egress.js and gate/store.js: a recipient named by its reference (6.2: the recipient is a contact reference) goes to the one
// address the operator's master data holds for it; the approval, the hash (18.5: the hash covers the resolved recipient), the
// rules and the channel all see that address, and a change of it after the approval is another action (F5).
// Attacks: an address the core tries to name itself, two addresses for one reference, a reference that is the prefix
// of another, wildcards, a private address, another customer's reference, a master change after the approval.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { gate, reply, people, actionsWith, DEADLINE } from './fixture.mjs';

const S = 'gate/egress.js';
const STORE = 'gate/store.js';
const twelve = people( 12 );

// A copy of an invoice reminder for one customer (a release about one person, kind to_data_subject).
const SUBJECT = { id: 'dunning', goal: 'Remind customers of overdue invoices', deadline: DEADLINE, criteria: [ { id: 'k1', type: 'to_data_subject', values: {} } ] };
const ACTIONS = actionsWith( { reminder: { criticality: 'outward', carries: [ 'data', 'message' ], sensitive: [], says: 'a payment reminder' } } );
const CONTACTS = [ 'C104 billing@wingtip.example', 'C105 ap@fabrikam.example' ];
const remind = ( target, cohort = [ 'C104' ], extra = {} ) => ( {
	action: 'reminder', target, params: { body: 'Invoice 2026-0322 is open.' }, labels: { body: [ 'confidential' ] }, cohort, ...extra,
} );
function dunning( contacts = CONTACTS ) {
	const g = gate( { spec: SUBJECT, actions: ACTIONS, recipients: [ 'C104', 'C105', 'billing@wingtip.example', 'm.private@freemail.example' ] } );
	g.store.addMaster( 'contact', contacts );
	return g;
}
function survey( contacts = [ 'ceo ceo@contoso.example' ] ) {
	const g = gate();
	g.store.addMaster( 'contact', contacts );
	return g;
}

attack( S, '6.2: a target that is a contact reference goes to the one address on file; the target stays the reference', async () => {
	const g = survey();
	const _result = await g.send( reply( twelve ) );
	assert.equal( _result.status, 'executed' );
	assert.deepEqual( [ g.row( _result.delivery ).target, g.row( _result.delivery ).address ], [ 'ceo', 'ceo@contoso.example' ] );
	assert.deepEqual( g.outbox().map( row => [ row.target, row.address ] ), [ [ 'ceo', 'ceo@contoso.example' ] ] );
} );

attack( S, '10.4: the person approves exactly where it goes: the summary shows the address', async () => {
	const g = survey();
	const _result = await g.submit( reply( twelve ) );
	const _summary = JSON.parse( g.approval( _result.approval ).summary );
	assert.deepEqual( [ _summary.target, _summary.address ], [ 'ceo', 'ceo@contoso.example' ] );
} );

attack( S, '18.5: the hash covers the resolved address: the same action to another address is another action', async () => {
	const g = survey();
	const _result = await g.submit( reply( twelve ) );
	const _row = g.row( _result.delivery );
	assert.equal( _row.actionHash, g.egress.constructor.actionHash( _row ) );
	assert.notEqual( _row.actionHash, g.egress.constructor.actionHash( { ..._row, address: 'evil@attacker.example' } ) );
	assert.notEqual( _row.actionHash, g.egress.constructor.actionHash( { ..._row, address: null } ) );
} );

attack( S, '18.5: without an address the hash is what it always was (ledgers from before keep their approvals)', async () => {
	const g = gate();
	const _result = await g.submit( reply( twelve ) );
	const _row = g.row( _result.delivery );
	assert.equal( _row.address, null );
	const { contract, action, target, params } = _row;
	assert.equal( _row.actionHash, g.egress.constructor.actionHash( { contract, action, target, params } ) );
} );

attack( S, 'F5: an address changed in the master data after the approval does not move the approved action', async () => {
	const g = survey();
	const _waiting = await g.submit( reply( twelve ) );
	await g.approve( _waiting );
	g.db.run( 'DELETE FROM master WHERE kind = \'contact\'' );
	g.store.addMaster( 'contact', [ 'ceo new-ceo@contoso.example' ] );
	await g.redeem( _waiting );
	assert.deepEqual( g.outbox().map( row => row.address ), [ 'ceo@contoso.example' ] );
	const _next = await g.submit( reply( twelve ) );
	assert.equal( g.row( _next.delivery ).address, 'new-ceo@contoso.example', 'a new action is resolved anew' );
} );

attack( S, 'a reference with two addresses on file is refused: which one is meant cannot be told (fail closed)', async () => {
	const g = survey( [ 'ceo ceo@contoso.example', 'ceo ceo.private@freemail.example' ] );
	const _result = await g.submit( reply( twelve ) );
	assert.equal( _result.status, 'refused' );
	assert.match( _result.reasons[ 0 ].reason, /ceo has 2 addresses on file/ );
	assert.equal( g.outbox().length, 0 );
} );

attacks( S, [
	{ name: 'the core cannot name the address itself: an address in the request is not read', extra: { address: 'evil@attacker.example' }, want: 'ceo@contoso.example' },
	{ name: 'nor can it hide one in the parameters', extra: { params: { body: 'x', address: 'evil@attacker.example' } }, want: 'ceo@contoso.example' },
], async ( { extra, want } ) => {
	const g = survey();
	const _result = await g.submit( reply( twelve, [ 'own' ], extra ) );
	assert.equal( g.row( _result.delivery ).address, want );
} );

attack( S, 'the core cannot name an address for a target that has none: it is ignored, the target stays as named', async () => {
	const g = gate();
	const _result = await g.submit( reply( twelve, [ 'own' ], { address: 'evil@attacker.example' } ) );
	assert.equal( g.row( _result.delivery ).address, null );
} );

attacks( S, [
	{ name: 'a reference that is the start of another one finds nothing (C10 is not C104)', target: 'C10' },
	{ name: 'a wildcard finds nothing (C%)', target: 'C%' },
	{ name: 'a single-character wildcard finds nothing (C1_4)', target: 'C1_4' },
	{ name: 'the reference with a blank behind it is no reference', target: 'C104 ' },
	{ name: 'an address is no reference of its own', target: 'billing@wingtip.example' },
	{ name: 'the reference in other letters is another reference', target: 'c104' },
], async ( { target } ) => {
	const g = dunning();
	assert.deepEqual( g.store.addresses( target ), [] );
} );

attack( S, 'to_data_subject: the copy for C104 named by its reference goes to C104\'s address on file', async () => {
	const g = dunning();
	const _result = await g.send( remind( 'C104' ) );
	assert.equal( _result.status, 'executed', JSON.stringify( _result.reasons ) );
	assert.deepEqual( g.outbox().map( row => row.address ), [ 'billing@wingtip.example' ] );
} );

attack( S, 'to_data_subject: the copy for C104 to the reference of another customer is refused (C105\'s address is not C104\'s)', async () => {
	const g = dunning();
	const _result = await g.submit( remind( 'C105' ) );
	assert.equal( _result.status, 'refused' );
	assert.ok( _result.reasons.some( item => item.rule === 'data_subject' ) );
} );

attack( S, 'to_data_subject: a private address a customer wrote in a mail is refused, even when listed as a recipient', async () => {
	const g = dunning();
	const _result = await g.submit( remind( 'm.private@freemail.example' ) );
	assert.equal( _result.status, 'refused' );
	assert.ok( _result.reasons.some( item => item.rule === 'data_subject' ) );
} );

attack( S, 'to_data_subject: the address on file named directly still goes, as before', async () => {
	const g = dunning();
	const _result = await g.send( remind( 'billing@wingtip.example' ) );
	assert.equal( _result.status, 'executed', JSON.stringify( _result.reasons ) );
	assert.equal( g.row( _result.delivery ).address, null );
} );

attack( S, 'to_data_subject: a reference with no address on file gets nothing (the pair "C106 C106" is not on file)', async () => {
	const g = dunning();
	g.store.addMaster( 'recipient', [ 'C106' ] );
	const _result = await g.submit( remind( 'C106', [ 'C106' ] ) );
	assert.equal( _result.status, 'refused' );
} );

attack( S, 'a refused request is booked without an address', async () => {
	const g = dunning();
	const _result = await g.submit( remind( 'C105' ) );
	assert.equal( g.row( _result.delivery ).address, null );
} );

attack( S, 'the log of an accepted request names the address it will go to', async () => {
	const g = survey();
	await g.submit( reply( twelve ) );
	assert.equal( g.events( 'request_accepted' )[ 0 ].address, 'ceo@contoso.example' );
} );

// The store's side: the addresses on file for a reference, read exactly.
attacks( STORE, [ undefined, null, 42, {}, [ 'C104' ], '', ' ', 'C1 04', 'x'.repeat( 201 ), 'C104\nC105' ].map( ref => ( {
	name: `addresses(): ${JSON.stringify( ref )?.slice( 0, 30 ) ?? 'undefined'} is no reference and finds nothing`, ref,
} ) ), ( { ref } ) => {
	const g = dunning();
	assert.deepEqual( g.store.addresses( ref ), [] );
} );

attack( STORE, 'addresses(): every address on file for a reference, in order', () => {
	const g = dunning( [ 'C104 b@wingtip.example', 'C104 a@wingtip.example', 'C105 ap@fabrikam.example' ] );
	assert.deepEqual( g.store.addresses( 'C104' ), [ 'a@wingtip.example', 'b@wingtip.example' ] );
} );

attack( STORE, 'addresses(): only contacts count, not an account or a recipient that looks alike', () => {
	const g = dunning( [] );
	g.store.addMaster( 'recipient', [ 'C104 billing@wingtip.example' ] );
	g.store.addMaster( 'account', [ 'C104 DE02120300000000202051' ] );
	assert.deepEqual( g.store.addresses( 'C104' ), [] );
} );

attack( STORE, 'an older ledger without the address column gets it at the next start, and keeps its rows', async () => {
	const g = gate();
	const _result = await g.submit( reply( twelve ) );
	g.db.exec( 'ALTER TABLE deliveries DROP COLUMN address' );
	const _again = gate( { db: g.db } );
	assert.equal( _again.row( _result.delivery ).address, null );
	assert.equal( _again.row( _result.delivery ).status, 'awaiting_approval' );
} );

// 6.2 (the recipient is a contact reference): an action whose recipient is of type contact goes only to a reference on file. A business
// customer's reminder needs no rule about one person's data for that: the action table says it.
const TYPED = actionsWith( { notice: { criticality: 'outward', carries: [ 'message' ], sensitive: [], says: 'a payment reminder', recipient: 'contact' } } );
const NOTICE = { id: 'dunning', goal: 'Remind customers of overdue invoices', deadline: DEADLINE,
	criteria: [ { id: 'k1', type: 'human_approval', values: { actions: [ 'notice' ] } } ] };
const notice = target => ( { action: 'notice', target, params: { body: 'Invoice 2026-0322 is open.' }, labels: { body: [ 'own' ] } } );
function typed( contacts = CONTACTS ) {
	const g = gate( { spec: NOTICE, actions: TYPED } );
	g.store.addMaster( 'contact', contacts );
	return g;
}

attack( S, '6.2: a reminder of recipient type contact named by the customer\'s reference goes to the address on file', async () => {
	const g = typed();
	const _result = await g.send( notice( 'C104' ) );
	assert.equal( _result.status, 'executed', JSON.stringify( _result.reasons ) );
	assert.deepEqual( g.outbox().map( row => [ row.target, row.address ] ), [ [ 'C104', 'billing@wingtip.example' ] ] );
} );

attacks( S, [
	{ name: '6.2: a private address a customer wrote in a mail is no contact on file: refused', target: 'm.private@freemail.example' },
	{ name: '6.2: even the address on file, named as an address, is no reference: refused (only the reference is typed)', target: 'billing@wingtip.example' },
	{ name: '6.2: a customer without an address on file gets nothing', target: 'C106' },
	{ name: '6.2: a reference with a blank is no reference', target: 'C104 billing@wingtip.example' },
	{ name: '6.2: no target at all is no contact', target: undefined },
], async ( { target } ) => {
	const g = typed();
	const _result = await g.submit( notice( target ) );
	assert.equal( _result.status, 'refused' );
	assert.equal( _result.reasons[ 0 ].rule, 'recipient' );
	assert.match( _result.reasons[ 0 ].reason, /notice goes only to a contact on file \(6\.2\)/ );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, '6.2: an action without a recipient type still goes to the target as the plan named it', async () => {
	const g = gate( { spec: NOTICE, actions: actionsWith( { notice: { criticality: 'outward', carries: [ 'message' ], sensitive: [] } } ) } );
	const _result = await g.send( notice( 'someone@example.org' ) );
	assert.equal( _result.status, 'executed', JSON.stringify( _result.reasons ) );
	assert.equal( g.row( _result.delivery ).address, null );
} );

attack( S, '6.2: the type is read from the gate\'s own table: a request cannot switch it off', async () => {
	const g = typed();
	const _result = await g.submit( { ...notice( 'm.private@freemail.example' ), recipient: 'any', actions: {} } );
	assert.equal( _result.status, 'refused' );
} );
