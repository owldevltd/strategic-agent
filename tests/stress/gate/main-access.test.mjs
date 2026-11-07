// Who may call what at the gate process: the core with its token (propose, lease, submit), the operator with the pin
// (confirm, approve, settle, master data), and reading needs either. The waiting goals come from the ledger, not from a
// log capped at a page; master data is scoped to a mission kind and can be taken back; CORS only for named origins.
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { attack, attacks } from '../hostile.mjs';
import { startGate, proposal, surveySpec, invoiceSpec, pay, quiet, CORE_TOKEN, IBAN } from './fixture.mjs';

const S = 'gate/main.js';
const PIN = 'access-pin-4711';
const FAR = '2099-01-01T00:00:00Z';
const NONE = { 'x-core-token': '' };
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

const goal = ( spec = surveySpec() ) => {
	counter += 1;
	return proposal( { ...spec, id: `${spec.id}-acc${counter}`, deadline: FAR } );
};

attacks( S, [
	{ name: 'core: proposing without the core token is 403', route: '/contracts' },
	{ name: 'core: a lease without the core token is 403', route: '/leases' },
	{ name: 'core: submitting without the core token is 403', route: '/deliveries' },
	{ name: 'core: a beat without the core token is 403', route: '/leases/ls-1/beat' },
	{ name: 'core: a release without the core token is 403', route: '/leases/ls-1/release' },
	{ name: 'core: a withdrawal without the core token is 403', route: '/deliveries/dl-1/withdraw' },
	{ name: 'core: redeeming without the core token is 403', route: '/deliveries/dl-1/redeem' },
], async ( { route } ) => {
	const _before = server.main.db.get( 'SELECT COUNT(*) AS n FROM deliveries' ).n;
	const _response = await server.call( 'POST', route, { contract: 'x' }, { headers: NONE } );
	assert.equal( _response.status, 403 );
	assert.equal( _response.data.error, 'core token required' );
	assert.equal( server.main.db.get( 'SELECT COUNT(*) AS n FROM deliveries' ).n, _before, 'nothing is booked' );
} );

attacks( S, [
	{ name: 'core: the operator pin is no core token', headers: { 'x-core-token': '', 'x-operator-pin': PIN } },
	{ name: 'core: a wrong core token is 403', headers: { 'x-core-token': `${CORE_TOKEN}x` } },
	{ name: 'core: the core token in the body does not count', headers: NONE, extra: { token: CORE_TOKEN, 'x-core-token': CORE_TOKEN } },
	{ name: 'core: the core token in the query does not count', headers: NONE, query: `?x-core-token=${CORE_TOKEN}` },
], async ( { headers, extra = {}, query = '' } ) => {
	const { contract, body } = goal();
	assert.equal( ( await server.call( 'POST', `/contracts${query}`, { ...body, ...extra }, { headers } ) ).status, 403 );
	assert.equal( server.main.store.contract( contract.hash ), null );
} );

attack( S, 'core: with the core token a goal is proposed and waits for a person', async () => {
	const { contract, body } = goal();
	assert.equal( ( await server.call( 'POST', '/contracts', body ) ).data.status, 'proposed' );
	assert.equal( server.main.store.contract( contract.hash ).status, 'proposed' );
} );

attacks( S, [
	{ name: 'read: the ledger of a goal needs the pin or the token', route: '/contracts/x' },
	{ name: 'read: the deliveries of a goal need the pin or the token', route: '/contracts/x/deliveries' },
	{ name: 'read: the waiting goals need the pin or the token', route: '/contracts?status=proposed' },
	{ name: 'read: one delivery needs the pin or the token', route: '/deliveries/dl-1' },
	{ name: 'read: the unclear actions need the pin or the token', route: '/unclear' },
	{ name: 'read: the approvals need the pin or the token', route: '/approvals' },
	{ name: 'read: an outbox needs the pin or the token', route: '/outbox/hr' },
	{ name: 'read: the log needs the pin or the token', route: '/log' },
	{ name: 'read: the live log needs the pin or the token', route: '/events' },
], async ( { route } ) => {
	const _response = await server.call( 'GET', route, undefined, { headers: NONE } );
	assert.equal( _response.status, 403 );
	assert.equal( _response.data.error, 'operator pin required or core token required' );
} );

