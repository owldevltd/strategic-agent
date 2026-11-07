// Attacks on what the core's client makes of the gate's answers: errors with and without a body, answers that are
// not JSON, redirects to another host, a gate that is down, and the client against a real gate with and without pin.
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { attack, attacks } from '../hostile.mjs';
import { GateClient, capture, startGate, proposal, surveySpec, reply, people, quiet } from './fixture.mjs';

const S = 'core/outbound/gateclient.js';
let answer = () => ( { status: 200, body: {} } );
let world;
let elsewhere;
let silence;

before( async () => {
	silence = quiet();
	world = await capture( request => answer( request ) );
	elsewhere = await capture( () => ( { status: 200, body: { status: 'executed', from: 'elsewhere' } } ) );
} );

after( async () => {
	await world.close();
	await elsewhere.close();
	silence.restore();
} );

const client = () => new GateClient( world.url );

attacks( S, [
	{ name: 'a 400 with an error text throws with method, path, status and the text', status: 400, body: { error: 'bad request' }, match: /gate GET \/unclear: 400 bad request/ },
	{ name: 'a 403 of the pin check throws and names it', status: 403, body: { error: 'operator pin required' }, match: /403 operator pin required/ },
	{ name: 'a 404 throws', status: 404, body: { error: 'not found' }, match: /404 not found/ },
	{ name: 'a 500 with the gate\'s error throws with it', status: 500, body: { error: 'contract hash does not match its content' }, match: /500 contract hash/ },
	{ name: 'a 502 page of a proxy (not JSON) throws with the status', status: 502, raw: '<html>Bad Gateway</html>', match: /502/ },
	{ name: 'a 500 whose body is JSON null throws the gate error, not a TypeError', status: 500, raw: 'null', match: /gate GET \/unclear: 500/ },
], async ( { status, body, raw, match } ) => {
	answer = () => ( { status, body, raw } );
	await assert.rejects( client().unclear(), ( error ) => {
		assert.ok( !( error instanceof TypeError ), `TypeError: ${error.message}` );
		assert.match( error.message, match );
		return true;
	} );
} );

attacks( S, [
	{ name: 'a 200 whose body is not JSON is an error, not an empty answer', raw: 'OK' },
	{ name: 'a 200 with an empty body is an error, not an empty answer', raw: '' },
	{ name: 'a 200 whose JSON is cut off is an error, not an empty answer', raw: '{ "status": "refu' },
], async ( { raw } ) => {
	answer = () => ( { status: 200, raw } );
	await assert.rejects( client().submit( reply( people( 12 ) ) ) );
} );

attack( S, 'a 200 with JSON null is null (an unknown contract), not an error', async () => {
	answer = () => ( { status: 200, raw: 'null' } );
	assert.equal( await client().contract( 'h' ), null );
} );

attack( S, 'an answer with a __proto__ key stays data and pollutes nothing', async () => {
	answer = () => ( { status: 200, raw: '{ "__proto__": { "admin": true }, "status": "refused" }' } );
	const _data = await client().submit( {} );
	assert.equal( _data.status, 'refused' );
	assert.equal( _data.admin, undefined );
	assert.equal( ( {} ).admin, undefined );
} );

attack( S, 'a two megabyte answer is read completely', async () => {
	const _big = Array.from( { length: 20000 }, ( _x, i ) => ( { id: `msg-${i}`, params: { body: 'x'.repeat( 80 ) } } ) );
	answer = () => ( { status: 200, body: _big } );
	assert.equal( ( await client().outbox( 'ceo' ) ).length, 20000 );
} );

attack( S, 'a slow gate (60 ms) is waited for, not given up early', async () => {
	answer = () => new Promise( resolve => setTimeout( () => resolve( { status: 200, body: { status: 'refused' } } ), 60 ) );
	assert.equal( ( await client().submit( {} ) ).status, 'refused' );
} );

attacks( S, [
	{ name: 'a temporary redirect (307) of a submission is not followed to another host', status: 307 },
	{ name: 'a redirect (302) of a submission is not followed to another host', status: 302 },
	{ name: 'a permanent redirect (308) of a submission is not followed to another host', status: 308 },
], async ( { status } ) => {
	const _before = elsewhere.seen.length;
	const _redirecting = await redirector( status, `${elsewhere.url}/deliveries` );
	try {
		await new GateClient( _redirecting.url ).submit( { ...reply( people( 12 ) ), params: { body: 'confidential numbers' } } ).catch( () => null );
		assert.equal( elsewhere.seen.length, _before, 'the action must not reach another host' );
	} finally {
		await _redirecting.close();
	}
} );

