// Stress tests of core/inbound/expectations.js: the life of an expectation (8.2), its deadline (R3), facts of the same
// origin (B1, E5), late facts (E4, B8) and what a closed node still takes (Z5).
import assert from 'node:assert/strict';
import { attack, attacks, hostile, random } from '../hostile.mjs';
import { Expectations, memoryDb, fakeNode, tryIt, T0, HOUR } from './rig.mjs';

const S = 'core/inbound/expectations.js';

// A store on a clock: a fixed one the test moves, or the real one for waiting.
function store( { start = T0, real = false } = {} ) {
	const _clock = { now: start };
	const _db = memoryDb();
	const _ex = new Expectations( _db, { now: real ? () => Date.now() : () => _clock.now } );
	return { db: _db, clock: _clock, ex: _ex, facts: () => _db.all( 'SELECT * FROM expectation_facts ORDER BY id' ) };
}
const nodeUntil = ( deadline = T0 + 24 * HOUR, id = 'node-x' ) => fakeNode( id, { deadline: new Date( deadline ).toISOString() } );
function open( ex, node, spec = {} ) {
	const _made = ex.create( node, { from: 'design', fact: 'survey_response', keys: [ 'FU-AAAAAA' ], ...spec } );
	ex.activate( _made.id );
	return ex.get( _made.id );
}
const rows = db => db.get( 'SELECT COUNT(*) AS n FROM expectations' ).n;

attack( S, 'create: pending, need 1 and an hour by default, the spec and keys stored as given', () => {
	const { ex } = store();
	const _spec = { extract: { a: { type: 'integer' } }, parser: { a: 'a(\\d)' }, store: { rows: [] }, attempt: 7, carry: [ 'a' ], validHours: 2 };
	const _made = ex.create( nodeUntil(), { from: 'design', fact: 'survey_response', keys: [ 'FU-1A2B3C' ], ..._spec } );
	assert.equal( _made.status, 'pending' );
	assert.equal( _made.need, 1 );
	assert.equal( Date.parse( _made.until ), T0 + HOUR );
	assert.deepEqual( _made.keys, [ 'FU-1A2B3C' ] );
	// about and each are stored too, null when not given (use cases: a series of answers from one sender).
	assert.deepEqual( _made.spec, { ..._spec, about: null, each: null } );
	assert.equal( _made.createdAt, new Date( T0 ).toISOString() );
} );

attack( S, 'create: the node hears expectation_created with exactly the stored keys and deadline', () => {
	const { ex } = store();
	const _node = nodeUntil();
	const _made = ex.create( _node, { from: 'design', fact: 'f', keys: [ 'K-1', 'K-2' ], need: 2 } );
	assert.deepEqual( _node.of( 'expectation_created' ), [ { id: _made.id, from: 'design', fact: 'f', need: 2, until: _made.until, keys: [ 'K-1', 'K-2' ] } ] );
} );

attack( S, 'R3: an expectation never runs past its node, however many minutes it asks for', () => {
	const { ex } = store();
	const _made = ex.create( nodeUntil( T0 + 2 * HOUR ), { from: 'a', fact: 'f', minutes: 1e9 } );
	assert.equal( Date.parse( _made.until ), T0 + 2 * HOUR );
} );

attacks( S, [
	{ name: 'create: minutes NaN is refused and leaves no row', spec: { minutes: NaN } },
	{ name: 'create: minutes as text is refused and leaves no row', spec: { minutes: 'soon' } },
	{ name: 'create: need NaN is refused and leaves no row', spec: { need: NaN } },
], ( { spec } ) => {
	const { ex, db } = store();
	assert.throws( () => ex.create( nodeUntil(), { from: 'a', fact: 'f', ...spec } ) );
	assert.equal( rows( db ), 0 );
} );

attacks( S, hostile( 'dates' ).map( item => ( { ...item, name: `create: node deadline ${item.label} never yields an expectation past it` } ) ), ( { value } ) => {
	const { ex, db } = store();
	const _made = tryIt( () => ex.create( fakeNode( 'node-d', { deadline: value } ), { from: 'a', fact: 'f', minutes: 1e6 } ) );
	if ( _made.error ) {
		assert.equal( rows( db ), 0, 'a refused expectation leaves no row' );
		return;
	}
	assert.ok( !Number.isNaN( Date.parse( _made.value.until ) ) );
	assert.ok( Date.parse( _made.value.until ) <= Date.parse( value ), 'never after the node\'s deadline (R3)' );
} );

