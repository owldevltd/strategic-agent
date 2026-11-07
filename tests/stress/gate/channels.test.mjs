// Attacks on the channel map (which channel delivers which action): action names that are prototype members or
// otherwise odd, per-action channels with and without the service's guarantee, maps without a default.
import assert from 'node:assert/strict';
import { attack, attacks, hostile, within } from '../hostile.mjs';
import { Db, Channels, Outbox, gate, restart, settle, reply, people, actionsWith, FOREVER } from './fixture.mjs';

const S = 'gate/channels.js';
const OUTWARD = { criticality: 'outward', carries: [ 'message' ], sensitive: [], idempotencyH: 72 };

// A gate whose channels come from Channels.create, as in the gate process; actions may add entries to the table.
function routed( { actions = {}, extra = {}, ...options } = {} ) {
	const _db = new Db( ':memory:' );
	const _channels = { ...Channels.create( _db ), ...extra };
	return { ...gate( { db: _db, channels: _channels, actions: actionsWith( actions ), ...options } ), channels: _channels };
}

const message = action => ( { action, target: 'ceo', params: { body: `via ${action}` }, labels: { body: [ 'own' ] } } );
const delivered = ( g, action ) => g.db.all( 'SELECT * FROM outbox WHERE action = :action', { action } );

attack( S, 'create(): the default channel and the outbox are one and the same', () => {
	const _channels = Channels.create( new Db( ':memory:' ) );
	assert.equal( _channels.default, _channels.outbox );
	assert.ok( _channels.default instanceof Outbox );
} );

attack( S, 'create(): the default channel keeps the idempotency key (O2)', () => {
	const _channels = Channels.create( new Db( ':memory:' ) );
	assert.equal( _channels.default.constructor.IDEMPOTENT, true );
} );

attack( S, 'create(): two maps on one ledger share the outbox table, as a restarted gate must', async () => {
	const _db = new Db( ':memory:' );
	await Channels.create( _db ).default.send( { id: 'dl-1', action: 'reply', target: 'ceo', params: {} } );
	const _again = await Channels.create( _db ).default.send( { id: 'dl-1', action: 'reply', target: 'ceo', params: {} } );
	assert.equal( _again.receipt.repeated, true );
} );

attack( S, 'create(): every call gives its own map; adding a channel to one does not add it to the other', () => {
	const _db = new Db( ':memory:' );
	const _a = Channels.create( _db );
	const _b = Channels.create( _db );
	_a.payment = { send: async () => ( { ok: true } ) };
	assert.equal( _b.payment, undefined );
} );

attacks( S, [ 'report', 'reply', 'invite', 'payment' ].map( action => ( { name: `v1: the catalog action ${action} is delivered into the outbox`, action } ) ),
	async ( { action } ) => {
		const g = routed();
		const _request = action === 'payment'
			? { action, target: 'bank', params: { invoiceId: 'R-1', iban: 'DE02120300000000202051', amount: 1 }, labels: { iban: [ 'own' ] } }
			: { ...message( action ), cohort: people( 12 ) };
		const _result = await g.send( _request );
		assert.equal( _result.status, 'executed' );
		assert.equal( delivered( g, action ).length, 1 );
	} );

attack( S, 'a channel added for one action delivers that action only; all others still reach the outbox', async () => {
	const _sent = [];
	const g = routed( { extra: { invite: { send: async ( item ) => {
		_sent.push( item.action );
		return { ok: true, receipt: { id: 'invite-1' } };
	} } } } );
	await g.send( { ...message( 'invite' ), cohort: people( 12 ) } );
	await g.send( reply( people( 12, 30 ) ) );
	assert.deepEqual( _sent, [ 'invite' ] );
	assert.equal( delivered( g, 'invite' ).length, 0 );
	assert.equal( delivered( g, 'reply' ).length, 1 );
} );

attack( S, 'G-7a: an added channel without the guarantee gets one attempt, while the outbox would be retried', async () => {
	let _calls = 0;
	const g = routed( { extra: { invite: { send: async () => {
		_calls += 1;
		return { ok: false, error: 'smtp timeout' };
	} } } } );
	const _result = await g.send( { ...message( 'invite' ), cohort: people( 12 ) } );
	await new Promise( resolve => setTimeout( resolve, 10 ) );
	assert.equal( _result.status, 'unclear' );
	assert.equal( _calls, 1 );
} );

attack( S, 'O2: a flag on the channel object itself is not the guarantee; only the channel class declares it', async () => {
	let _calls = 0;
	const g = routed( { extra: { invite: { IDEMPOTENT: true, send: async () => {
		_calls += 1;
		return { ok: false, error: 'busy' };
	} } } } );
	await g.send( { ...message( 'invite' ), cohort: people( 12 ) } );
	await new Promise( resolve => setTimeout( resolve, 10 ) );
	assert.equal( _calls, 1 );
} );

