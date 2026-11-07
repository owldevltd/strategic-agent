// Attacks on leases and fencing tokens (A1, A4, A6, A7, A8): stale and forged fences, expiry at the exact instant,
// heartbeats beyond the maximum, leases without an end, races of many grants, and a reopened ledger.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attack, attacks, hostile, random } from '../hostile.mjs';
import { Db, Leases, gate, invoiceSpec, Contract, registry, START, MINUTE } from './fixture.mjs';

const S = 'gate/leases.js';

function leases( options = {} ) {
	const _clock = { now: START };
	const _db = options.db || new Db( ':memory:' );
	return { clock: _clock, db: _db, leases: new Leases( _db, { now: () => _clock.now, ...options } ) };
}

const active = ( db, node ) => db.all( 'SELECT * FROM leases WHERE node = :node AND status = \'active\'', { node } );

attack( S, 'A6: every new lease of a node gets the next fencing token and supersedes the one before', () => {
	const { leases: l, db } = leases();
	const _a = l.grant( { node: 'n1', move: 'm', minutes: 5 } );
	const _b = l.grant( { node: 'n1', move: 'm', minutes: 5 } );
	assert.deepEqual( [ _a.fence, _b.fence ], [ 1, 2 ] );
	assert.equal( l.valid( _a.id, _a.fence ), null );
	assert.equal( l.valid( _b.id, _b.fence ).id, _b.id );
	assert.equal( active( db, 'n1' ).length, 1 );
} );

attack( S, 'A6: fencing tokens count per node; a lease of another node is not superseded', () => {
	const { leases: l } = leases();
	l.grant( { node: 'n1', move: 'm' } );
	l.grant( { node: 'n1', move: 'm' } );
	const _other = l.grant( { node: 'n2', move: 'm' } );
	assert.equal( _other.fence, 1 );
	l.grant( { node: 'n1', move: 'm' } );
	assert.ok( l.valid( _other.id, 1 ) );
} );

attack( S, 'A6: the token of the current lease with the fence of the old one is refused', () => {
	const { leases: l } = leases();
	const _a = l.grant( { node: 'n1', move: 'm' } );
	const _b = l.grant( { node: 'n1', move: 'm' } );
	assert.equal( l.valid( _b.id, _a.fence ), null );
	assert.equal( l.valid( _a.id, _b.fence ), null );
} );

attacks( S, [ ...hostile( 'numbers' ), ...hostile( 'types' ).filter( item => typeof item.value !== 'symbol' ) ]
	.map( ( { label, value } ) => ( { name: `A6: the fence ${label} is not the fence 2`, value } ) ),
( { value } ) => {
	const { leases: l } = leases();
	l.grant( { node: 'n1', move: 'm' } );
	const _current = l.grant( { node: 'n1', move: 'm' } );
	assert.equal( l.valid( _current.id, value ), null );
} );

attack( S, 'A6: a fence given as a symbol is refused, not a crash', () => {
	const { leases: l } = leases();
	const _lease = l.grant( { node: 'n1', move: 'm' } );
	assert.equal( l.valid( _lease.id, Symbol( 'fence' ) ), null );
} );

attacks( S, [ null, undefined, '', 0, false ].map( id => ( { name: `A8: the lease id ${JSON.stringify( id ) ?? 'undefined'} is no lease`, id } ) ), ( { id } ) => {
	const { leases: l } = leases();
	l.grant( { node: 'n1', move: 'm' } );
	assert.equal( l.valid( id, 1 ), null );
} );

attack( S, 'A8: a lease id given as an object is refused, not a crash', () => {
	const { leases: l } = leases();
	const _lease = l.grant( { node: 'n1', move: 'm' } );
	assert.equal( l.valid( { id: _lease.id }, 1 ), null );
} );

attacks( S, [
	{ name: 'A4: a lease is valid one millisecond before it expires', offset: -1, valid: true },
	{ name: 'A4: a lease is invalid one millisecond after it expired', offset: 1, valid: false },
], ( { offset, valid } ) => {
	const { leases: l, clock } = leases();
	const _lease = l.grant( { node: 'n1', move: 'm', minutes: 2 } );
	clock.now = Date.parse( _lease.expiresAt ) + offset;
	assert.equal( Boolean( l.valid( _lease.id, _lease.fence ) ), valid );
} );