// A server that answers every request with a redirect to the given location.
async function redirector( status, location ) {
	const { default: http } = await import( 'node:http' );
	const _server = http.createServer( ( _req, res ) => {
		res.writeHead( status, { Location: location } );
		res.end();
	} );
	await new Promise( resolve => _server.listen( 0, '127.0.0.1', resolve ) );
	return { url: `http://127.0.0.1:${_server.address().port}`, close: () => new Promise( resolve => _server.close( resolve ) ) };
}

attacks( S, [
	{ name: 'a gate that is down gives a quick error, not a hang', url: async () => {
		const _gone = await capture();
		await _gone.close();
		return _gone.url;
	} },
	{ name: 'a gate URL with another scheme gives an error', url: async () => 'ftp://127.0.0.1:1' },
	{ name: 'a gate URL without a scheme gives an error', url: async () => '127.0.0.1:1' },
], async ( { url } ) => {
	const _client = new GateClient( await url() );
	await assert.rejects( Promise.race( [ _client.unclear(), new Promise( ( _r, reject ) => setTimeout( () => reject( new Error( 'hang' ) ), 3000 ) ) ] ),
		error => error.message !== 'hang' );
} );

attack( S, 'against a gate with a pin: the client\'s proposal stays proposed, and a steered call cannot confirm it', async () => {
	const _gate = await startGate( { pin: '9931-lake' } );
	try {
		// The core holds its token, never the pin.
		const _client = new GateClient( _gate.url, { token: _gate.token } );
		const { contract } = proposal( surveySpec( { id: 'client-pin', deadline: '2099-01-01T00:00:00Z' } ) );
		assert.equal( ( await _client.propose( contract ) ).status, 'proposed' );
		await _client.withdraw( `x/../../contracts/${contract.hash}/confirm?` ).catch( () => null );
		assert.equal( ( await _client.contract( contract.hash ) ).status, 'proposed' );
		const _l = await _client.lease( { node: 'c', move: 'm', contract: contract.hash, minutes: 5 } );
		assert.equal( ( await _client.submit( { ...reply( people( 12 ) ), contract: contract.hash, lease: _l.id, fence: _l.fence } ) ).status, 'refused' );
	} finally {
		await _gate.stop();
	}
} );

attack( S, 'against a gate without a pin: a steered withdraw() cannot decide a person\'s pending approval', async () => {
	const _gate = await startGate();
	try {
		const _client = new GateClient( _gate.url );
		const { contract } = proposal( surveySpec( { id: 'client-nopin', deadline: '2099-01-01T00:00:00Z' } ) );
		await _client.propose( contract );
		_gate.main.egress.confirm( contract.hash, 'person' );
		const _l = await _client.lease( { node: 'c', move: 'm', contract: contract.hash, minutes: 5 } );
		const _asked = await _client.submit( { ...reply( people( 12 ) ), contract: contract.hash, lease: _l.id, fence: _l.fence } );
		await _client.withdraw( `x/../../approvals/${_asked.approval}?` ).catch( () => null );
		const _approval = _gate.main.db.get( 'SELECT status FROM approvals WHERE id = :id', { id: _asked.approval } );
		assert.ok( [ 'pending', 'withdrawn' ].includes( _approval.status ), `the approval was ${_approval.status} through a path the core may not use` );
	} finally {
		await _gate.stop();
	}
} );

attack( S, 'against a real gate: the client presents a person\'s token and the action goes out once', async () => {
	const _gate = await startGate();
	try {
		const _client = new GateClient( _gate.url );
		const { contract } = proposal( surveySpec( { id: 'client-flow', deadline: '2099-01-01T00:00:00Z' } ) );
		await _client.propose( contract );
		_gate.main.egress.confirm( contract.hash, 'person' );
		const _l = await _client.lease( { node: 'c', move: 'm', contract: contract.hash, minutes: 5 } );
		const _asked = await _client.submit( { ...reply( people( 12 ) ), target: 'ceo', contract: contract.hash, lease: _l.id, fence: _l.fence } );
		await _gate.main.egress.decide( _asked.approval, 'approve', 'person' );
		const _token = { delivery: _asked.delivery, approval: _asked.approval, lease: _l.id, fence: _l.fence };
		assert.equal( ( await _client.redeem( _token ) ).status, 'executed' );
		assert.equal( ( await _client.redeem( _token ) ).status, 'executed' );
		assert.equal( ( await _client.outbox( 'ceo' ) ).length, 1 );
		assert.equal( ( await _client.beat( _l.id, _l.fence ) ).ok, true );
		assert.deepEqual( await _client.release( _l.id ), { ok: false }, 'without the fencing token nothing ends (A4)' );
		assert.deepEqual( await _client.release( _l.id, _l.fence ), { ok: true } );
		assert.equal( ( await _client.beat( _l.id, _l.fence ) ).ok, false );
	} finally {
		await _gate.stop();
	}
} );