attacks( S, [
	{ name: 'O2: an idempotent channel for an action without retention in the table gets one attempt', idempotencyH: null },
	{ name: 'O2: an idempotent channel for an action with zero retention gets one attempt', idempotencyH: 0 },
	{ name: 'O2: an idempotent channel for an action with a retention of "lots" gets one attempt', idempotencyH: 'lots' },
], async ( { idempotencyH } ) => {
	const _db = new Db( ':memory:' );
	class Keeper extends Outbox {

		static IDEMPOTENT = true;

		async send() {
			this.calls = ( this.calls || 0 ) + 1;
			return { ok: false, error: 'busy' };
		}

	}
	const _keeper = new Keeper( _db );
	const g = gate( {
		db: _db, channels: { ...Channels.create( _db ), invite: _keeper }, actions: actionsWith( { invite: { ...OUTWARD, idempotencyH } } ),
	} );
	const _result = await g.send( { ...message( 'invite' ), cohort: people( 12 ) } );
	await new Promise( resolve => setTimeout( resolve, 10 ) );
	assert.equal( _result.status, 'unclear' );
	assert.equal( _keeper.calls, 1 );
} );

attack( S, 'A2: a hanging channel for one action ends unclear and does not hold up the outbox for the others', async () => {
	const g = routed( { sendMs: 20, extra: { invite: { send: () => new Promise( () => {} ) } } } );
	const [ _hung, _other ] = await within( Promise.all( [
		g.send( { ...message( 'invite' ), cohort: people( 12 ) } ),
		g.send( reply( people( 12, 30 ) ) ),
	] ), 1000 );
	assert.equal( _hung.status, 'unclear' );
	assert.equal( _other.status, 'executed' );
} );

attack( S, 'O4: after a crash an added channel without lookup cannot confirm anything; the operation is unclear', async () => {
	const g = routed( { sendMs: FOREVER, extra: { invite: { send: () => new Promise( () => {} ) } } } );
	const _ok = await g.approved( { ...message( 'invite' ), cohort: people( 12 ) } );
	g.redeem( _ok );
	await new Promise( resolve => setTimeout( resolve, 2 ) );
	const _after = restart( g );
	_after.egress.channels.invite = { send: async () => ( { ok: true } ) };
	await _after.egress.recover();
	assert.equal( _after.row( _ok.delivery ).status, 'unclear' );
} );

