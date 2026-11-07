// Attacks on the core's client of the gate: does every call reach exactly its route with exactly its data, and can
// an id with a slash, a question mark or dots steer a call to another route (an operator route, say)?
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { attack, attacks } from '../hostile.mjs';
import { GateClient, capture, proposal, surveySpec } from './fixture.mjs';

const S = 'core/outbound/gateclient.js';
let world;
let client;

before( async () => {
	world = await capture( () => ( { status: 200, body: { ok: true } } ) );
	client = new GateClient( world.url );
} );

after( () => world.close() );

// The path the server saw, split into decoded segments.
const segments = seen => new URL( seen.url, 'http://gate' ).pathname.split( '/' ).slice( 1 ).map( decodeURIComponent );

attacks( S, [
	{ name: 'propose() posts spec, rules and hash to /contracts', call: c => c.propose( proposal( surveySpec() ).contract ),
		method: 'POST', path: [ 'contracts' ], body: body => assert.deepEqual( Object.keys( body ).sort(), [ 'hash', 'rules', 'spec' ] ) },
	{ name: 'contract() reads /contracts/:hash without a body', call: c => c.contract( 'abc' ), method: 'GET', path: [ 'contracts', 'abc' ], body: body => assert.equal( body, undefined ) },
	{ name: 'submit() posts the request unchanged to /deliveries', call: c => c.submit( { action: 'reply', node: 'n1', flags: [ 'x' ] } ),
		method: 'POST', path: [ 'deliveries' ], body: body => assert.deepEqual( body, { action: 'reply', node: 'n1', flags: [ 'x' ] } ) },
	{ name: 'delivery() reads /deliveries/:id', call: c => c.delivery( 'dl-1' ), method: 'GET', path: [ 'deliveries', 'dl-1' ] },
	{ name: 'outbox() reads /outbox/:target', call: c => c.outbox( 'ceo' ), method: 'GET', path: [ 'outbox', 'ceo' ] },
	{ name: 'lease() posts the request to /leases', call: c => c.lease( { node: 'n', minutes: 2 } ), method: 'POST', path: [ 'leases' ],
		body: body => assert.deepEqual( body, { node: 'n', minutes: 2 } ) },
	{ name: 'beat() posts only the fence to /leases/:id/beat', call: c => c.beat( 'ls-1', 7 ), method: 'POST', path: [ 'leases', 'ls-1', 'beat' ],
		body: body => assert.deepEqual( body, { fence: 7 } ) },
	{ name: 'release() posts an empty body to /leases/:id/release', call: c => c.release( 'ls-1' ), method: 'POST', path: [ 'leases', 'ls-1', 'release' ],
		body: body => assert.deepEqual( body, {} ) },
	{ name: 'withdraw() posts an empty body to /deliveries/:id/withdraw', call: c => c.withdraw( 'dl-1' ), method: 'POST', path: [ 'deliveries', 'dl-1', 'withdraw' ],
		body: body => assert.deepEqual( body, {} ) },
	{ name: 'redeem() posts approval, lease and fence and nothing else', call: c => c.redeem( { delivery: 'dl-1', approval: 'ap-1', lease: 'ls-1', fence: 3, extra: 'x' } ),
		method: 'POST', path: [ 'deliveries', 'dl-1', 'redeem' ], body: body => assert.deepEqual( body, { approval: 'ap-1', lease: 'ls-1', fence: 3 } ) },
	{ name: 'unclear() reads /unclear', call: c => c.unclear(), method: 'GET', path: [ 'unclear' ] },
], async ( { call, method, path, body } ) => {
	await call( client );
	const _seen = world.last();
	assert.equal( _seen.method, method );
	assert.deepEqual( segments( _seen ), path );
	body?.( _seen.body );
	assert.equal( _seen.headers[ 'content-type' ], 'application/json' );
} );

attack( S, 'the client has no call to confirm a goal, approve an action or add master data', () => {
	for ( const name of [ 'confirm', 'decide', 'approve', 'approvals', 'master', 'addMaster' ] ) {
		assert.equal( GateClient.prototype[ name ], undefined, name );
	}
} );

attack( S, 'propose() sends only what the hash covers and the rules, not other fields of the spec', async () => {
	const { contract } = proposal( surveySpec() );
	contract.spec.secret = 'not for the gate';
	await client.propose( contract );
	assert.equal( JSON.stringify( world.last().body ).includes( 'not for the gate' ), false );
} );

