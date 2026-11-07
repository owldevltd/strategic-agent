// Attacks on the in-process gate (Gate.Local): it must offer exactly the interface the core uses over HTTP, give
// the same answers, hand out copies, never a way to confirm or approve, and treat values that HTTP could not carry.
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
import { attack, attacks, hostile } from '../hostile.mjs';
import { Local, GateClient, gate, surveySpec, reply, people, proposal, startGate, fakeContract, quiet } from './fixture.mjs';

const S = 'gate/local.js';
const twelve = people( 12 );
// deliveries( contract ): read only, for O9 at a restart (a delivery whose record the dying core lost).
// proposeAt, gateProposal(s) and learnedActions submit and read what the agent proposes at the gate; deciding is not among them.
const METHODS = [ 'propose', 'contract', 'submit', 'delivery', 'deliveries', 'withdraw', 'redeem', 'unclear', 'lease', 'beat', 'release', 'outbox',
	'proposeAt', 'gateProposal', 'gateProposals', 'learnedActions', 'withdrawContract' ];
const json = value => JSON.parse( JSON.stringify( value ?? null ) );

// An Egress with a confirmed survey and the Local in front of it.
function local( options ) {
	const g = gate( options );
	return { ...g, local: new Local( g.egress ) };
}

async function asked( l, request = reply( twelve ) ) {
	const _lease = await l.local.lease( { node: 'w', move: 'm', contract: l.hash, minutes: 5 } );
	return l.local.submit( { contract: l.hash, lease: _lease.id, fence: _lease.fence, ...request } );
}

async function redeem( l, result ) {
	const _lease = await l.local.lease( { node: 'w', move: 'm', contract: l.hash, minutes: 5 } );
	return l.local.redeem( { delivery: result.delivery, approval: result.approval, lease: _lease.id, fence: _lease.fence } );
}

attacks( S, METHODS.map( name => ( { name: `interface: Local offers ${name}() like the HTTP client, and it answers with a promise`, method: name } ) ),
	( { method } ) => {
		assert.equal( typeof Local.prototype[ method ], 'function' );
		assert.equal( typeof GateClient.prototype[ method ], 'function' );
		const l = local();
		const _answer = l.local[ method ]( method === 'propose' ? l.contract : undefined );
		assert.ok( _answer instanceof Promise );
		_answer.catch( () => null );
	} );

attack( S, 'interface: Local has no way to confirm a goal or approve an action', () => {
	for ( const name of [ 'confirm', 'decide', 'approve', 'addMaster', 'recover' ] ) {
		assert.equal( Local.prototype[ name ], undefined, name );
	}
	assert.deepEqual( Object.getOwnPropertyNames( Local.prototype ).filter( name => name !== 'constructor' ).sort(), [ ...METHODS ].sort() );
} );

attack( S, 'interface: the core holding a Local cannot reach confirm or decide through it either', () => {
	const l = local( { confirm: false } );
	assert.equal( typeof l.local.egress?.confirm, 'undefined', 'the egress behind Local is reachable as a public property' );
} );

attack( S, 'propose: a contract whose hash does not match its content is refused', async () => {
	const l = local();
	const _honest = l.contract;
	const _forged = fakeContract( { ..._honest.canonical(), goal: 'Pay everybody' }, _honest.rules(), _honest.hash );
	await assert.rejects( l.local.propose( _forged ), /does not match/ );
} );

attack( S, 'propose: proposing the same contract twice gives the same row, still confirmed', async () => {
	const l = local();
	const _again = await l.local.propose( l.contract );
	assert.equal( _again.hash, l.hash );
	assert.equal( _again.status, 'confirmed' );
} );

attack( S, 'propose: a new goal is only proposed; Local cannot make it confirmed', async () => {
	const l = local();
	const _new = proposal( surveySpec( { id: 'new-goal' } ) ).contract;
	assert.equal( ( await l.local.propose( _new ) ).status, 'proposed' );
	const _result = await asked( l, { ...reply( twelve ), contract: _new.hash } );
	assert.equal( _result.status, 'refused' );
} );

attack( S, 'contract: an unknown hash answers null, like the HTTP gate', async () => {
	const l = local();
	assert.equal( await l.local.contract( 'f'.repeat( 64 ) ), null );
} );

attack( S, 'contract: what the core does with the returned contract does not change the rules at the gate', async () => {
	const l = local();
	const _copy = await l.local.contract( l.hash );
	_copy.rules.gate = [];
	_copy.status = 'proposed';
	assert.equal( ( await asked( l, reply( [ 'r01', 'r02' ] ) ) ).status, 'refused' );
} );