attack( S, 'create: hostile senders, kinds and keys are stored verbatim through bound parameters', () => {
	const { ex, db } = store();
	const _values = hostile( 'strings' ).map( item => item.value );
	const _ids = _values.map( value => ex.create( nodeUntil(), { from: value, fact: value, keys: [ value, 'K' ] } ).id );
	assert.equal( rows( db ), _values.length, 'no value broke out of its parameter' );
	_ids.forEach( ( id, i ) => {
		const _got = ex.get( id );
		assert.deepEqual( [ _got.origin, _got.fact, _got.keys[ 0 ] ], [ _values[ i ], _values[ i ], _values[ i ] ] );
	} );
} );

attack( S, 'create: an empty key would match every message; it is refused or never matches', () => {
	const { ex } = store();
	if ( tryIt( () => ex.create( nodeUntil(), { from: 'a', fact: 'f', keys: [ '' ] } ) ).error ) { return; }
	ex.closeFor( 'node-x' );
	assert.equal( ex.closedByKey( 'a message about something else entirely' ), null, 'an empty key must not match every text' );
} );

attack( S, 'create: keys that are not a list are refused, so no later match can throw', () => {
	const { ex } = store();
	const _made = tryIt( () => ex.create( nodeUntil(), { from: 'a', fact: 'f', keys: 'FU-123456' } ) );
	assert.ok( _made.error || Array.isArray( _made.value.keys ), 'a string as keys breaks item.keys.some() for every later message' );
} );

attack( S, 'activate: pending becomes open; activating again changes nothing', () => {
	const { ex } = store();
	const _made = ex.create( nodeUntil(), { from: 'a', fact: 'f' } );
	ex.activate( _made.id );
	ex.activate( _made.id );
	assert.equal( ex.get( _made.id ).status, 'open' );
} );

attacks( S, [ 'dropped', 'closed', 'met', 'timed_out' ].map( status => ( { name: `activate: never reopens an expectation that is ${status}`, status } ) ), ( { status } ) => {
	const { ex, db } = store();
	const _made = ex.create( nodeUntil(), { from: 'a', fact: 'f' } );
	db.run( 'UPDATE expectations SET status = :status WHERE id = :id', { id: _made.id, status } );
	ex.activate( _made.id );
	assert.equal( ex.get( _made.id ).status, status );
} );

attack( S, 'drop: a pending expectation is dropped; an open one stays open (the action has left)', () => {
	const { ex } = store();
	const _pending = ex.create( nodeUntil(), { from: 'a', fact: 'f' } );
	const _open = open( ex, nodeUntil() );
	ex.drop( _pending.id );
	ex.drop( _open.id );
	assert.deepEqual( [ ex.get( _pending.id ).status, ex.get( _open.id ).status ], [ 'dropped', 'open' ] );
} );

attack( S, 'listening: neither pending (nothing left yet) nor dropped nor closed expectations take messages', () => {
	const { ex } = store();
	const _node = nodeUntil();
	const _pending = ex.create( _node, { from: 'a', fact: 'f' } );
	const _dropped = ex.create( _node, { from: 'a', fact: 'f' } );
	ex.drop( _dropped.id );
	const _closed = open( ex, nodeUntil( T0 + HOUR, 'node-c' ) );
	ex.closeFor( 'node-c' );
	const _open = open( ex, _node );
	const _ids = ex.listening().map( item => item.id );
	assert.deepEqual( _ids, [ _open.id ] );
	assert.ok( ![ _pending.id, _dropped.id, _closed.id ].some( id => _ids.includes( id ) ) );
} );

attack( S, 'listening: a timed-out expectation still takes a late answer while its node lives (E4, 8.2)', () => {
	const { ex, db } = store();
	const _made = open( ex, nodeUntil() );
	db.run( 'UPDATE expectations SET status = \'timed_out\' WHERE id = :id', { id: _made.id } );
	assert.deepEqual( ex.listening().map( item => item.id ), [ _made.id ] );
} );

