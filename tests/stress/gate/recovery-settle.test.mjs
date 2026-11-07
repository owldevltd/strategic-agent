// gate/recovery.js under attack: an unclear action (O5) is settled by a person who checked outside, as executed or as
// not sent. Only an unclear one, only once, only with one of the two answers; settling sends nothing; an executed one
// books its release, a not sent one no longer counts against "exactly once". The operator route of the gate process
// takes the pin; the core's token is no pin.
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { attack, attacks } from '../hostile.mjs';
import { gate, tick, invoiceSpec, reply, pay, people, startGate, proposal, surveySpec, quiet } from './fixture.mjs';

const S = 'gate/recovery.js';
const twelve = people( 12 );

// A reply (or a payment) whose only attempt failed at a service without the guarantee: unclear (G-7a).
async function unclear( { request = reply( twelve ), spec = undefined, failures = 1 } = {} ) {
	const g = gate( { plain: true, service: { failures }, ...( spec ? { spec } : {} ) } );
	const _result = await g.redeem( await g.approved( request ) );
	await tick( 5 );
	assert.equal( _result.status, 'unclear' );
	return { g, id: _result.delivery };
}

attacks( S, [
	{ name: 'settle: executed books the action as having taken effect', result: 'executed' },
	{ name: 'settle: not_sent books the action as never having taken effect', result: 'not_sent' },
], async ( { result } ) => {
	const { g, id } = await unclear();
	const _row = g.egress.settle( id, { result, by: 'finance lead', reason: 'checked with the bank' } );
	assert.equal( _row.status, result );
	assert.equal( _row.receipt.settled, result );
	assert.equal( _row.receipt.by, 'finance lead' );
	assert.equal( _row.receipt.reason, 'checked with the bank' );
	assert.deepEqual( g.egress.unclear(), [] );
	assert.deepEqual( g.events( 'settled' ).map( item => [ item.delivery, item.result, item.by ] ), [ [ id, result, 'finance lead' ] ] );
} );

attack( S, 'settle: the receipt keeps what the ledger said before', async () => {
	const { g, id } = await unclear();
	const _before = g.row( id ).receipt;
	assert.deepEqual( g.egress.settle( id, { result: 'not_sent' } ).receipt.before, _before );
} );