const PROTOTYPE = [ 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
	'__proto__', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__' ];

attacks( S, PROTOTYPE.map( name => ( { name: `an action named ${name} in the table is delivered by the default channel`, action: name } ) ),
	async ( { action } ) => {
		const g = routed( { actions: { [ action ]: OUTWARD } } );
		const _result = await within( g.send( message( action ) ), 1000 ).catch( error => ( { status: 'thrown', error } ) );
		assert.equal( _result.status, 'executed' );
		assert.equal( g.outbox().length, 1 );
	} );

attacks( S, [ 'default', 'outbox', '0', 'Reply', ...hostile( 'keys' ).map( item => item.value ).filter( key => !PROTOTYPE.includes( key ) && key !== 'prototype' ) ]
	.map( action => ( { name: `the action name ${JSON.stringify( action.length > 30 ? `${action.slice( 0, 10 )}…` : action )} reaches the outbox`, action } ) ),
async ( { action } ) => {
	const g = routed( { actions: { [ action ]: OUTWARD } } );
	assert.equal( ( await g.send( message( action ) ) ).status, 'executed' );
	assert.equal( delivered( g, action ).length, 1 );
} );

attack( S, 'an action named prototype is delivered by the default channel', async () => {
	const g = routed( { actions: { prototype: OUTWARD } } );
	assert.equal( ( await g.send( message( 'prototype' ) ) ).status, 'executed' );
} );

attack( S, 'a channel registered for an action the table does not know is never used', async () => {
	let _used = false;
	const g = routed( { extra: { wire: { send: async () => {
		_used = true;
		return { ok: true };
	} } } } );
	const _result = await g.submit( message( 'wire' ) );
	assert.equal( _result.status, 'refused' );
	assert.equal( _used, false );
} );

attack( S, 'A8: a channel map without a default refuses an action cleanly instead of crashing', async () => {
	const g = gate( { channels: { invite: { send: async () => ( { ok: true } ) } } } );
	const _ok = await g.approved( reply( people( 12 ) ) );
	const _result = await within( g.redeem( _ok ), 1000 ).catch( error => ( { status: 'thrown', error } ) );
	assert.notEqual( _result.status, 'thrown', String( _result.error ) );
	assert.notEqual( g.row( _ok.delivery ).status, 'open' );
} );

attack( S, 'the receipt of an added channel is kept with the operation as its proof', async () => {
	const g = routed( { extra: { invite: { send: async () => ( { ok: true, receipt: { id: '<a1f3@mail>' } } ) } } } );
	const _result = await g.send( { ...message( 'invite' ), cohort: people( 12 ) } );
	assert.equal( g.row( _result.delivery ).receipt.id, '<a1f3@mail>' );
} );

attack( S, 'an added channel receives exactly the stored row the person approved', async () => {
	const _seen = [];
	const g = routed( { extra: { invite: { send: async ( item ) => {
		_seen.push( item );
		return { ok: true, receipt: { id: 'x' } };
	} } } } );
	const _ok = await g.approved( { ...message( 'invite' ), cohort: people( 12 ) } );
	await g.redeem( _ok );
	assert.equal( _seen.length, 1 );
	assert.equal( _seen[ 0 ].id, _ok.delivery );
	assert.equal( _seen[ 0 ].actionHash, g.approval( _ok.approval ).actionHash );
	assert.deepEqual( _seen[ 0 ].params, { body: 'via invite' } );
} );

attack( S, 'an added channel never sees an action the gate refused', async () => {
	let _calls = 0;
	const g = routed( { extra: { invite: { send: async () => {
		_calls += 1;
		return { ok: true };
	} } } } );
	await g.submit( { ...message( 'invite' ), cohort: [ 'r01', 'r02' ] } );
	await g.submit( { ...message( 'invite' ), cohort: people( 12 ), labels: { body: [ 'confidential' ] } } );
	assert.equal( _calls, 0 );
} );

attack( S, 'a channel added while the gate runs takes over the next actions of its kind', async () => {
	const g = routed();
	await g.send( { ...message( 'invite' ), cohort: people( 12 ) } );
	g.egress.channels.invite = { send: async () => ( { ok: true, receipt: { id: 'new-channel' } } ) };
	const _second = await g.send( { ...message( 'invite' ), cohort: people( 12, 40 ) } );
	assert.equal( g.row( _second.delivery ).receipt.id, 'new-channel' );
	assert.equal( delivered( g, 'invite' ).length, 1 );
} );

attack( S, 'two gates on two ledgers do not share their outboxes', async () => {
	const _a = Channels.create( new Db( ':memory:' ) );
	const _b = Channels.create( new Db( ':memory:' ) );
	await _a.default.send( { id: 'dl-1', action: 'reply', target: 'ceo', params: {} } );
	assert.equal( ( await _b.default.send( { id: 'dl-1', action: 'reply', target: 'ceo', params: {} } ) ).receipt.repeated, undefined );
	assert.equal( _b.outbox.messages( 'ceo' ).length, 1 );
} );

attack( S, 'A2: a channel that fails only after the timeout cannot change the result afterwards', async () => {
	let _late;
	const g = routed( { sendMs: 5, extra: { invite: { send: () => new Promise( ( _resolve, reject ) => {
		_late = () => reject( new Error( 'late failure' ) );
	} ) } } } );
	const _result = await g.send( { ...message( 'invite' ), cohort: people( 12 ) } );
	_late();
	await new Promise( resolve => setTimeout( resolve, 5 ) );
	assert.equal( _result.status, 'unclear' );
	assert.equal( g.row( _result.delivery ).status, 'unclear' );
} );

attack( S, 'the messages a gate delivered are what its outbox shows per recipient', async () => {
	const g = routed();
	await g.send( reply( people( 12 ) ) );
	await settle( g, g.db.get( 'SELECT id FROM deliveries' ).id );
	assert.equal( g.channels.outbox.messages( 'ceo' ).length, 1 );
	assert.deepEqual( g.channels.outbox.messages( 'ceo' )[ 0 ].params, { body: 'Workload is the main reason' } );
} );

attack( S, 'a failure answer that carries a receipt is still a failure', async () => {
	const g = routed( { extra: { invite: { send: async () => ( { ok: false, error: 'rejected', receipt: { id: 'looks-like-proof' } } ) } } } );
	const _result = await g.send( { ...message( 'invite' ), cohort: people( 12 ) } );
	assert.notEqual( _result.status, 'executed' );
} );

attack( S, 'routing is exact: a channel registered as Invite does not take the action invite', async () => {
	let _calls = 0;
	const g = routed( { extra: { Invite: { send: async () => {
		_calls += 1;
		return { ok: true };
	} } } } );
	await g.send( { ...message( 'invite' ), cohort: people( 12 ) } );
	assert.equal( _calls, 0 );
	assert.equal( delivered( g, 'invite' ).length, 1 );
} );