attack( S, 'closeFor: closes pending, open and timed-out expectations of that node only', () => {
	const { ex, db } = store();
	const _a = nodeUntil( T0 + HOUR, 'node-a' );
	const _pending = ex.create( _a, { from: 'a', fact: 'f' } );
	const _open = open( ex, _a );
	const _late = open( ex, _a );
	db.run( 'UPDATE expectations SET status = \'timed_out\' WHERE id = :id', { id: _late.id } );
	const _other = open( ex, nodeUntil( T0 + HOUR, 'node-b' ) );
	ex.closeFor( 'node-a' );
	assert.deepEqual( [ _pending, _open, _late ].map( item => ex.get( item.id ).status ), [ 'closed', 'closed', 'closed' ] );
	assert.equal( ex.get( _other.id ).status, 'open' );
} );

attack( S, 'Z5: once its node closed, a met expectation takes nothing more either', () => {
	const { ex } = store();
	const _made = open( ex, nodeUntil() );
	ex.record( _made.id, { origin: 'o1', fact: 'survey_response' } );
	assert.equal( ex.get( _made.id ).status, 'met' );
	ex.closeFor( 'node-x' );
	assert.equal( ex.listening().filter( item => item.node === 'node-x' ).length, 0, 'a closed node listens for nothing (Z5)' );
} );

attack( S, 'closedByKey: finds a closed expectation by a key in the text, never an open one', () => {
	const { ex } = store();
	const _closed = open( ex, nodeUntil( T0 + HOUR, 'node-c' ), { keys: [ 'FU-C10SED' ] } );
	open( ex, nodeUntil( T0 + HOUR, 'node-o' ), { keys: [ 'FU-0PEN00' ] } );
	ex.closeFor( 'node-c' );
	assert.equal( ex.closedByKey( 'Re: FU-C10SED here are my numbers' ).id, _closed.id );
	assert.equal( ex.closedByKey( 'Re: FU-0PEN00 here are my numbers' ), null );
	assert.equal( ex.closedByKey( 'no key at all' ), null );
} );

attack( S, 'get: an unknown or hostile id is null, never an error', () => {
	const { ex } = store();
	for ( const { value } of hostile( 'strings', 'keys' ) ) {
		assert.equal( ex.get( value ), null );
	}
} );

attack( S, 'latest: the newest open expectation of the node, even when two are made in the same millisecond', () => {
	const { ex } = store();
	const _node = nodeUntil();
	open( ex, _node, { keys: [ 'K-FIRST' ] } );
	const _second = open( ex, _node, { keys: [ 'K-SECOND' ] } );
	assert.equal( ex.latest( 'node-x' ).id, _second.id );
} );

attack( S, 'latest: ignores pending, dropped and closed expectations and other nodes', () => {
	const { ex, clock } = store();
	const _node = nodeUntil();
	const _open = open( ex, _node );
	clock.now += 1000;
	ex.create( _node, { from: 'a', fact: 'f' } );
	clock.now += 1000;
	const _dropped = ex.create( _node, { from: 'a', fact: 'f' } );
	ex.drop( _dropped.id );
	clock.now += 1000;
	open( ex, nodeUntil( T0 + HOUR, 'node-other' ) );
	assert.equal( ex.latest( 'node-x' ).id, _open.id );
	assert.equal( ex.latest( 'node-none' ), null );
} );

attack( S, 'record: the first fact meets a need of one; the answer reports count and need', () => {
	const { ex } = store();
	const _made = open( ex, nodeUntil() );
	assert.deepEqual( ex.record( _made.id, { origin: 'o1', fact: 'survey_response' } ), { late: false, superseded: false, count: 1, need: 1 } );
	assert.equal( ex.get( _made.id ).status, 'met' );
} );

