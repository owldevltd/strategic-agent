// Attacks on the gate process from the network: the operator pin (missing, wrong, of another type, smuggled in a
// prototype key, guessed many times), body bombs, broken encodings, injected route parameters and slow clients.
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before } from 'node:test';
import { attack, attacks } from '../hostile.mjs';
import { startGate, proposal, surveySpec, invoiceSpec, reply, pay, people, quiet, call } from './fixture.mjs';

const S = 'gate/main.js';
const PIN = '4711-river';
const FAR = '2099-01-01T00:00:00Z';
let server;
let silence;
let counter = 0;

before( async () => {
	silence = quiet();
	server = await startGate( { pin: PIN } );
} );

after( async () => {
	await server.stop();
	silence.restore();
} );

async function proposed( spec = surveySpec() ) {
	counter += 1;
	const { contract, body } = proposal( { ...spec, id: `${spec.id}-a${counter}`, deadline: FAR } );
	await server.call( 'POST', '/contracts', body );
	return contract.hash;
}

const status = async hash => ( await server.call( 'GET', `/contracts/${hash}` ) ).data.status;
const ledger = () => server.main.db.get( 'SELECT COUNT(*) AS n FROM deliveries' ).n;

// A pending payment approval at the pinned gate.
async function pending() {
	const _hash = await proposed( invoiceSpec() );
	await server.call( 'POST', `/contracts/${_hash}/confirm`, { pin: PIN } );
	const _l = ( await server.call( 'POST', '/leases', { node: `p${counter}`, move: 'm', contract: _hash, minutes: 5 } ) ).data;
	return ( await server.call( 'POST', '/deliveries', { ...pay( `R-${counter}`, 10 ), contract: _hash, lease: _l.id, fence: _l.fence } ) ).data;
}

attack( S, 'pin: the gate reports at start that an operator pin is required', () => {
	const _started = server.main.log.since( 0 ).find( item => item.kind === 'gate_started' );
	assert.equal( _started.data.operatorPin, true );
} );

attack( S, 'pin: confirming a goal without the pin is 403 and the goal stays proposed', async () => {
	const _hash = await proposed();
	assert.equal( ( await server.call( 'POST', `/contracts/${_hash}/confirm`, {} ) ).status, 403 );
	assert.equal( await status( _hash ), 'proposed' );
} );

attack( S, 'pin: with the right pin the goal is confirmed', async () => {
	const _hash = await proposed();
	assert.equal( ( await server.call( 'POST', `/contracts/${_hash}/confirm`, { pin: PIN, by: 'hr-lead' } ) ).data.confirmedBy, 'hr-lead' );
} );

attacks( S, [
	{ name: 'pin: the pin with a trailing space is wrong', pin: `${PIN} ` },
	{ name: 'pin: the pin in upper case is wrong', pin: PIN.toUpperCase() },
	{ name: 'pin: the pin as a list is wrong', pin: [ PIN ] },
	{ name: 'pin: the pin as an object is wrong', pin: { toString: PIN } },
	{ name: 'pin: true is not the pin', pin: true },
	{ name: 'pin: a query operator object is not the pin', pin: { $ne: '' } },
	{ name: 'pin: the empty pin is wrong', pin: '' },
	{ name: 'pin: null is not the pin', pin: null },
	{ name: 'pin: the first half of the pin is wrong', pin: PIN.slice( 0, 4 ) },
], async ( { pin } ) => {
	const _hash = await proposed();
	assert.equal( ( await server.call( 'POST', `/contracts/${_hash}/confirm`, { pin } ) ).status, 403 );
	assert.equal( await status( _hash ), 'proposed' );
} );

attacks( S, [
	{ name: 'pin: a pin in the query string does not count', route: hash => `/contracts/${hash}/confirm?pin=${PIN}`, body: {} },
	{ name: 'pin: a pin in another header does not count', route: hash => `/contracts/${hash}/confirm`, body: {}, headers: { 'X-Pin': PIN, Authorization: PIN } },
	{ name: 'pin: the pin as the core token does not count', route: hash => `/contracts/${hash}/confirm`, body: {}, headers: { 'x-core-token': PIN } },
	{ name: 'pin: a pin hidden in a __proto__ key does not count', route: hash => `/contracts/${hash}/confirm`, raw: `{ "__proto__": { "pin": "${PIN}" } }` },
	{ name: 'pin: a pin nested in another field does not count', route: hash => `/contracts/${hash}/confirm`, body: { by: { pin: PIN } } },
], async ( { route, body, headers, raw } ) => {
	const _hash = await proposed();
	const _response = await server.call( 'POST', route( _hash ), body, { headers, raw } );
	assert.equal( _response.status, 403 );
	assert.equal( await status( _hash ), 'proposed' );
} );