attacks( S, [
	{ name: 'read: with the pin in its header the log is read', headers: { ...NONE, 'x-operator-pin': PIN }, want: 200 },
	{ name: 'read: with the core token the log is read', headers: {}, want: 200 },
	{ name: 'read: a wrong pin reads nothing', headers: { ...NONE, 'x-operator-pin': 'guess-1' }, want: 403 },
	{ name: 'read: the pin in the query reads nothing', headers: NONE, query: `?pin=${PIN}`, want: 403 },
	{ name: 'read: the pin in a cookie reads nothing', headers: { ...NONE, Cookie: `pin=${PIN}` }, want: 403 },
	{ name: 'read: the pin as a bearer token reads nothing', headers: { ...NONE, Authorization: `Bearer ${PIN}` }, want: 403 },
], async ( { headers, query = '', want } ) => {
	assert.equal( ( await server.call( 'GET', `/log${query}`, undefined, { headers } ) ).status, want );
} );

attack( S, 'person: the core token never confirms a goal; the pin in its header does', async () => {
	const { contract, body } = goal();
	await server.call( 'POST', '/contracts', body );
	assert.equal( ( await server.call( 'POST', `/contracts/${contract.hash}/confirm`, { by: 'core' } ) ).status, 403 );
	assert.equal( server.main.store.contract( contract.hash ).status, 'proposed' );
	assert.equal( ( await server.call( 'POST', `/contracts/${contract.hash}/confirm`, { by: 'hr-lead' }, { headers: { 'x-operator-pin': PIN } } ) ).status, 200 );
	assert.equal( server.main.store.contract( contract.hash ).status, 'confirmed' );
} );

attack( S, 'withdraw: the core takes back a goal nobody confirmed; it leaves the list and can no longer be confirmed', async () => {
	const { contract, body } = goal();
	await server.call( 'POST', '/contracts', body );
	const _answer = await server.call( 'POST', `/contracts/${contract.hash}/withdraw`, {} );
	assert.deepEqual( [ _answer.status, _answer.data ], [ 200, { withdrawn: true, status: 'withdrawn' } ] );
	const _listed = ( await server.call( 'GET', '/contracts?status=proposed' ) ).data;
	assert.ok( !_listed.some( item => item.hash === contract.hash ) );
	await server.call( 'POST', `/contracts/${contract.hash}/confirm`, { by: 'hr-lead' }, { headers: { 'x-operator-pin': PIN } } );
	assert.equal( server.main.store.contract( contract.hash ).status, 'withdrawn', 'a withdrawn goal is never confirmed' );
	assert.ok( server.main.log.since( 0, 1e9 ).some( event => event.kind === 'contract_withdrawn' && event.data.hash === contract.hash ) );
} );

attack( S, 'withdraw: only the core may, and a confirmed goal stays confirmed', async () => {
	const { contract, body } = goal();
	await server.call( 'POST', '/contracts', body );
	assert.equal( ( await server.call( 'POST', `/contracts/${contract.hash}/withdraw`, {}, { headers: NONE } ) ).status, 403 );
	assert.equal( ( await server.call( 'POST', `/contracts/${contract.hash}/withdraw`, {}, { headers: { ...NONE, 'x-operator-pin': PIN } } ) ).status, 403,
		'the operator pin is no core token' );
	await server.call( 'POST', `/contracts/${contract.hash}/confirm`, { by: 'hr-lead' }, { headers: { 'x-operator-pin': PIN } } );
	assert.deepEqual( ( await server.call( 'POST', `/contracts/${contract.hash}/withdraw`, {} ) ).data, { withdrawn: false, status: 'confirmed' } );
	assert.deepEqual( ( await server.call( 'POST', '/contracts/unknown-hash/withdraw', {} ) ).data, { withdrawn: false, status: null } );
} );