attack( S, 'A1: a heartbeat moves the end forward by the beat length, never past the maximum', () => {
	const { leases: l, clock } = leases();
	const _lease = l.grant( { node: 'n1', move: 'm', minutes: 10, beatMinutes: 2 } );
	assert.equal( Date.parse( _lease.expiresAt ), START + 2 * MINUTE );
	for ( let i = 1; i <= 20; i++ ) {
		clock.now = START + i * MINUTE;
		const _beat = l.beat( _lease.id, _lease.fence );
		if ( !_beat.ok ) { break; }
		assert.ok( Date.parse( _beat.expiresAt ) <= Date.parse( _lease.maxUntil ) );
	}
	clock.now = Date.parse( _lease.maxUntil ) + 1;
	assert.equal( l.valid( _lease.id, _lease.fence ), null );
} );

attacks( S, [
	{ name: 'A4: a heartbeat with a stale fence changes nothing', act: ( l, a ) => l.grant( { node: a.node, move: 'm' } ) && l.beat( a.id, a.fence ) },
	{ name: 'A4: a heartbeat after the lease expired cannot revive it', act: ( l, a, clock ) => {
		clock.now = Date.parse( a.expiresAt ) + 1;
		return l.beat( a.id, a.fence );
	} },
	{ name: 'A4: a heartbeat after the release cannot revive it', act: ( l, a ) => l.release( a.id, a.fence ).ok && l.beat( a.id, a.fence ) },
	{ name: 'A4: a heartbeat with the right fence on an unknown id does nothing', act: l => l.beat( 'ls-unknown', 1 ) },
], ( { act } ) => {
	const { leases: l, clock, db } = leases();
	const _lease = { ...l.grant( { node: 'n1', move: 'm', minutes: 5, beatMinutes: 1 } ), node: 'n1' };
	const _before = db.get( 'SELECT expiresAt FROM leases WHERE id = :id', { id: _lease.id } ).expiresAt;
	assert.equal( act( l, _lease, clock ).ok, false );
	assert.equal( db.get( 'SELECT expiresAt FROM leases WHERE id = :id', { id: _lease.id } ).expiresAt, _before );
} );

attack( S, 'A4: a stale worker\'s heartbeat does not extend the lease of its successor', () => {
	const { leases: l, clock, db } = leases();
	const _old = l.grant( { node: 'n1', move: 'm', minutes: 5, beatMinutes: 1 } );
	const _new = l.grant( { node: 'n1', move: 'm', minutes: 5, beatMinutes: 1 } );
	clock.now += 30000;
	l.beat( _old.id, _old.fence );
	l.beat( _new.id, _old.fence );
	assert.equal( db.get( 'SELECT expiresAt FROM leases WHERE id = :id', { id: _new.id } ).expiresAt, _new.expiresAt );
} );

attack( S, 'A4: a release by a holder that does not know the fencing token is refused', () => {
	const { leases: l } = leases();
	const _lease = l.grant( { node: 'n1', move: 'm' } );
	l.release( _lease.id, 99 );
	assert.ok( l.valid( _lease.id, _lease.fence ), 'every write carries the fencing token of the lease (A4)' );
} );

attack( S, 'release: releasing twice, an unknown id or a superseded lease leaves the current lease alone', () => {
	const { leases: l } = leases();
	const _old = l.grant( { node: 'n1', move: 'm' } );
	const _current = l.grant( { node: 'n1', move: 'm' } );
	l.release( _old.id, _old.fence );
	l.release( _old.id, _old.fence );
	l.release( 'ls-nope', 1 );
	assert.ok( l.valid( _current.id, _current.fence ) );
} );

attack( S, 'release: a lease granted after a release gets a new fence, never the released one again', () => {
	const { leases: l } = leases();
	const _a = l.grant( { node: 'n1', move: 'm' } );
	assert.deepEqual( l.release( _a.id, _a.fence ), { ok: true } );
	assert.equal( l.grant( { node: 'n1', move: 'm' } ).fence, 2 );
	assert.equal( l.valid( _a.id, _a.fence ), null );
} );