attacks( S, [
	{ name: 'pin: a body of JSON null confirms nothing', raw: 'null' },
	{ name: 'pin: a body that is a JSON list confirms nothing', raw: `[ "${PIN}" ]` },
	{ name: 'pin: a body that is the pin as a JSON string confirms nothing', raw: `"${PIN}"` },
	{ name: 'pin: a body that is not JSON confirms nothing', raw: `pin=${PIN}` },
], async ( { raw } ) => {
	const _hash = await proposed();
	const _response = await server.call( 'POST', `/contracts/${_hash}/confirm`, undefined, { raw } );
	assert.ok( _response.status >= 400 );
	assert.equal( await status( _hash ), 'proposed' );
} );

attack( S, 'pin: an approval without the pin is 403 and stays pending', async () => {
	const _asked = await pending();
	const _response = await server.call( 'POST', `/approvals/${_asked.approval}`, { decision: 'approve', reason: 'ok' } );
	assert.equal( _response.status, 403 );
	assert.ok( ( await server.call( 'GET', '/approvals' ) ).data.some( item => item.id === _asked.approval ) );
} );

attack( S, 'pin: an approval with the pin and a reason issues the token', async () => {
	const _asked = await pending();
	const _response = await server.call( 'POST', `/approvals/${_asked.approval}`, { decision: 'approve', reason: 'ok', pin: PIN } );
	assert.equal( _response.data.status, 'approved' );
} );

attack( S, 'pin: master data cannot be added without the pin', async () => {
	assert.equal( ( await server.call( 'POST', '/master', { kind: 'account', values: [ 'DE00EVIL' ] } ) ).status, 403 );
	assert.equal( server.main.store.isMaster( 'account', 'DE00EVIL' ), false );
} );

attack( S, 'pin: a browser page of another origin cannot confirm without the pin either', async () => {
	const _hash = await proposed();
	const _response = await server.call( 'POST', `/contracts/${_hash}/confirm`, { by: 'evil.example' }, {
		headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
	} );
	assert.equal( _response.status, 403 );
	assert.equal( await status( _hash ), 'proposed' );
} );

// On a gate of its own: the lock-out it provokes would lock the shared gate for the tests that follow.
attack( S, 'pin: two hundred wrong guesses lock the operator routes, so the right pin no longer works right away', async () => {
	const _own = await startGate( { pin: PIN } );
	try {
		const { contract, body } = proposal( { ...surveySpec(), id: 'guessed', deadline: FAR } );
		await _own.call( 'POST', '/contracts', body );
		for ( let i = 0; i < 200; i++ ) {
			await _own.call( 'POST', `/contracts/${contract.hash}/confirm`, { pin: String( i ).padStart( 4, '0' ) } );
		}
		const _response = await _own.call( 'POST', `/contracts/${contract.hash}/confirm`, { pin: PIN } );
		assert.ok( [ 403, 429 ].includes( _response.status ), 'guessing must be slowed down or locked out' );
		assert.equal( ( await _own.call( 'GET', `/contracts/${contract.hash}` ) ).data.status, 'proposed' );
	} finally {
		await _own.stop();
	}
}, { timeout: 30000 } );

attack( S, 'body bomb: an eight megabyte body is refused before it is parsed and booked', async () => {
	const _before = ledger();
	const _response = await server.call( 'POST', '/deliveries', { contract: 'x', action: 'reply', params: { body: 'x'.repeat( 8 * 1024 * 1024 ) } } );
	assert.equal( _response.status, 413 );
	assert.equal( ledger(), _before, 'nothing of it reaches the ledger' );
} );

attack( S, 'body bomb: JSON nested a hundred thousand levels deep is refused and the gate keeps serving', async () => {
	const _deep = `{ "contract": "x", "action": "reply", "params": ${'['.repeat( 100000 )}${']'.repeat( 100000 )} }`;
	const _response = await server.call( 'POST', '/deliveries', undefined, { raw: _deep } );
	assert.ok( _response.status >= 400 || _response.data.status === 'refused' );
	assert.equal( ( await server.call( 'GET', '/unclear' ) ).status, 200 );
} );

attack( S, 'a body that is not JSON is a client error, and the gate keeps serving', async () => {
	const _response = await server.call( 'POST', '/deliveries', undefined, { raw: '{ "contract": ' } );
	assert.ok( _response.status >= 400 );
	assert.equal( ( await server.call( 'GET', '/unclear' ) ).status, 200 );
} );