attack( S, 'submit: changing the request object after submit does not change what was booked', async () => {
	const l = local();
	const _request = reply( people( 12 ) );
	const _result = await asked( l, _request );
	_request.params.body = 'Something else';
	_request.cohort.length = 1;
	const _row = await l.local.delivery( _result.delivery );
	assert.equal( _row.params.body, 'Workload is the main reason' );
	assert.equal( _row.cohort.length, 12 );
} );

attack( S, 'delivery: the returned row is a copy; changing it does not change the ledger or the token', async () => {
	const l = local();
	const _result = await asked( l );
	const _row = await l.local.delivery( _result.delivery );
	_row.params.body = 'tampered';
	_row.status = 'approved';
	await l.egress.decide( _result.approval, 'approve', 'person' );
	assert.equal( ( await redeem( l, _result ) ).status, 'executed' );
	assert.equal( l.outbox()[ 0 ].params, JSON.stringify( { body: 'Workload is the main reason' } ) );
} );

attack( S, 'the whole way through Local: submit, a person approves at the gate, redeem, the outbox shows one message', async () => {
	const l = local();
	const _result = await asked( l );
	assert.equal( _result.status, 'awaiting_approval' );
	await l.egress.decide( _result.approval, 'approve', 'person' );
	assert.equal( ( await redeem( l, _result ) ).status, 'executed' );
	assert.equal( ( await redeem( l, _result ) ).status, 'executed', 'a replay sees the one operation' );
	assert.equal( ( await l.local.outbox( 'ceo' ) ).length, 1 );
} );

attack( S, 'withdraw: through Local a waiting action ends not sent and its token is gone', async () => {
	const l = local();
	const _result = await asked( l );
	assert.equal( ( await l.local.withdraw( _result.delivery ) ).status, 'not_sent' );
	await assert.rejects( l.egress.decide( _result.approval, 'approve', 'person' ), /no pending approval/ );
} );

attack( S, 'unclear: through Local the list holds the operations a person must settle', async () => {
	const l = local( { plain: true, service: { failures: 1 } } );
	const _result = await asked( l );
	await l.egress.decide( _result.approval, 'approve', 'person' );
	await redeem( l, _result );
	assert.deepEqual( ( await l.local.unclear() ).map( item => item.id ), [ _result.delivery ] );
} );

attack( S, 'lease and beat: a beat with the current fence renews, one with an old fence does not', async () => {
	const l = local();
	const _old = await l.local.lease( { node: 'n', move: 'm', contract: l.hash, minutes: 5 } );
	const _new = await l.local.lease( { node: 'n', move: 'm', contract: l.hash, minutes: 5 } );
	assert.equal( ( await l.local.beat( _new.id, _new.fence ) ).ok, true );
	assert.equal( ( await l.local.beat( _old.id, _old.fence ) ).ok, false );
	assert.equal( ( await l.local.beat( _new.id, _old.fence ) ).ok, false );
} );

attack( S, 'release: answers like the HTTP gate, with { ok: true }', async () => {
	const l = local();
	const _lease = await l.local.lease( { node: 'n', move: 'm', contract: l.hash, minutes: 5 } );
	assert.deepEqual( await l.local.release( _lease.id ), { ok: false }, 'without the fencing token nothing ends (A4)' );
	assert.deepEqual( await l.local.release( _lease.id, _lease.fence ), { ok: true } );
	assert.equal( ( await l.local.beat( _lease.id, _lease.fence ) ).ok, false );
} );

attacks( S, [
	{ name: 'values HTTP cannot carry: a Date in params is either refused or redeemable', value: new Date( '2026-11-05T09:00:00Z' ) },
	{ name: 'values HTTP cannot carry: a BigInt in params is refused cleanly', value: 10n },
	{ name: 'values HTTP cannot carry: a function in params is either refused or redeemable', value: () => 1 },
	{ name: 'values HTTP cannot carry: NaN in params becomes null on both sides and stays redeemable', value: NaN },
	{ name: 'values HTTP cannot carry: undefined in params is dropped on both sides and stays redeemable', value: undefined },
], async ( { value } ) => {
	const l = local();
	const _result = await asked( l, { ...reply( twelve ), params: { body: 'x', extra: value } } ).catch( error => ( { status: 'thrown', error } ) );
	assert.notEqual( _result.status, 'thrown', String( _result.error ) );
	if ( _result.status === 'awaiting_approval' ) {
		await l.egress.decide( _result.approval, 'approve', 'person' );
		assert.equal( ( await redeem( l, _result ) ).status, 'executed' );
	}
} );

attacks( S, hostile( 'strings' ).filter( ( _item, i ) => i % 4 === 1 ).map( ( { label, value } ) => ( { name: `delivery( ${label} ) through Local is null`, value } ) ),
	async ( { value } ) => {
		const l = local();
		assert.equal( await l.local.delivery( value ), null );
	} );