attacks( S, [
	{ name: 'A7: a lease never ends after its limit, however many minutes are asked for', minutes: 60 * 24 * 365, limit: START + 30 * MINUTE, end: START + 30 * MINUTE },
	{ name: 'A7: a limit already in the past gives a lease that is born expired', minutes: 5, limit: START - 1, end: START - 1 },
	{ name: 'A7: a limit at this very instant gives a lease that ends now', minutes: 5, limit: START, end: START },
	{ name: 'A7: a short lease ends before its limit', minutes: 2, limit: START + 30 * MINUTE, end: START + 2 * MINUTE },
], ( { minutes, limit, end } ) => {
	const { leases: l, clock } = leases();
	const _lease = l.grant( { node: 'n1', move: 'm', minutes, limit: new Date( limit ).toISOString() } );
	assert.equal( Date.parse( _lease.maxUntil ), end );
	clock.now = end + 1;
	assert.equal( l.valid( _lease.id, _lease.fence ), null );
} );

attack( S, 'A7: a lease without any limit still has an end no later than a bounded default', () => {
	const { leases: l } = leases();
	const _lease = l.grant( { node: 'n1', move: 'm', minutes: 60 * 24 * 365 * 100 } );
	assert.ok( Date.parse( _lease.maxUntil ) - START <= 24 * 60 * MINUTE, `the lease runs until ${_lease.maxUntil}` );
} );

attacks( S, [
	{ name: 'A8: minutes that are not a number give a clean refusal', request: { minutes: 'five' } },
	{ name: 'A8: minutes so large that the date overflows give a clean refusal', request: { minutes: 1e308 } },
	{ name: 'A8: an unparsable limit gives a clean refusal', request: { minutes: 5, limit: 'end of time' } },
	{ name: 'A8: a lease without a node gives a clean refusal', request: { node: undefined } },
], ( { request } ) => {
	const { leases: l, db } = leases();
	let _result;
	assert.doesNotThrow( () => {
		_result = l.grant( { node: 'n1', move: 'm', ...request } );
	} );
	assert.ok( !_result || !l.valid( _result.id, _result.fence ) || Number.isFinite( Date.parse( _result.maxUntil ) ) );
	assert.ok( db.get( 'SELECT COUNT(*) AS n FROM leases' ).n <= 1 );
} );

attack( S, 'A6: negative minutes give a lease that is invalid from the start', () => {
	const { leases: l } = leases();
	const _lease = l.grant( { node: 'n1', move: 'm', minutes: -5 } );
	assert.equal( l.valid( _lease.id, _lease.fence ), null );
} );

attack( S, 'A6: fifty grants for one node at the same moment give fifty distinct fences and one active lease', async () => {
	const { leases: l, db } = leases();
	const _all = await Promise.all( Array.from( { length: 50 }, async () => l.grant( { node: 'n1', move: 'm' } ) ) );
	assert.equal( new Set( _all.map( item => item.fence ) ).size, 50 );
	assert.equal( active( db, 'n1' ).length, 1 );
	assert.equal( _all.filter( item => l.valid( item.id, item.fence ) ).length, 1 );
} );

attacks( S, [ 5, 99, 2024 ].map( seed => ( { name: `A6 fuzz (seed ${seed}): at most one valid lease per node, always the newest`, seed } ) ), ( { seed } ) => {
	const _random = random( seed );
	const { leases: l, clock } = leases();
	const _granted = [];
	for ( let i = 0; i < 300; i++ ) {
		const _node = `n${_random.int( 1, 4 )}`;
		const _step = _random();
		if ( _step < 0.4 ) {
			_granted.push( { ...l.grant( { node: _node, move: 'm', minutes: _random.int( 1, 5 ), beatMinutes: 1 } ), node: _node } );
		} else if ( _step < 0.6 && _granted.length ) {
			const _pick = _random.pick( _granted );
			l.release( _pick.id, _pick.fence );
		} else if ( _step < 0.85 && _granted.length ) {
			const _pick = _random.pick( _granted );
			l.beat( _pick.id, _random() < 0.8 ? _pick.fence : _pick.fence + 1 );
		} else {
			clock.now += _random.int( 0, 90 ) * 1000;
		}
		for ( const node of [ 'n1', 'n2', 'n3', 'n4' ] ) {
			const _valid = _granted.filter( item => item.node === node && l.valid( item.id, item.fence ) );
			const _newest = Math.max( 0, ..._granted.filter( item => item.node === node ).map( item => item.fence ) );
			assert.ok( _valid.length <= 1 );
			assert.ok( _valid.every( item => item.fence === _newest ) );
		}
	}
} );

