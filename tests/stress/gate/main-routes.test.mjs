// The gate process over HTTP on 127.0.0.1: every route with ordinary and odd input, the live log, a restart on the
// same storage folder that rebuilds open operations (O1), and the operator's master data.
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { attack, attacks, within } from '../hostile.mjs';
import { startGate, proposal, surveySpec, invoiceSpec, reply, pay, people, quiet, tick, IBAN } from './fixture.mjs';

const S = 'gate/main.js';
const FAR = '2099-01-01T00:00:00Z';
let server;
let silence;

before( async () => {
	silence = quiet();
	server = await startGate();
} );

after( async () => {
	await server.stop();
	silence.restore();
} );

let counter = 0;

// A confirmed goal at the running gate, a lease for it and a helper to submit under that lease.
async function goal( spec = surveySpec(), { confirm = true } = {} ) {
	counter += 1;
	const { contract, body } = proposal( { ...spec, id: `${spec.id}-${counter}`, deadline: FAR } );
	assert.equal( ( await server.call( 'POST', '/contracts', body ) ).status, 200 );
	if ( confirm ) {
		await server.call( 'POST', `/contracts/${contract.hash}/confirm`, { by: 'person' } );
	}
	const _lease = async () => ( await server.call( 'POST', '/leases', { node: `n${counter}`, move: 'm', contract: contract.hash, minutes: 5 } ) ).data;
	const _submit = async ( request ) => {
		const _l = await _lease();
		return ( await server.call( 'POST', '/deliveries', { contract: contract.hash, lease: _l.id, fence: _l.fence, ...request } ) ).data;
	};
	return { contract, hash: contract.hash, lease: _lease, submit: _submit };
}

const approve = ( approval, body = { decision: 'approve', reason: 'checked' } ) => server.call( 'POST', `/approvals/${approval}`, body );

attack( S, 'start(): the gate answers on 127.0.0.1 and has logged its start with the number of unclear operations', async () => {
	const _log = ( await server.call( 'GET', '/log?since=0' ) ).data;
	const _started = _log.find( item => item.kind === 'gate_started' );
	assert.equal( _started.data.port, server.port );
	assert.equal( _started.data.unclear, 0 );
	assert.equal( _started.data.operatorPin, false );
} );

attack( S, 'start(): the master data of the missions folder is loaded for the goals of its mission kind only', () => {
	assert.equal( server.main.store.isMaster( 'account', IBAN, 'supplier-payments' ), true );
	assert.equal( server.main.store.isMaster( 'account', IBAN, 'hr-survey' ), false );
	assert.equal( server.main.store.isMaster( 'account', IBAN ), false, 'not for every goal' );
} );

attack( S, 'POST /contracts then GET /contracts/:hash: the gate keeps exactly what was proposed', async () => {
	const { contract } = await goal( surveySpec(), { confirm: false } );
	const { data } = await server.call( 'GET', `/contracts/${contract.hash}` );
	assert.equal( data.status, 'proposed' );
	assert.deepEqual( data.rules, contract.rules() );
} );

attack( S, 'POST /contracts: a hash that does not match is refused and nothing is stored', async () => {
	const { contract, body } = proposal( surveySpec( { id: 'mismatch', deadline: FAR } ) );
	const _response = await server.call( 'POST', '/contracts', { ...body, spec: { ...body.spec, goal: 'Pay everybody' } } );
	assert.ok( _response.status >= 400 );
	assert.match( _response.data.error, /does not match/ );
	assert.equal( ( await server.call( 'GET', `/contracts/${contract.hash}` ) ).data, null );
} );

attack( S, 'the whole way over HTTP: lease, submit, a person approves, redeem, the outbox shows one message', async () => {
	const _goal = await goal();
	const _asked = await _goal.submit( { ...reply( people( 12 ) ), target: 'ceo' } );
	assert.equal( _asked.status, 'awaiting_approval' );
	assert.ok( ( await server.call( 'GET', '/approvals' ) ).data.some( item => item.id === _asked.approval ) );
	assert.equal( ( await approve( _asked.approval ) ).data.status, 'approved' );
	const _l = await _goal.lease();
	const _done = await server.call( 'POST', `/deliveries/${_asked.delivery}/redeem`, { approval: _asked.approval, lease: _l.id, fence: _l.fence } );
	assert.equal( _done.data.status, 'executed' );
	assert.equal( ( await server.call( 'GET', '/outbox/ceo' ) ).data.filter( row => row.idempotencyKey === _asked.delivery ).length, 1 );
	assert.equal( ( await server.call( 'GET', `/deliveries/${_asked.delivery}` ) ).data.status, 'executed' );
} );