attack( S, 'settle: sends nothing, whatever the person says', async () => {
	const { g, id } = await unclear();
	const _sent = g.channel.sent.length;
	g.egress.settle( id, { result: 'executed' } );
	await tick( 10 );
	assert.equal( g.channel.sent.length, _sent );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'settle: executed books the release of the group it named, as a confirmed action does', async () => {
	const { g, id } = await unclear();
	g.egress.settle( id, { result: 'executed' } );
	assert.deepEqual( g.store.releasedCohorts( g.hash ), [ [ ...twelve ].sort() ] );
} );

attack( S, 'settle: not_sent books no release', async () => {
	const { g, id } = await unclear();
	g.egress.settle( id, { result: 'not_sent' } );
	assert.deepEqual( g.store.releasedCohorts( g.hash ), [] );
} );

attack( S, 'settle: an unclear payment blocks the same invoice; settled as not sent it no longer does', async () => {
	const { g, id } = await unclear( { spec: invoiceSpec(), request: pay( 'R-1186', 900 ) } );
	const _second = await g.submit( pay( 'R-1186', 900 ) );
	assert.equal( _second.status, 'refused', 'unclear counts as if it went out' );
	g.egress.settle( id, { result: 'not_sent', reason: 'the bank has no such transfer' } );
	assert.equal( ( await g.submit( pay( 'R-1186', 900 ) ) ).status, 'awaiting_approval' );
} );

attack( S, 'settle: an unclear payment settled as executed still blocks the same invoice', async () => {
	const { g, id } = await unclear( { spec: invoiceSpec(), request: pay( 'R-1186', 900 ) } );
	g.egress.settle( id, { result: 'executed', reason: 'the bank booked it' } );
	assert.equal( ( await g.submit( pay( 'R-1186', 900 ) ) ).status, 'refused' );
} );

attack( S, 'settle: a second settlement is refused (409) and changes nothing', async () => {
	const { g, id } = await unclear();
	g.egress.settle( id, { result: 'executed' } );
	assert.throws( () => g.egress.settle( id, { result: 'not_sent' } ), error => error.status === 409 && error.refusal === true );
	assert.equal( g.row( id ).status, 'executed' );
	assert.equal( g.events( 'settled' ).length, 1 );
} );

attacks( S, [
	{ name: 'settle: "sent" is no answer', result: 'sent' },
	{ name: 'settle: "unclear" is no answer', result: 'unclear' },
	{ name: 'settle: "open" is no answer, nothing is sent again', result: 'open' },
	{ name: 'settle: "refused" is no answer', result: 'refused' },
	{ name: 'settle: "EXECUTED" is no answer', result: 'EXECUTED' },
	{ name: 'settle: "executed " is no answer', result: 'executed ' },
	{ name: 'settle: the empty text is no answer', result: '' },
	{ name: 'settle: null is no answer', result: null },
	{ name: 'settle: true is no answer', result: true },
	{ name: 'settle: a list of the answer is no answer', result: [ 'executed' ] },
	{ name: 'settle: an object is no answer', result: { toString: () => 'executed' } },
], async ( { result } ) => {
	const { g, id } = await unclear();
	assert.throws( () => g.egress.settle( id, { result } ), error => error.status === 400 && error.refusal === true );
	assert.equal( g.row( id ).status, 'unclear' );
} );

attacks( S, [
	{ name: 'settle: a decision that is null is refused', decision: null },
	{ name: 'settle: a decision that is a text is refused', decision: 'executed' },
	{ name: 'settle: a decision that is a list is refused', decision: [ 'executed' ] },
	{ name: 'settle: no decision is refused', decision: undefined },
], async ( { decision } ) => {
	const { g, id } = await unclear();
	assert.throws( () => g.egress.settle( id, decision ), error => error.status === 400 );
	assert.equal( g.row( id ).status, 'unclear' );
} );

attacks( S, [
	{ name: 'settle: an unknown id is 404', id: 'dl-nothing' },
	{ name: 'settle: an id that is no text is 404', id: 42 },
	{ name: 'settle: null as the id is 404', id: null },
	{ name: 'settle: SQL as the id is 404', id: '\' OR 1=1 --' },
	{ name: 'settle: __proto__ as the id is 404', id: '__proto__' },
], async ( { id } ) => {
	const { g } = await unclear();
	assert.throws( () => g.egress.settle( id, { result: 'executed' } ), error => error.status === 404 );
	assert.equal( g.egress.unclear().length, 1 );
} );

attacks( S, [
	{ name: 'settle: an action still waiting for its person is not settled', status: 'awaiting_approval' },
	{ name: 'settle: an executed action is not settled', status: 'executed' },
	{ name: 'settle: an action not sent is not settled', status: 'not_sent' },
	{ name: 'settle: a refused action is not settled', status: 'refused' },
	{ name: 'settle: a rejected action is not settled', status: 'rejected' },
	{ name: 'settle: an open action is not settled: it may still go out', status: 'open' },
], async ( { status } ) => {
	const { g, id } = await unclear();
	g.db.run( 'UPDATE deliveries SET status = :status WHERE id = :id', { id, status } );
	assert.throws( () => g.egress.settle( id, { result: 'executed' } ), error => error.status === 409 );
	assert.equal( g.row( id ).status, status );
} );

attacks( S, [
	{ name: 'settle: without a name the person is the operator', by: undefined, want: 'operator' },
	{ name: 'settle: a name of blanks is the operator', by: '   ', want: 'operator' },
	{ name: 'settle: a name that is no text is the operator', by: { name: 'x' }, want: 'operator' },
	{ name: 'settle: a long name is cut to 100 characters', by: 'n'.repeat( 500 ), want: 'n'.repeat( 100 ) },
	{ name: 'settle: a name is trimmed', by: '  Mira  ', want: 'Mira' },
], async ( { by, want } ) => {
	const { g, id } = await unclear();
	assert.equal( g.egress.settle( id, { result: 'not_sent', by } ).receipt.by, want );
} );

attacks( S, [
	{ name: 'settle: a long reason is cut to 500 characters', reason: 'r'.repeat( 5000 ), want: 'r'.repeat( 500 ) },
	{ name: 'settle: a reason that is no text is none', reason: [ 'checked' ], want: '' },
	{ name: 'settle: without a reason the reason is empty', reason: undefined, want: '' },
], async ( { reason, want } ) => {
	const { g, id } = await unclear();
	assert.equal( g.egress.settle( id, { result: 'not_sent', reason } ).receipt.reason, want );
} );

attack( S, 'unclear: lists only unclear actions, oldest first, each as the ledger holds it', async () => {
	const { g, id } = await unclear( { failures: 2 } );
	g.clock.now += 1000;
	const _second = await g.redeem( await g.approved( reply( people( 12, 20 ) ) ) );
	await tick( 5 );
	assert.deepEqual( g.egress.unclear().map( item => item.id ), [ id, _second.delivery ] );
	assert.deepEqual( g.egress.unclear()[ 0 ].cohort, twelve );
} );

attack( S, 'recover: settled actions are never picked up again after a restart', async () => {
	const { g, id } = await unclear();
	g.egress.settle( id, { result: 'not_sent' } );
	assert.deepEqual( await g.egress.recover(), [] );
	assert.equal( g.row( id ).status, 'not_sent' );
} );

// The operator route of the gate process.
const PIN = 'settle-pin-4711';
let server;
let silence;

before( async () => {
	silence = quiet();
	server = await startGate( { pin: PIN } );
} );

after( async () => {
	await server.stop();
	silence.restore();
} );

// An unclear reply at the real gate, made unclear in its ledger (the gate process has no failing service).
async function unclearAtServer() {
	const { contract, body } = proposal( { ...surveySpec(), id: `settle-${Math.random().toString( 36 ).slice( 2 )}`, deadline: '2099-01-01T00:00:00Z' } );
	await server.call( 'POST', '/contracts', body );
	await server.call( 'POST', `/contracts/${contract.hash}/confirm`, { pin: PIN } );
	server.main.store.addMaster( 'recipient', [ 'ceo' ] );
	const _l = ( await server.call( 'POST', '/leases', { node: 'n', move: 'm', contract: contract.hash, minutes: 5 } ) ).data;
	const _asked = ( await server.call( 'POST', '/deliveries', { ...reply( twelve ), contract: contract.hash, lease: _l.id, fence: _l.fence } ) ).data;
	server.main.db.run( 'UPDATE deliveries SET status = \'unclear\' WHERE id = :id', { id: _asked.delivery } );
	return _asked.delivery;
}

attacks( S, [
	{ name: 'route: without anything a settlement is 403', body: { result: 'not_sent' }, headers: { 'x-core-token': '' }, want: 403 },
	{ name: 'route: the core token is no pin: 403', body: { result: 'not_sent' }, headers: {}, want: 403 },
	{ name: 'route: a wrong pin is 403', body: { result: 'not_sent', pin: 'guess' }, headers: {}, want: 403 },
	{ name: 'route: the pin in its header settles', body: { result: 'not_sent' }, headers: { 'x-operator-pin': PIN }, want: 200 },
	{ name: 'route: the pin in the body settles', body: { result: 'not_sent', pin: PIN }, headers: {}, want: 200 },
	{ name: 'route: with the pin, an answer that is none is 400', body: { result: 'maybe', pin: PIN }, headers: {}, want: 400 },
], async ( { body, headers, want } ) => {
	const _id = await unclearAtServer();
	const _response = await server.call( 'POST', `/unclear/${_id}`, body, { headers } );
	assert.equal( _response.status, want, JSON.stringify( _response.data ) );
	assert.equal( server.main.store.delivery( _id ).status, want === 200 ? 'not_sent' : 'unclear' );
} );

attack( S, 'route: a settlement sent as a form (no JSON) is refused even with the pin', async () => {
	const _id = await unclearAtServer();
	const _response = await server.call( 'POST', `/unclear/${_id}`, undefined, {
		raw: JSON.stringify( { result: 'executed', pin: PIN } ), headers: { 'Content-Type': 'text/plain' },
	} );
	assert.equal( _response.status, 403 );
	assert.equal( server.main.store.delivery( _id ).status, 'unclear' );
} );

attack( S, 'route: a settled action leaves GET /unclear', async () => {
	const _id = await unclearAtServer();
	assert.ok( ( await server.call( 'GET', '/unclear' ) ).data.some( item => item.id === _id ) );
	await server.call( 'POST', `/unclear/${_id}`, { result: 'executed', pin: PIN } );
	assert.ok( !( await server.call( 'GET', '/unclear' ) ).data.some( item => item.id === _id ) );
} );
