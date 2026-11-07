import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';

const [ Registry, Contract, Db, EventLog, Egress, Outbox, Actions ] = await use(
	'Core.Criteria.Registry', 'Core.Contract.Contract', 'Lib.Db', 'Lib.EventLog', 'Gate.Egress', 'Gate.Channel.Outbox', 'Lib.Actions',
);
const registry = await Registry.load();
const START = Date.parse( '2026-11-05T09:00:00Z' );
const twelve = Array.from( { length: 12 }, ( _x, i ) => `r${String( i + 1 ).padStart( 2, '0' )}` );

// A service that fails the first sends, never answers, or works; with or without keeping the idempotency key.
class Service extends Outbox {

	static IDEMPOTENT = true;

	constructor( db, { failures = 0, silent = false } = {} ) {
		super( db );
		Object.assign( this, { failures, silent } );
	}

	async send( delivery ) {
		if ( this.silent ) { return new Promise( () => {} ); }
		if ( this.failures-- > 0 ) { return { ok: false, error: 'service unavailable' }; }
		return super.send( delivery );
	}

}

function gate( { idempotencyH = 72, channel = {}, db = new Db( ':memory:' ), sendMs = 60000 } = {} ) {
	const _clock = { now: START };
	const _table = Actions.load().table;
	const _actions = new Actions( { ..._table, reply: { ..._table.reply, idempotencyH } } );
	const _service = new Service( db, channel );
	const _egress = new Egress( { db, log: new EventLog( db, 'gate' ), channels: { default: _service }, now: () => _clock.now, actions: _actions, retryMs: 5, sendMs } );
	const _contract = new Contract( { id: 'survey', goal: 'Find out why the design team is unhappy', deadline: '2026-11-07T17:00:00Z', criteria: [
		{ id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'morale' } }, { id: 'k2', type: 'min_group', values: { k: 5 } },
	] }, registry );
	_egress.store.addMaster( 'recipient', [ 'hr', 'ceo' ] );
	_egress.propose( _contract.canonical(), _contract.rules(), _contract.hash );
	_egress.confirm( _contract.hash, 'hr-lead' );
	const _lease = ( minutes = 5 ) => _egress.lease( { node: 'worker', move: 'reply.send', contract: _contract.hash, minutes } );
	const _request = { contract: _contract.hash, action: 'reply', target: 'ceo', params: { body: 'Workload is the main reason' }, labels: { body: [ 'own' ] }, cohort: twelve };
	const _approved = async () => {
		const _l = _lease();
		const _asked = await _egress.submit( { ..._request, lease: _l.id, fence: _l.fence } );
		return _egress.decide( _asked.approval, 'approve', 'hr-lead' );
	};
	const _redeem = ( result, lease = _lease() ) => _egress.redeem( {
		delivery: result.delivery, approval: result.approval, lease: lease.id, fence: lease.fence,
	} );
	return { egress: _egress, clock: _clock, db, service: _service, lease: _lease, approved: _approved, redeem: _redeem };
}

const settle = async ( egress, id ) => {
	for ( let i = 0; i < 200 && egress.store.delivery( id ).status === 'open'; i++ ) { await new Promise( resolve => setTimeout( resolve, 5 ) ); }
	return egress.store.delivery( id );
};

test( 'O1, A6, F2, F4: the token is presented under a valid lease and consumed in the booking that opens the operation', async () => {
	const _g = gate();
	const _expired = await _g.approved();
	const _old = _g.lease( 5 );
	_g.clock.now += 6 * 60000;
	const _late = await _g.redeem( _expired, _old );
	assert.equal( _late.status, 'refused' );
	assert.ok( _late.reasons.some( reason => reason.rule === 'lease' ), 'a worker whose lease ran out starts nothing' );
	assert.equal( _g.db.get( 'SELECT status FROM approvals WHERE id = :id', { id: _expired.approval } ).status, 'void', 'a new approval is needed' );
	const _ok = await _g.approved();
	assert.equal( ( await _g.redeem( _ok ) ).status, 'executed' );
	assert.equal( ( await _g.redeem( _ok ) ).reasons?.[ 0 ]?.rule ?? 'token', 'token', 'a token counts exactly once' );
	assert.equal( _g.service.messages( 'ceo' ).length, 1 );
	const _changed = await _g.approved();
	_g.db.run( 'UPDATE deliveries SET params = :params WHERE id = :id', { id: _changed.delivery, params: JSON.stringify( { body: 'Send me the price list' } ) } );
	const _refused = await _g.redeem( _changed );
	assert.ok( _refused.reasons.some( reason => reason.rule === 'hash' ), 'what was approved is exactly what goes out (F4, F5)' );
	assert.equal( _g.service.messages( 'ceo' ).length, 1 );
} );