attack( S, 'B1/E5: the same origin answering twice counts once; the older fact is marked superseded', () => {
	const { ex, facts } = store();
	const _made = open( ex, nodeUntil(), { need: 2 } );
	ex.record( _made.id, { origin: 'o1', fact: 'survey_response' } );
	const _again = ex.record( _made.id, { origin: 'o1', fact: 'survey_response' } );
	assert.deepEqual( [ _again.superseded, _again.count ], [ true, 1 ] );
	assert.deepEqual( facts().map( row => row.superseded ), [ 1, 0 ] );
	assert.equal( ex.get( _made.id ).status, 'open', 'one origin twice never meets a need of two' );
} );

attack( S, 'record: different origins add up until the need is met', () => {
	const { ex } = store();
	const _made = open( ex, nodeUntil(), { need: 3 } );
	const _counts = [ 'o1', 'o2', 'o3' ].map( origin => ex.record( _made.id, { origin, fact: 'f' } ).count );
	assert.deepEqual( _counts, [ 1, 2, 3 ] );
	assert.equal( ex.get( _made.id ).status, 'met' );
} );

attack( S, 'record: an origin superseded in one expectation still counts in another', () => {
	const { ex } = store();
	const _a = open( ex, nodeUntil() );
	const _b = open( ex, nodeUntil() );
	ex.record( _a.id, { origin: 'o1', fact: 'f' } );
	assert.equal( ex.record( _b.id, { origin: 'o1', fact: 'f' } ).superseded, false );
	assert.deepEqual( [ ex.count( _a.id ), ex.count( _b.id ) ], [ 1, 1 ] );
} );

attack( S, 'record: a fact for a pending expectation (the action never left) does not meet it', () => {
	const { ex } = store();
	const _made = ex.create( nodeUntil(), { from: 'a', fact: 'f' } );
	ex.record( _made.id, { origin: 'o1', fact: 'f' } );
	assert.equal( ex.get( _made.id ).status, 'pending' );
} );

attack( S, 'record: exactly at the deadline a fact is in time, one millisecond later it is late', () => {
	const { ex, clock } = store();
	const _made = open( ex, nodeUntil(), { need: 5 } );
	clock.now = Date.parse( _made.until );
	assert.equal( ex.record( _made.id, { origin: 'o1', fact: 'f' } ).late, false );
	clock.now += 1;
	assert.equal( ex.record( _made.id, { origin: 'o2', fact: 'f' } ).late, true );
} );

attacks( S, [ 'closed', 'dropped' ].map( status => ( { name: `Z5: a fact for an expectation that is ${status} is refused`, status } ) ), ( { status } ) => {
	const { ex, db, facts } = store();
	const _made = open( ex, nodeUntil() );
	db.run( 'UPDATE expectations SET status = :status WHERE id = :id', { id: _made.id, status } );
	const _taken = tryIt( () => ex.record( _made.id, { origin: 'o1', fact: 'f' } ) );
	assert.equal( Boolean( _taken.value ) || facts().length > 0, false, 'nothing is recorded for it' );
} );

attack( S, 'record: an unknown expectation leaves no orphan fact behind', () => {
	const { ex, facts } = store();
	assert.throws( () => ex.record( 'ex-unknown', { origin: 'o1', fact: 'f' } ) );
	assert.equal( facts().length, 0 );
} );

attack( S, 'record: hostile origins and fact names are stored verbatim and counted apart', () => {
	const { ex, facts } = store();
	const _values = hostile( 'strings' ).map( item => item.value );
	const _made = open( ex, nodeUntil(), { need: 1000 } );
	_values.forEach( value => ex.record( _made.id, { origin: value, fact: value } ) );
	assert.equal( ex.count( _made.id ), new Set( _values ).size );
	assert.deepEqual( facts().map( row => row.origin ), _values );
} );

attack( S, 'L2: a fact is a signal of the attempt that created the expectation', () => {
	const { ex } = store();
	const _heard = [];
	ex.on( 'fact', event => _heard.push( event ) );
	const _made = open( ex, nodeUntil(), { attempt: 42 } );
	const _plain = open( ex, nodeUntil() );
	ex.record( _made.id, { origin: 'o1', fact: 'f' } );
	ex.record( _plain.id, { origin: 'o1', fact: 'f' } );
	assert.deepEqual( _heard, [ { id: _made.id, attempt: 42 }, { id: _plain.id, attempt: null } ] );
} );