// Parity: the same gate answers through Local and through HTTP; the answers must be the same data.
let server;
let client;
let view;
let silence;

before( async () => {
	silence = quiet();
	server = await startGate();
	client = new GateClient( server.url );
	view = new Local( server.main.egress );
} );

after( async () => {
	await server.stop();
	silence.restore();
} );

async function parityFlow() {
	const { contract } = proposal( surveySpec( { id: `parity-${Math.random()}`, deadline: '2099-01-01T00:00:00Z' } ) );
	await client.propose( contract );
	server.main.egress.confirm( contract.hash, 'person' );
	const _lease = await client.lease( { node: 'p', move: 'm', contract: contract.hash, minutes: 5 } );
	const _result = await client.submit( { ...reply( twelve ), contract: contract.hash, lease: _lease.id, fence: _lease.fence } );
	return { contract, lease: _lease, result: _result };
}

attack( S, 'parity: contract() answers the same through Local and HTTP', async () => {
	const { contract } = await parityFlow();
	assert.deepEqual( json( await view.contract( contract.hash ) ), await client.contract( contract.hash ) );
} );

attack( S, 'parity: delivery() answers the same through Local and HTTP', async () => {
	const { result } = await parityFlow();
	assert.deepEqual( json( await view.delivery( result.delivery ) ), await client.delivery( result.delivery ) );
} );

attack( S, 'parity: an unknown delivery is null through Local and through HTTP', async () => {
	assert.equal( await view.delivery( 'dl-none' ), null );
	assert.equal( await client.delivery( 'dl-none' ), null );
} );

attack( S, 'parity: withdraw() answers the same shape through Local and HTTP', async () => {
	const { result } = await parityFlow();
	const _local = json( await view.withdraw( result.delivery ) );
	assert.deepEqual( await client.withdraw( result.delivery ), _local );
} );

attack( S, 'parity: unclear() answers the same through Local and HTTP', async () => {
	assert.deepEqual( json( await view.unclear() ), await client.unclear() );
} );

attack( S, 'parity: beat() answers the same through Local and HTTP', async () => {
	const { lease } = await parityFlow();
	const _http = await client.beat( lease.id, lease.fence );
	assert.deepEqual( Object.keys( json( await view.beat( lease.id, lease.fence ) ) ).sort(), Object.keys( _http ).sort() );
	assert.deepEqual( await client.beat( lease.id, lease.fence + 1 ), json( await view.beat( lease.id, lease.fence + 1 ) ) );
} );

attack( S, 'parity: outbox() answers the same through Local and HTTP', async () => {
	assert.deepEqual( json( await view.outbox( 'ceo' ) ), await client.outbox( 'ceo' ) );
} );

attack( S, 'parity: a refused redeem looks the same through Local and HTTP', async () => {
	const { result } = await parityFlow();
	const _http = await client.redeem( { delivery: result.delivery, approval: 'ap-forged', lease: 'ls-none', fence: 1 } );
	const _local = json( await view.redeem( { delivery: result.delivery, approval: 'ap-forged', lease: 'ls-none', fence: 1 } ) );
	assert.deepEqual( _http, _local );
	assert.equal( _http.status, 'refused' );
} );

attack( S, 'parity: lease() answers the same fields through Local and HTTP', async () => {
	const { contract } = await parityFlow();
	const _http = await client.lease( { node: 'pl', move: 'm', contract: contract.hash, minutes: 1 } );
	const _local = json( await view.lease( { node: 'pl', move: 'm', contract: contract.hash, minutes: 1 } ) );
	assert.deepEqual( Object.keys( _local ).sort(), Object.keys( _http ).sort() );
	assert.equal( _local.fence, _http.fence + 1 );
} );

attack( S, 'parity: a refused submit has the same shape through Local and HTTP', async () => {
	const _request = { ...reply( [ 'r01' ] ), contract: 'f'.repeat( 64 ) };
	const _http = await client.submit( _request );
	const _local = json( await view.submit( _request ) );
	assert.deepEqual( Object.keys( _local ).sort(), Object.keys( _http ).sort() );
	assert.deepEqual( _local.reasons, _http.reasons );
	assert.equal( _http.status, 'refused' );
} );

attack( S, 'parity: proposing a known contract again answers the same row through Local and HTTP', async () => {
	const { contract } = await parityFlow();
	assert.deepEqual( json( await view.propose( contract ) ), await client.propose( contract ) );
} );

attack( S, 'deliveries: the restart reads every delivery of one contract, nothing for anything else (O9)', async () => {
	const l = local( {} );
	const _rows = await l.local.deliveries( l.hash );
	assert.ok( Array.isArray( _rows ) );
	for ( const odd of [ null, undefined, 42, {}, [] ] ) {
		assert.deepEqual( await l.local.deliveries( odd ), [] );
	}
} );