attack( S, 'redeem: the body cannot name another delivery than the one in the path', async () => {
	const _goal = await goal();
	const _a = await _goal.submit( reply( people( 12 ) ) );
	const _b = await _goal.submit( reply( people( 12, 40 ) ) );
	await approve( _a.approval );
	const _l = await _goal.lease();
	const _result = await server.call( 'POST', `/deliveries/${_b.delivery}/redeem`, { delivery: _a.delivery, approval: _a.approval, lease: _l.id, fence: _l.fence } );
	assert.equal( _result.data.delivery, _b.delivery );
	assert.notEqual( _result.data.status, 'executed' );
	assert.equal( ( await server.call( 'GET', `/deliveries/${_a.delivery}` ) ).data.status, 'approved' );
} );

attack( S, 'redeem: five redeems of one token at once over HTTP send one message', async () => {
	const _goal = await goal();
	const _asked = await _goal.submit( { ...reply( people( 12 ) ), target: 'ceo' } );
	await approve( _asked.approval );
	const _l = await _goal.lease();
	await Promise.all( Array.from( { length: 5 }, () => server.call( 'POST', `/deliveries/${_asked.delivery}/redeem`, {
		approval: _asked.approval, lease: _l.id, fence: _l.fence,
	} ) ) );
	// The server is shared by the tests of this file; only the messages of this delivery count.
	assert.equal( ( await server.call( 'GET', '/outbox/ceo' ) ).data.filter( row => row.idempotencyKey === _asked.delivery ).length, 1 );
} );

attack( S, 'POST /approvals/:id: money without a reason is refused and the approval stays pending', async () => {
	const _goal = await goal( invoiceSpec() );
	const _asked = await _goal.submit( pay( 'R-1187', 10 ) );
	const _response = await approve( _asked.approval, { decision: 'approve' } );
	assert.ok( _response.status >= 400 );
	assert.ok( ( await server.call( 'GET', '/approvals' ) ).data.some( item => item.id === _asked.approval ) );
} );

attack( S, 'POST /approvals/:id: a rejection closes the action', async () => {
	const _goal = await goal();
	const _asked = await _goal.submit( reply( people( 12 ) ) );
	assert.equal( ( await approve( _asked.approval, { decision: 'reject', reason: 'no' } ) ).data.status, 'rejected' );
} );

attack( S, 'POST /approvals/:id: an unknown approval is an error, not an approval', async () => {
	const _response = await approve( 'ap-unknown' );
	assert.ok( _response.status >= 400 );
	assert.match( _response.data.error, /no pending approval/ );
} );

attack( S, 'POST /deliveries/:id/withdraw: a waiting action ends not sent', async () => {
	const _goal = await goal();
	const _asked = await _goal.submit( reply( people( 12 ) ) );
	assert.equal( ( await server.call( 'POST', `/deliveries/${_asked.delivery}/withdraw`, {} ) ).data.status, 'not_sent' );
} );

attack( S, 'GET /deliveries/:id: an unknown id answers null', async () => {
	const _response = await server.call( 'GET', '/deliveries/dl-unknown' );
	assert.equal( _response.status, 200 );
	assert.equal( _response.data, null );
} );

attack( S, 'leases over HTTP: a beat with the current fence renews, release ends the lease', async () => {
	const _goal = await goal();
	const _l = await _goal.lease();
	assert.equal( ( await server.call( 'POST', `/leases/${_l.id}/beat`, { fence: _l.fence } ) ).data.ok, true );
	assert.equal( ( await server.call( 'POST', `/leases/${_l.id}/beat`, { fence: _l.fence + 1 } ) ).data.ok, false );
	assert.deepEqual( ( await server.call( 'POST', `/leases/${_l.id}/release`, {} ) ).data, { ok: false }, 'without the fencing token nothing ends (A4)' );
	assert.deepEqual( ( await server.call( 'POST', `/leases/${_l.id}/release`, { fence: _l.fence } ) ).data, { ok: true } );
	assert.equal( ( await server.call( 'POST', `/leases/${_l.id}/beat`, { fence: _l.fence } ) ).data.ok, false );
} );

attacks( S, [
	{ name: 'GET /log?since=abc answers a list, not an error', query: 'since=abc' },
	{ name: 'GET /log?since=-1 answers a list', query: 'since=-1' },
	{ name: 'GET /log?since=1e400 answers an empty list', query: 'since=1e400', empty: true },
	{ name: 'GET /log?since=99999999 answers an empty list', query: 'since=99999999', empty: true },
], async ( { query, empty } ) => {
	const _response = await server.call( 'GET', `/log?${query}` );
	assert.equal( _response.status, 200 );
	assert.ok( Array.isArray( _response.data ) );
	if ( empty ) { assert.equal( _response.data.length, 0 ); }
} );

attack( S, 'GET /log: one call never answers more than a thousand events', async () => {
	server.main.db.transaction( () => {
		for ( let i = 0; i < 1100; i++ ) { server.main.log.append( 'filler', { i } ); }
	} );
	assert.equal( ( await server.call( 'GET', '/log?since=0' ) ).data.length, 1000 );
} );