attack( S, 'on: a listener that throws does not stop the fact from being recorded; off() stops the signal', () => {
	const { ex } = store();
	const _fail = globalThis.agencyApp.fail;
	globalThis.agencyApp.fail = () => {};
	try {
		ex.on( 'fact', () => { throw new Error( 'listener broke' ); } );
		const _heard = [];
		const _off = ex.on( 'fact', event => _heard.push( event.id ) );
		const _made = open( ex, nodeUntil() );
		assert.equal( ex.record( _made.id, { origin: 'o1', fact: 'f' } ).count, 1 );
		_off();
		ex.record( _made.id, { origin: 'o2', fact: 'f' } );
		assert.deepEqual( _heard, [ _made.id ] );
	} finally {
		globalThis.agencyApp.fail = _fail;
	}
} );

attack( S, 'restart: a second store on the same database sees every expectation and its facts', () => {
	const { ex, db } = store();
	const _made = open( ex, nodeUntil(), { need: 2 } );
	ex.record( _made.id, { origin: 'o1', fact: 'f' } );
	const _again = new Expectations( db, { now: () => T0 } );
	assert.equal( _again.get( _made.id ).status, 'open' );
	assert.equal( _again.count( _made.id ), 1 );
	assert.deepEqual( _again.record( _made.id, { origin: 'o2', fact: 'f' } ).count, 2 );
	assert.equal( _again.get( _made.id ).status, 'met' );
} );

attack( S, 'restart: building the tables again keeps what is there', () => {
	const { ex, db } = store();
	open( ex, nodeUntil() );
	new Expectations( db );
	new Expectations( db );
	assert.equal( rows( db ), 1 );
} );

attack( S, 'listening: in the order the expectations were made', () => {
	const { ex, clock } = store();
	const _ids = [];
	for ( let i = 0; i < 5; i++ ) {
		clock.now = T0 + ( 5 - i ) * 1000;
		_ids.push( open( ex, nodeUntil( T0 + 10 * HOUR ) ).id );
	}
	assert.deepEqual( ex.listening().map( item => item.id ), [ ..._ids ].reverse() );
} );

attack( S, 'count: superseded facts never count, however often an origin repeats itself', () => {
	const { ex } = store();
	const _made = open( ex, nodeUntil(), { need: 100 } );
	for ( let i = 0; i < 50; i++ ) {
		ex.record( _made.id, { origin: `o${i % 3}`, fact: 'f' } );
	}
	assert.equal( ex.count( _made.id ), 3 );
} );

attack( S, 'fuzz: under any order of calls, counts match the distinct origins and closed stays closed', () => {
	const _rnd = random( 7 );
	const { ex } = store();
	const _origins = new Map();
	const _closed = new Set();
	const _made = [];
	for ( let step = 0; step < 400; step++ ) {
		const _op = _rnd.int( 0, 4 );
		if ( _op === 0 || !_made.length ) {
			_made.push( open( ex, nodeUntil( T0 + 10 * HOUR, `node-${_rnd.int( 0, 3 )}` ), { need: _rnd.int( 1, 4 ) } ) );
			continue;
		}
		const _pick = _rnd.pick( _made );
		if ( _op === 1 && !_closed.has( _pick.id ) ) {
			const _origin = `o${_rnd.int( 0, 5 )}`;
			ex.record( _pick.id, { origin: _origin, fact: 'f' } );
			_origins.set( _pick.id, new Set( [ ...( _origins.get( _pick.id ) || [] ), _origin ] ) );
		}
		if ( _op === 2 ) {
			_made.filter( item => item.node === _pick.node && ex.get( item.id ).status === 'open' ).forEach( item => _closed.add( item.id ) );
			ex.closeFor( _pick.node );
		}
	}
	for ( const item of _made ) {
		const _now = ex.get( item.id );
		assert.equal( ex.count( item.id ), _origins.get( item.id )?.size ?? 0 );
		assert.ok( [ 'open', 'met', 'closed' ].includes( _now.status ) );
		assert.ok( !_closed.has( item.id ) || _now.status === 'closed', `${item.id} was closed and is ${_now.status} again` );
	}
} );