attack( S, 'A6: fencing tokens continue after the ledger is reopened; no token is handed out twice', () => {
	const _dir = fs.mkdtempSync( path.join( os.tmpdir(), 'gate-leases-' ) );
	try {
		const _file = path.join( _dir, 'gate.db' );
		const _first = new Db( _file );
		const _old = new Leases( _first, { now: () => START } ).grant( { node: 'n1', move: 'm' } );
		_first.close();
		const _second = new Db( _file );
		const _reopened = new Leases( _second, { now: () => START } );
		const _new = _reopened.grant( { node: 'n1', move: 'm' } );
		assert.equal( _new.fence, _old.fence + 1 );
		assert.equal( _reopened.valid( _old.id, _old.fence ), null );
		_second.close();
	} finally {
		fs.rmSync( _dir, { recursive: true, force: true } );
	}
} );

attack( S, 'lease ids do not repeat over a thousand grants', () => {
	const { leases: l } = leases();
	const _ids = new Set( Array.from( { length: 1000 }, ( _x, i ) => l.grant( { node: `n${i % 7}`, move: 'm' } ).id ) );
	assert.equal( _ids.size, 1000 );
} );

attacks( S, hostile( 'strings' ).filter( ( _item, i ) => i % 3 === 0 ).map( ( { label, value } ) => ( { name: `node names are data: the node ${label} gets its own fences`, value } ) ),
	( { value } ) => {
		const { leases: l, db } = leases();
		l.grant( { node: 'other', move: 'm' } );
		const _a = l.grant( { node: value, move: value } );
		const _b = l.grant( { node: value, move: value } );
		assert.equal( _b.fence, _a.fence + 1 );
		assert.ok( l.valid( _b.id, _b.fence ) );
		assert.equal( active( db, 'other' ).length, 1 );
	} );

attack( S, 'A7 at the gate: a lease for a child goal ends at the root deadline plus buffer', () => {
	const g = gate( { spec: invoiceSpec() } );
	const _child = new Contract( { ...invoiceSpec(), id: 'child', parent: g.hash, deadline: '2026-11-06T12:00:00Z' }, registry );
	g.egress.propose( _child.canonical(), _child.rules(), _child.hash );
	const _lease = g.egress.lease( { node: 'n1', move: 'm', contract: _child.hash, minutes: 60 * 24 * 30 } );
	assert.equal( _lease.maxUntil, '2026-11-07T17:05:00.000Z' );
} );

// A lease is granted only for a goal the gate knows: without one there is no deadline to end it by (A6, A7).
attacks( S, [
	{ name: 'A7 at the gate: a lease naming an unknown contract is refused', contract: 'f'.repeat( 64 ) },
	{ name: 'A7 at the gate: a lease naming no contract is refused', contract: undefined },
	{ name: 'A7 at the gate: a lease naming a contract by an object is refused', contract: { hash: 'x' } },
], ( { contract } ) => {
	const g = gate();
	assert.throws( () => g.egress.lease( { node: 'n1', move: 'm', contract, minutes: 60 * 24 * 365 } ), /goal the gate knows/ );
	assert.equal( g.db.get( 'SELECT COUNT(*) AS n FROM leases' ).n, 0 );
} );

attack( S, 'A6 at the gate: a lease without a node is refused, even for a known goal', () => {
	const g = gate();
	assert.throws( () => g.egress.lease( { move: 'm', contract: g.hash, minutes: 5 } ), /named node/ );
} );