attack( S, 'GET /events: a live client gets the past and new events, and leaves no listener behind when it goes', async () => {
	const _bus = server.main.log._bus;
	const _before = _bus._handlers.get( 'event' )?.size || 0;
	const _abort = new AbortController();
	const _response = await fetch( `${server.url}/events?since=0`, { signal: _abort.signal } );
	const _reader = _response.body.getReader();
	let _text = '';
	const _until = async ( needle ) => {
		while ( !_text.includes( needle ) ) {
			const { value } = await _reader.read();
			_text += Buffer.from( value ).toString( 'utf8' );
		}
	};
	await within( _until( 'gate_started' ), 2000 );
	server.main.log.append( 'probe_event', { x: 1 } );
	await within( _until( 'probe_event' ), 2000 );
	_abort.abort();
	await tick( 20 );
	assert.equal( _bus._handlers.get( 'event' )?.size || 0, _before );
	server.main.log.append( 'after_close', {} );
} );

attacks( S, [
	{ name: 'an unknown route is 404', method: 'GET', route: '/nothing-here', status: 404 },
	{ name: 'GET on a route that only takes POST is 404', method: 'GET', route: '/leases', status: 404 },
	{ name: 'PUT is not a method of the gate', method: 'PUT', route: '/contracts', status: 404 },
	{ name: 'DELETE of a delivery does not exist', method: 'DELETE', route: '/deliveries/dl-1', status: 404 },
	{ name: 'a trailing slash is another route', method: 'GET', route: '/unclear/', status: 404 },
	{ name: 'OPTIONS without an origin the gate allows is not answered', method: 'OPTIONS', route: '/deliveries', status: 404 },
], async ( { method, route, status } ) => {
	assert.equal( ( await server.call( method, route ) ).status, status );
} );

attack( S, 'answers are never cached by the browser', async () => {
	assert.equal( ( await server.call( 'GET', '/unclear' ) ).headers.get( 'cache-control' ), 'no-store' );
} );

attack( S, 'POST /master without a pin configured adds the operator\'s values', async () => {
	await server.call( 'POST', '/master', { kind: 'supplier', values: [ 'ACME' ] } );
	assert.equal( server.main.store.isMaster( 'supplier', 'ACME' ), true );
} );

attack( S, 'POST /master: values given as one text are refused, not split into characters', async () => {
	await server.call( 'POST', '/master', { kind: 'account', values: 'DE99' } );
	assert.equal( server.main.store.isMaster( 'account', '9' ), false );
} );

attack( S, 'O1: a restart on the same folder rebuilds an operation that was open before any attempt and sends it once', async () => {
	const _first = await startGate();
	const { contract, body } = proposal( surveySpec( { id: 'restart', deadline: FAR } ) );
	await _first.call( 'POST', '/contracts', body );
	await _first.call( 'POST', `/contracts/${contract.hash}/confirm`, { by: 'p' } );
	const _l = ( await _first.call( 'POST', '/leases', { node: 'r', move: 'm', contract: contract.hash, minutes: 5 } ) ).data;
	const _asked = ( await _first.call( 'POST', '/deliveries', { ...reply( people( 12 ) ), target: 'ceo', contract: contract.hash, lease: _l.id, fence: _l.fence } ) ).data;
	await _first.call( 'POST', `/approvals/${_asked.approval}`, { decision: 'approve' } );
	_first.main.db.run( 'UPDATE approvals SET status = \'consumed\' WHERE id = :id', { id: _asked.approval } );
	_first.main.db.run( 'UPDATE deliveries SET status = \'open\' WHERE id = :id', { id: _asked.delivery } );
	await _first.stop( { keep: true } );
	const _second = await startGate( { dir: _first.dir } );
	try {
		assert.equal( ( await _second.call( 'GET', `/deliveries/${_asked.delivery}` ) ).data.status, 'executed' );
		assert.equal( ( await _second.call( 'GET', '/outbox/ceo' ) ).data.length, 1 );
		const _again = await startGate( { dir: _first.dir } );
		assert.equal( ( await _again.call( 'GET', '/outbox/ceo' ) ).data.length, 1, 'a second restart sends nothing more' );
		await _again.stop( { keep: true } );
	} finally {
		await _second.stop();
	}
} );

attack( S, 'A6: fencing tokens continue across a restart of the gate process', async () => {
	const _first = await startGate();
	const { contract, body } = proposal( surveySpec( { id: 'fences', deadline: FAR } ) );
	await _first.call( 'POST', '/contracts', body );
	const _old = ( await _first.call( 'POST', '/leases', { node: 'same-node', move: 'm', contract: contract.hash, minutes: 1 } ) ).data;
	await _first.stop( { keep: true } );
	const _second = await startGate( { dir: _first.dir } );
	try {
		const _new = ( await _second.call( 'POST', '/leases', { node: 'same-node', move: 'm', contract: contract.hash, minutes: 1 } ) ).data;
		assert.equal( _new.fence, _old.fence + 1 );
		assert.equal( ( await _second.call( 'POST', `/leases/${_old.id}/beat`, { fence: _old.fence } ) ).data.ok, false );
	} finally {
		await _second.stop();
	}
} );