attack( S, 'person: guessing the pin locks the person routes, not the core: the core still reads and proposes', async () => {
	const _own = await startGate( { pin: PIN } );
	try {
		for ( let i = 0; i < 10; i++ ) { await _own.call( 'POST', '/master', { kind: 'account', values: [ 'x' ], pin: `guess-${i}` } ); }
		assert.equal( ( await _own.call( 'POST', '/master', { kind: 'account', values: [ 'x' ], pin: PIN } ) ).status, 429 );
		assert.equal( ( await _own.call( 'GET', '/approvals' ) ).status, 200 );
		const { body } = goal();
		assert.equal( ( await _own.call( 'POST', '/contracts', body ) ).status, 200 );
	} finally {
		await _own.stop();
	}
}, { timeout: 30000 } );

attack( S, 'start: a core token shorter than 24 characters stops the gate', async () => {
	await assert.rejects( startGate( { pin: PIN, token: 'too-short-token' } ), /GATE_CORE_TOKEN needs at least 24 characters/ );
} );

attack( S, 'start: the gate reports which secrets it guards with, never the secrets', () => {
	const _started = server.main.log.since( 0 ).find( item => item.kind === 'gate_started' );
	assert.equal( _started.data.operatorPin, true );
	assert.equal( _started.data.coreToken, true );
	assert.ok( !JSON.stringify( _started ).includes( PIN ) && !JSON.stringify( _started ).includes( CORE_TOKEN ) );
} );

attack( S, 'open: a gate without secrets (development) takes every request', async () => {
	const _open = await startGate();
	try {
		const { body } = goal();
		assert.equal( ( await _open.call( 'POST', '/contracts', body ) ).status, 200 );
		assert.equal( ( await _open.call( 'GET', '/log' ) ).status, 200 );
	} finally {
		await _open.stop();
	}
} );

attack( S, 'proposed: the waiting goals come from the ledger in the shape of their event, the confirmed ones not', async () => {
	const _waiting = goal();
	const _confirmed = goal();
	await server.call( 'POST', '/contracts', _waiting.body );
	await server.call( 'POST', '/contracts', _confirmed.body );
	await server.call( 'POST', `/contracts/${_confirmed.contract.hash}/confirm`, { pin: PIN } );
	const _list = ( await server.call( 'GET', '/contracts?status=proposed' ) ).data;
	const _item = _list.find( item => item.hash === _waiting.contract.hash );
	assert.deepEqual( Object.keys( _item ).sort(), [ 'goal', 'hash', 'id', 'parent', 'proposedAt', 'rules', 'understood' ] );
	assert.equal( _item.goal, _waiting.contract.goal );
	assert.ok( Array.isArray( _item.rules.gate ) );
	assert.ok( !_list.some( item => item.hash === _confirmed.contract.hash ) );
} );

attack( S, 'proposed: a goal proposed after a thousand other events in the log is still listed', async () => {
	const _own = await startGate( { pin: PIN } );
	try {
		// One transaction: 1,100 single writes take half a minute on a busy disk.
		_own.main.log.db.transaction( () => {
			for ( let i = 0; i < 1100; i++ ) { _own.main.log.append( 'noise', { i } ); }
		} );
		const _first = goal();
		await _own.call( 'POST', '/contracts', _first.body );
		assert.ok( !( await _own.call( 'GET', '/log' ) ).data.some( item => item.kind === 'contract_proposed' ), 'the first page of the log no longer shows it' );
		assert.ok( ( await _own.call( 'GET', '/contracts?status=proposed' ) ).data.some( item => item.hash === _first.contract.hash ) );
	} finally {
		await _own.stop();
	}
}, { timeout: 30000 } );

attacks( S, [
	{ name: 'proposed: a status nobody has lists nothing', query: '?status=nothing', want: 0 },
	{ name: 'proposed: without a status the waiting goals are listed', query: '', want: null },
], async ( { query, want } ) => {
	const _list = ( await server.call( 'GET', `/contracts${query}` ) ).data;
	assert.ok( Array.isArray( _list ) );
	if ( want !== null ) { assert.equal( _list.length, want ); }
	assert.ok( _list.every( item => server.main.store.contract( item.hash ).status === 'proposed' ) );
} );

