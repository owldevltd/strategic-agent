// The proposal routes of the gate process: the core submits with its token, the operator decides and revokes with the
// pin, reading needs either; the core token decides nothing, and a gate without AGENCY_PROPOSALS takes nothing.
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { attack, attacks } from '../hostile.mjs';
import { startGate, proposal, surveySpec, quiet, Actions } from './fixture.mjs';

const S = 'gate/main.js';
const PIN = 'proposal-pin-4711';
const NOTICE = { criticality: 'outward', carries: [ 'message' ], says: 'a short notice to a customer about their order' };
let server;
let silence;
let counter = 0;

before( async () => {
	silence = quiet();
	server = await startGate( { pin: PIN, proposals: true } );
} );

after( async () => {
	Actions.forget( 'notice' );
	await server.stop();
	silence.restore();
} );

// A confirmed goal and an open proposal of an action for it.
async function open( name = 'notice' ) {
	counter += 1;
	const { contract, body } = proposal( { ...surveySpec(), id: `prop-${counter}`, deadline: '2099-01-01T00:00:00Z' } );
	await server.call( 'POST', '/contracts', body );
	await server.call( 'POST', `/contracts/${contract.hash}/confirm`, { pin: PIN } );
	const _row = await server.call( 'POST', '/proposals', { contract: contract.hash, node: 'n1', kind: 'action', body: { name, entry: NOTICE } } );
	return { hash: contract.hash, row: _row };
}

attack( S, 'proposals: the core submits one with its token; it waits for the operator', async () => {
	const { row } = await open();
	assert.equal( row.status, 200, JSON.stringify( row.data ) );
	assert.equal( row.data.status, 'proposed' );
} );

attacks( S, [
	{ name: 'proposals: without the core token nothing is submitted', headers: { 'x-core-token': '' }, status: 403 },
	{ name: 'proposals: the operator pin is no core token for submitting', headers: { 'x-core-token': '', 'x-operator-pin': PIN }, status: 403 },
], async ( { headers, status } ) => {
	const { hash } = await open( `memo${counter}` );
	const _answer = await server.call( 'POST', '/proposals', { contract: hash, kind: 'action', body: { name: 'letter', entry: NOTICE } }, { headers } );
	assert.equal( _answer.status, status );
} );

attacks( S, [
	{ name: 'proposals: the core token decides nothing', body: { decision: 'approve' }, headers: {}, status: 403 },
	{ name: 'proposals: a wrong pin decides nothing', body: { decision: 'approve', pin: 'guess-1' }, headers: {}, status: 403 },
	{ name: 'proposals: the pin decides, in the body', body: { decision: 'approve', pin: PIN }, headers: {}, status: 200 },
	{ name: 'proposals: the pin decides, in its header', body: { decision: 'reject' }, headers: { 'x-operator-pin': PIN }, status: 200 },
	{ name: 'proposals: a decision that is none is 400 even with the pin', body: { decision: 'maybe', pin: PIN }, headers: {}, status: 400 },
], async ( { body, headers, status } ) => {
	Actions.forget( 'notice' );
	const { row } = await open( `n${counter}x` );
	const _answer = await server.call( 'POST', `/proposals/${row.data.id}`, body, { headers } );
	assert.equal( _answer.status, status, JSON.stringify( _answer.data ) );
	Actions.forget( `n${counter}x` );
} );

attack( S, 'proposals: a decision sent as a form (no JSON) is refused even with the pin', async () => {
	const { row } = await open( `form${counter}` );
	const _answer = await server.call( 'POST', `/proposals/${row.data.id}`, undefined, {
		raw: JSON.stringify( { decision: 'approve', pin: PIN } ), headers: { 'Content-Type': 'text/plain' },
	} );
	assert.equal( _answer.status, 403 );
	assert.equal( server.main.egress.proposals.get( row.data.id ).status, 'proposed' );
} );

attack( S, 'proposals: an approved action is listed for the core, and revoked with the pin it is gone', async () => {
	const { row } = await open( 'bulletin' );
	await server.call( 'POST', `/proposals/${row.data.id}`, { decision: 'approve', pin: PIN } );
	assert.ok( Object.hasOwn( ( await server.call( 'GET', '/actions/learned' ) ).data, 'bulletin' ) );
	assert.equal( ( await server.call( 'POST', `/proposals/${row.data.id}/revoke`, { reason: 'test' } ) ).status, 403, 'not with the core token' );
	assert.equal( ( await server.call( 'POST', `/proposals/${row.data.id}/revoke`, { pin: PIN, reason: 'test' } ) ).data.status, 'revoked' );
	assert.equal( Object.hasOwn( ( await server.call( 'GET', '/actions/learned' ) ).data, 'bulletin' ), false );
	Actions.forget( 'bulletin' );
} );

attacks( S, [
	{ name: 'proposals: the open ones are read with the core token', headers: {}, status: 200 },
	{ name: 'proposals: the open ones are read with the operator pin', headers: { 'x-core-token': '', 'x-operator-pin': PIN }, status: 200 },
	{ name: 'proposals: without either nothing is read', headers: { 'x-core-token': '' }, status: 403 },
], async ( { headers, status } ) => {
	assert.equal( ( await server.call( 'GET', '/proposals', undefined, { headers } ) ).status, status );
} );

attack( S, 'proposals: a gate without AGENCY_PROPOSALS takes none (404)', async () => {
	const _off = await startGate( { pin: PIN } );
	try {
		const { contract, body } = proposal( { ...surveySpec(), id: 'off', deadline: '2099-01-01T00:00:00Z' } );
		await _off.call( 'POST', '/contracts', body );
		await _off.call( 'POST', `/contracts/${contract.hash}/confirm`, { pin: PIN } );
		const _answer = await _off.call( 'POST', '/proposals', { contract: contract.hash, kind: 'action', body: { name: 'notice', entry: NOTICE } } );
		assert.equal( _answer.status, 404 );
	} finally {
		await _off.stop();
	}
} );