attack( S, 'an empty request to /deliveries is refused and booked, not a server error', async () => {
	const _response = await server.call( 'POST', '/deliveries', {} );
	assert.equal( _response.status, 200 );
	assert.equal( _response.data.status, 'refused' );
} );

attack( S, 'a JSON null body to /deliveries is refused, not a server error', async () => {
	const _response = await server.call( 'POST', '/deliveries', undefined, { raw: 'null' } );
	assert.ok( _response.status < 500, `status ${_response.status}` );
} );

attacks( S, [
	{ name: 'route params: a broken percent escape is an error and the gate keeps serving', route: '/deliveries/%E0%A4%A' },
	{ name: 'route params: an encoded path that climbs up reads nothing else', route: '/deliveries/..%2F..%2Fcontracts' },
	{ name: 'route params: a NUL byte in an id reads nothing', route: '/deliveries/dl-1%00' },
	{ name: 'route params: SQL in an id reads nothing', route: `/deliveries/${encodeURIComponent( '\' OR 1=1 --' )}` },
	{ name: 'route params: __proto__ as an id reads nothing', route: '/deliveries/__proto__' },
], async ( { route } ) => {
	const _response = await server.call( 'GET', route );
	assert.ok( _response.status >= 400 || _response.data === null );
	assert.equal( ( await server.call( 'GET', '/unclear' ) ).status, 200 );
} );

attack( S, 'route params: an encoded slash in a hash cannot confirm another goal', async () => {
	const _hash = await proposed();
	const _response = await server.call( 'POST', `/contracts/${encodeURIComponent( `${_hash}/confirm` )}/confirm`, { pin: PIN } );
	assert.ok( _response.status >= 400 || _response.data === null );
	assert.equal( await status( _hash ), 'proposed' );
} );

attack( S, 'a URL of a hundred thousand characters is refused and the gate keeps serving', async () => {
	const _response = await server.call( 'GET', `/deliveries/${'a'.repeat( 100000 )}` ).catch( () => ( { status: 431 } ) );
	assert.ok( _response.status >= 400 || _response.data === null );
	assert.equal( ( await server.call( 'GET', '/unclear' ) ).status, 200 );
} );

attack( S, 'a client that never finishes its body does not block anyone else', async () => {
	const _socket = net.connect( server.port, '127.0.0.1' );
	await new Promise( resolve => _socket.on( 'connect', resolve ) );
	_socket.write( 'POST /deliveries HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{ "contract": ' );
	try {
		assert.equal( ( await server.call( 'GET', '/unclear', undefined, { timeoutMs: 2000 } ) ).status, 200 );
	} finally {
		_socket.destroy();
	}
} );

attack( S, 'prototype pollution through a body reaches no other request', async () => {
	await server.call( 'POST', '/deliveries', undefined, { raw: '{ "__proto__": { "polluted": "yes" }, "constructor": { "prototype": { "polluted": "yes" } } }' } );
	assert.equal( ( {} ).polluted, undefined );
	const _hash = await proposed();
	assert.equal( ( await server.call( 'POST', `/contracts/${_hash}/confirm`, {} ) ).status, 403 );
} );

attack( S, 'the gate reached through another host name answers the same, with no pin bypass', async () => {
	const _hash = await proposed();
	const _response = await call( `http://localhost:${server.port}`, 'POST', `/contracts/${_hash}/confirm`, {}, { headers: { Host: 'gate.internal' } } )
		.catch( () => ( { status: 403 } ) );
	assert.equal( _response.status, 403 );
} );

attack( S, 'the refusal of a wrong pin says nothing about the pin', async () => {
	const _hash = await proposed();
	const _response = await server.call( 'POST', `/contracts/${_hash}/confirm`, { pin: '0000' } );
	assert.equal( JSON.stringify( _response.data ).includes( PIN ), false );
	assert.equal( JSON.stringify( server.main.log.since( 0 ) ).includes( PIN ), false );
} );

attack( S, 'a reply with a person\'s group of twelve is accepted over HTTP, a group of two refused', async () => {
	const _hash = await proposed();
	await server.call( 'POST', `/contracts/${_hash}/confirm`, { pin: PIN } );
	const _l = ( await server.call( 'POST', '/leases', { node: 'g', move: 'm', contract: _hash, minutes: 5 } ) ).data;
	const _twelve = await server.call( 'POST', '/deliveries', { ...reply( people( 12 ) ), contract: _hash, lease: _l.id, fence: _l.fence } );
	const _two = await server.call( 'POST', '/deliveries', { ...reply( [ 'r01', 'r02' ] ), contract: _hash, lease: _l.id, fence: _l.fence } );
	assert.equal( _twelve.data.status, 'awaiting_approval' );
	assert.equal( _two.data.status, 'refused' );
} );