attack( S, 'master: values added for one mission kind serve its goals and no other', async () => {
	const _payments = goal( { ...invoiceSpec(), kind: 'supplier-payments' } );
	const _other = goal( { ...invoiceSpec(), kind: 'other-payments' } );
	for ( const { contract, body } of [ _payments, _other ] ) {
		await server.call( 'POST', '/contracts', body );
		await server.call( 'POST', `/contracts/${contract.hash}/confirm`, { pin: PIN } );
	}
	const _account = 'DE00100000000000000001';
	assert.equal( ( await server.call( 'POST', '/master', { pin: PIN, kind: 'account', values: [ _account ], scope: 'supplier-payments' } ) ).status, 200 );
	const _submit = async ( contract ) => {
		const _l = ( await server.call( 'POST', '/leases', { node: 'n', move: 'm', contract: contract.hash, minutes: 5 } ) ).data;
		return ( await server.call( 'POST', '/deliveries', { ...pay( `R-${counter}`, 10, { iban: _account } ), contract: contract.hash, lease: _l.id, fence: _l.fence } ) ).data;
	};
	assert.equal( ( await _submit( _payments.contract ) ).status, 'awaiting_approval' );
	const _refused = await _submit( _other.contract );
	assert.equal( _refused.status, 'refused' );
	assert.ok( _refused.reasons.some( reason => /not in the master data/.test( reason.reason ) ) );
} );

attack( S, 'master: revoked values serve no goal from then on, and the revocation is logged', async () => {
	const { contract, body } = goal( invoiceSpec() );
	await server.call( 'POST', '/contracts', body );
	await server.call( 'POST', `/contracts/${contract.hash}/confirm`, { pin: PIN } );
	const _account = 'DE00100000000000000002';
	await server.call( 'POST', '/master', { pin: PIN, kind: 'account', values: [ _account ] } );
	const _revoked = await server.call( 'POST', '/master/revoke', { pin: PIN, kind: 'account', values: [ _account ] } );
	assert.deepEqual( _revoked.data, { revoked: 1 } );
	const _l = ( await server.call( 'POST', '/leases', { node: 'n', move: 'm', contract: contract.hash, minutes: 5 } ) ).data;
	const _result = ( await server.call( 'POST', '/deliveries', { ...pay( 'R-9', 10, { iban: _account } ), contract: contract.hash, lease: _l.id, fence: _l.fence } ) ).data;
	assert.equal( _result.status, 'refused' );
	assert.ok( server.main.log.since( 0, 1e9 ).some( item => item.kind === 'master_revoked' && item.data.revoked === 1 ) );
} );

attacks( S, [
	{ name: 'master: revoking without the pin is 403 and the value stays', body: { kind: 'account', values: [ IBAN ] }, want: 403 },
	{ name: 'master: revoking with the core token only is 403', body: { kind: 'account', values: [ IBAN ], token: CORE_TOKEN }, want: 403 },
	{ name: 'master: revoking values that are no list is 400', body: { kind: 'account', values: IBAN, pin: PIN }, want: 400 },
	{ name: 'master: revoking without a kind is 400', body: { values: [ IBAN ], pin: PIN }, want: 400 },
], async ( { body, want } ) => {
	server.main.store.addMaster( 'account', [ IBAN ] );
	assert.equal( ( await server.call( 'POST', '/master/revoke', body ) ).status, want );
	assert.equal( server.main.store.isMaster( 'account', IBAN ), true );
} );

attacks( S, [
	{ name: 'cors: the operator page of the core may call the gate from its origin', origin: 'http://127.0.0.1:8090', allowed: true },
	{ name: 'cors: localhost is the same page', origin: 'http://localhost:8090', allowed: true },
	{ name: 'cors: another port of the same host is another origin', origin: 'http://127.0.0.1:8091', allowed: false },
	{ name: 'cors: another site gets no CORS header', origin: 'https://evil.example', allowed: false },
], async ( { origin, allowed } ) => {
	const _own = await startGate( { pin: PIN, origins: [ 'http://127.0.0.1:8090', 'http://localhost:8090' ] } );
	try {
		const _preflight = await fetch( `${_own.url}/approvals`, { method: 'OPTIONS', headers: { Origin: origin } } );
		assert.equal( _preflight.status, allowed ? 204 : 403 );
		assert.equal( _preflight.headers.get( 'access-control-allow-origin' ), allowed ? origin : null );
	} finally {
		await _own.stop();
	}
} );