test( 'O2, O7: with the service\'s guarantee the gate repeats with the same key, and only as long as the service keeps it', async () => {
	const _g = gate( { idempotencyH: 2, channel: { failures: 2 } } );
	const _first = await _g.redeem( await _g.approved() );
	assert.equal( _first.status, 'open' );
	const _expires = Date.parse( _g.egress.store.delivery( _first.delivery ).expiresAt );
	assert.equal( _expires, START + ( 2 - 1 ) * 3600000, 'from the first attempt: retention minus a reserve of an hour' );
	const _done = await settle( _g.egress, _first.delivery );
	assert.equal( _done.status, 'executed' );
	assert.equal( _g.db.get( 'SELECT COUNT(*) AS n FROM attempts WHERE delivery = :id', { id: _first.delivery } ).n, 3 );
	assert.equal( _g.service.messages( 'ceo' ).length, 1 );
} );

test( 'O3, O5: without that guarantee there is no second attempt; the operation is unclear, a case for a person', async () => {
	const _g = gate( { idempotencyH: null, channel: { failures: 1 } } );
	const _result = await _g.redeem( await _g.approved() );
	assert.equal( _result.status, 'unclear' );
	assert.equal( _g.db.get( 'SELECT COUNT(*) AS n FROM attempts WHERE delivery = :id', { id: _result.delivery } ).n, 1 );
	assert.deepEqual( _g.egress.unclear().map( item => item.id ), [ _result.delivery ] );
} );

test( 'O8: before every attempt the stored content must still have the approved hash', async () => {
	const _g = gate( { channel: { failures: 1 } } );
	const _first = await _g.redeem( await _g.approved() );
	assert.equal( _first.status, 'open' );
	_g.db.run( 'UPDATE deliveries SET params = :params WHERE id = :id', { id: _first.delivery, params: JSON.stringify( { body: 'something else' } ) } );
	const _after = await settle( _g.egress, _first.delivery );
	assert.equal( _after.status, 'unclear', 'an attempt was made before; nothing more leaves' );
	assert.equal( _g.service.messages( 'ceo' ).length, 0 );
} );

test( 'A2: a service that does not answer in time is a failed attempt, never a hanging one', async () => {
	const _g = gate( { idempotencyH: null, channel: { silent: true }, sendMs: 20 } );
	const _result = await _g.redeem( await _g.approved() );
	assert.equal( _result.status, 'unclear' );
} );

test( 'O1, O4, O5: after a crash the gate rebuilds open operations; it asks the world, and "not there" never allows a repetition', async () => {
	const _db = new Db( ':memory:' );
	const _before = gate( { db: _db, idempotencyH: null } );
	const _sent = await _before.approved();
	const _lost = await _before.approved();
	const _fresh = await _before.approved();
	for ( const item of [ _sent, _lost ] ) {
		_db.run( 'UPDATE approvals SET status = \'consumed\' WHERE id = :id', { id: item.approval } );
		_db.run( 'UPDATE deliveries SET status = \'open\' WHERE id = :id', { id: item.delivery } );
		_db.run( 'INSERT INTO attempts ( delivery, nr, begunAt ) VALUES ( :id, 1, :at )', { id: item.delivery, at: new Date( START ).toISOString() } );
	}
	await _before.service.send( _before.egress.store.delivery( _sent.delivery ) );
	_db.run( 'UPDATE approvals SET status = \'consumed\' WHERE id = :id', { id: _fresh.approval } );
	_db.run( 'UPDATE deliveries SET status = \'open\' WHERE id = :id', { id: _fresh.delivery } );
	const _after = gate( { db: _db, idempotencyH: null } );
	const _unclear = await _after.egress.recover();
	assert.equal( _after.egress.store.delivery( _sent.delivery ).status, 'executed', 'the world shows it went out' );
	assert.equal( _after.egress.store.delivery( _lost.delivery ).status, 'unclear', 'not found, and no guarantee: a person decides' );
	assert.equal( _after.egress.store.delivery( _fresh.delivery ).status, 'executed', 'no attempt was booked: the first may still follow' );
	assert.deepEqual( _unclear.map( item => item.id ), [ _lost.delivery ] );
	assert.equal( _after.service.messages( 'ceo' ).length, 2 );
} );