attack( S, 'propose() of a contract whose canonical() throws sends nothing', async () => {
	const _count = world.seen.length;
	await assert.rejects( client.propose( { canonical: () => {
		throw new Error( 'broken' );
	}, rules: () => ( {} ), hash: 'x' } ) );
	assert.equal( world.seen.length, _count );
} );

attacks( S, [
	{ name: 'a trailing slash of the gate URL is dropped', base: url => `${url}/`, path: [ 'unclear' ] },
	{ name: 'a path prefix of the gate URL is kept', base: url => `${url}/gate`, path: [ 'gate', 'unclear' ] },
	{ name: 'a path prefix with a trailing slash is kept', base: url => `${url}/gate/`, path: [ 'gate', 'unclear' ] },
], async ( { base, path } ) => {
	await new GateClient( base( world.url ) ).unclear();
	assert.deepEqual( segments( world.last() ), path );
} );

// An id that is a path of its own must stay one segment; otherwise the call lands on another route.
const TRAVERSALS = [
	{ name: 'withdraw() of an id with "../" cannot reach the operator route /approvals/:id', call: c => c.withdraw( 'x/../../approvals/ap-1?' ),
		path: [ 'deliveries', 'x/../../approvals/ap-1?', 'withdraw' ] },
	{ name: 'redeem() of a delivery id with "../" cannot reach /contracts/:hash/confirm', call: c => c.redeem( { delivery: '../contracts/h1/confirm?' } ),
		path: [ 'deliveries', '../contracts/h1/confirm?', 'redeem' ] },
	{ name: 'beat() of a lease id with "../" cannot withdraw a delivery', call: c => c.beat( '../deliveries/dl-9/withdraw?', 1 ),
		path: [ 'leases', '../deliveries/dl-9/withdraw?', 'beat' ] },
	{ name: 'release() of a lease id with "../" cannot reach /master', call: c => c.release( '../../master?' ), path: [ 'leases', '../../master?', 'release' ] },
	{ name: 'delivery() of an id with "../" cannot read /unclear', call: c => c.delivery( '../unclear' ), path: [ 'deliveries', '../unclear' ] },
	{ name: 'contract() of a hash with "../" cannot read /approvals', call: c => c.contract( '../approvals' ), path: [ 'contracts', '../approvals' ] },
];

attacks( S, TRAVERSALS, async ( { call, path } ) => {
	await call( client ).catch( () => null );
	assert.deepEqual( segments( world.last() ), path );
} );

const CHARACTERS = [
	{ label: 'a slash', id: 'dl/1' },
	{ label: 'a question mark', id: 'dl?1' },
	{ label: 'a hash sign', id: 'dl#1' },
	{ label: 'a percent escape', id: 'dl%41' },
	{ label: 'dots and a slash', id: '../dl-1' },
];

attacks( S, CHARACTERS.map( item => ( { ...item, name: `delivery() keeps an id with ${item.label} as one path segment` } ) ), async ( { id } ) => {
	await client.delivery( id ).catch( () => null );
	assert.deepEqual( segments( world.last() ), [ 'deliveries', id ] );
} );

attacks( S, [ ...CHARACTERS, { label: 'a space', id: 'chief exec' }, { label: 'an umlaut', id: 'zürich-office' } ]
	.map( item => ( { ...item, name: `outbox() keeps a recipient with ${item.label} as one path segment` } ) ), async ( { id } ) => {
	await client.outbox( id );
	assert.deepEqual( segments( world.last() ), [ 'outbox', id ] );
} );

attacks( S, [
	{ name: 'delivery() of an id with a space reaches its route intact', id: 'dl 1' },
	{ name: 'delivery() of an id with an umlaut reaches its route intact', id: 'dl-ü' },
	{ name: 'delivery() of an id with an emoji reaches its route intact', id: 'dl-😀' },
], async ( { id } ) => {
	await client.delivery( id );
	assert.deepEqual( segments( world.last() ), [ 'deliveries', id ] );
} );

attack( S, 'fifty calls at once all reach the gate and all come back', async () => {
	const _count = world.seen.length;
	const _all = await Promise.all( Array.from( { length: 50 }, ( _x, i ) => client.delivery( `dl-${i}` ) ) );
	assert.equal( _all.length, 50 );
	assert.equal( world.seen.length - _count, 50 );
} );
