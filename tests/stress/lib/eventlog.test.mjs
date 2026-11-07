// lib/eventlog.js under attack: the append-only log the state is derived from (Z4, chapter 18). What a live
// subscriber (SSE) sees must be what a replay sees: the same events, the same ids, the same order, the same data.
import assert from 'node:assert/strict';
import path from 'node:path';
import { attack, random } from '../hostile.mjs';
import { agency, tempDir, quiet, tree } from './tools.mjs';

const [ Db, EventLog ] = await agency.use( [ 'Lib.Db', 'Lib.EventLog' ] );
const S = 'lib/eventlog.js';

const fresh = ( source = 'test' ) => new EventLog( new Db( ':memory:' ), source );
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const replayOf = ( log, id ) => log.since( id - 1, 1 )[ 0 ];

attack( S, 'append returns the event with id, source, kind, node, version, data and an ISO time', () => {
	const _log = fresh( 'core' );
	const _event = _log.append( 'plan_accepted', { a: 1 }, { node: 'n1', nodeVersion: 3 } );
	assert.equal( typeof _event.id, 'number' );
	assert.deepEqual( { ..._event, id: 0, time: '' }, { id: 0, source: 'core', kind: 'plan_accepted', node: 'n1', nodeVersion: 3, data: { a: 1 }, time: '' } );
	assert.match( _event.time, ISO );
} );

attack( S, 'ids rise strictly with every append (1000 events)', () => {
	const _log = fresh();
	const _ids = Array.from( { length: 1000 }, ( _, i ) => _log.append( 'k', { i } ).id );
	assert.ok( _ids.every( ( id, i ) => i === 0 || id > _ids[ i - 1 ] ) );
	assert.equal( new Set( _ids ).size, 1000 );
} );

attack( S, 'times never go backwards in append order', () => {
	const _log = fresh();
	const _times = Array.from( { length: 500 }, () => _log.append( 'k' ).time );
	assert.ok( _times.every( ( time, i ) => i === 0 || time >= _times[ i - 1 ] ) );
} );

attack( S, 'since(0) replays every event in id order with its data parsed', () => {
	const _log = fresh();
	for ( let i = 0; i < 20; i++ ) { _log.append( `k${i % 3}`, { i, nested: { list: [ i ] } } ); }
	const _all = _log.since( 0 );
	assert.deepEqual( _all.map( event => event.data.i ), Array.from( { length: 20 }, ( _, i ) => i ) );
	assert.deepEqual( _all[ 5 ].data.nested, { list: [ 5 ] } );
} );

attack( S, 'since() pages by 1000 by default; paging from the last id gets the rest without gaps or repeats', () => {
	const _log = fresh();
	for ( let i = 0; i < 1500; i++ ) { _log.append( 'k', { i } ); }
	const _first = _log.since( 0 );
	const _rest = _log.since( _first[ _first.length - 1 ].id );
	assert.equal( _first.length, 1000 );
	assert.equal( _rest.length, 500 );
	assert.deepEqual( [ ..._first, ..._rest ].map( event => event.data.i ), Array.from( { length: 1500 }, ( _, i ) => i ) );
} );

attack( S, 'start(): a live log that has seen nothing and asks for a tail starts at the last events, not the first page', () => {
	const _log = fresh();
	_log.db.transaction( () => { for ( let i = 0; i < 1500; i++ ) { _log.append( 'k', { i } ); } } );
	const q = text => new URLSearchParams( text );
	assert.equal( _log.start( q( 'tail=600' ) ), 900 );
	assert.equal( _log.since( _log.start( q( 'tail=600' ) ) )[ 0 ].data.i, 900, 'the first event sent is the 901st' );
	assert.equal( _log.start( q( 'since=0&tail=600' ) ), 900 );
	assert.equal( _log.start( q( 'since=1200&tail=600' ) ), 1200, 'a client that has seen events goes on from there' );
	assert.equal( _log.start( q( '' ) ), 0, 'without a tail, from the beginning as before' );
	assert.equal( _log.start( q( 'tail=99999' ) ), 500, 'at most a page' );
	assert.equal( fresh().start( q( 'tail=600' ) ), 0, 'an empty log starts at 0' );
	for ( const bad of [ 'tail=-5', 'tail=abc', 'since=-3', 'since=abc&tail=600' ] ) {
		assert.ok( Number.isInteger( _log.start( q( bad ) ) ) && _log.start( q( bad ) ) >= 0, bad );
	}
} );

attack( S, 'since( id, limit ) honours the limit and starts after id', () => {
	const _log = fresh();
	const _ids = Array.from( { length: 10 }, () => _log.append( 'k' ).id );
	assert.deepEqual( _log.since( _ids[ 2 ], 3 ).map( event => event.id ), _ids.slice( 3, 6 ) );
	assert.deepEqual( _log.since( _ids[ 9 ] ), [] );
	assert.deepEqual( _log.since( _ids[ 0 ], 0 ).map( event => event.id ), _ids.slice( 1 ), 'a limit of 0 or less means the default page' );
} );

attack( S, 'since() with a cursor that is not a number (as from ?since=abc) answers without throwing', () => {
	const _log = fresh();
	_log.append( 'k' );
	for ( const cursor of [ NaN, 'abc', Infinity, -Infinity, null, 1.5, -5, '0' ] ) {
		let _events;
		assert.doesNotThrow( () => { _events = _log.since( cursor ); }, String( cursor ) );
		assert.ok( Array.isArray( _events ) );
		assert.ok( _events.every( event => event.kind === 'k' ) );
	}
} );

attack( S, 'since() never returns an event at or before the cursor, whatever the limit', () => {
	const _log = fresh();
	const _ids = Array.from( { length: 30 }, () => _log.append( 'k' ).id );
	for ( const limit of [ 1, 5, 1000, -1 ] ) {
		const _events = _log.since( _ids[ 10 ], limit );
		assert.ok( _events.every( event => event.id > _ids[ 10 ] ) );
		assert.ok( _events.every( ( event, i ) => i === 0 || event.id > _events[ i - 1 ].id ) );
	}
} );

attack( S, 'forNode() returns exactly that node\'s events, in order', () => {
	const _log = fresh();
	const _rnd = random( 41 );
	const _expected = { a: [], b: [], c: [] };
	for ( let i = 0; i < 300; i++ ) {
		const _node = _rnd.pick( [ 'a', 'b', 'c', null ] );
		const _event = _log.append( 'k', { i }, { node: _node } );
		if ( _node ) { _expected[ _node ].push( _event.id ); }
	}
	for ( const node of [ 'a', 'b', 'c' ] ) { assert.deepEqual( _log.forNode( node ).map( event => event.id ), _expected[ node ] ); }
} );

attack( S, 'forNode() of something that is no node id (undefined, a number) finds nothing', () => {
	const _log = fresh();
	_log.append( 'k', {}, { node: '5' } );
	assert.deepEqual( _log.forNode( undefined ), [] );
	assert.deepEqual( _log.forNode( 5 ), [] );
} );

attack( S, 'forNode( null ) finds nothing (events without a node belong to no node)', () => {
	const _log = fresh();
	_log.append( 'k' );
	_log.append( 'k', {}, { node: 'null' } );
	assert.deepEqual( _log.forNode( null ), [] );
	assert.equal( _log.forNode( 'null' ).length, 1 );
} );

attack( S, 'forNode() with SQL in the node id matches nothing and changes nothing', () => {
	const _log = fresh();
	_log.append( 'k', {}, { node: 'n1' } );
	assert.deepEqual( _log.forNode( '\' OR 1=1 --' ), [] );
	assert.deepEqual( _log.forNode( 'n1\'; DELETE FROM events; --' ), [] );
	assert.equal( _log.since( 0 ).length, 1 );
} );

attack( S, 'the source comes from the log and can be set per event', () => {
	const _log = fresh( 'gate' );
	assert.equal( _log.append( 'a' ).source, 'gate' );
	assert.equal( _log.append( 'b', {}, { source: 'world' } ).source, 'world' );
	assert.deepEqual( _log.since( 0 ).map( event => event.source ), [ 'gate', 'world' ] );
} );

attack( S, 'subscribers get each event once, in id order, with the same id the replay shows', () => {
	const _log = fresh();
	const _seen = [];
	_log.subscribe( event => _seen.push( event.id ) );
	for ( let i = 0; i < 100; i++ ) { _log.append( 'k' ); }
	assert.deepEqual( _seen, _log.since( 0 ).map( event => event.id ) );
} );

attack( S, 'a throwing subscriber: the event is stored and returned, the others still get it, app.fail hears of it', () => {
	const _log = fresh();
	const _quiet = quiet();
	const _seen = [];
	let _event;
	try {
		_log.subscribe( () => { throw new Error( 'subscriber broke' ); } );
		_log.subscribe( event => _seen.push( event.id ) );
		_event = _log.append( 'k', { a: 1 } );
	} finally {
		_quiet.restore();
	}
	assert.deepEqual( _seen, [ _event.id ] );
	assert.equal( _log.since( 0 ).length, 1 );
	assert.equal( _quiet.errors[ 0 ].message, 'subscriber broke' );
} );

attack( S, 'a subscriber that appends: every other subscriber still sees the events in id order', () => {
	const _log = fresh();
	const _order = [];
	_log.subscribe( ( event ) => {
		if ( event.kind === 'first' ) { _log.append( 'second' ); }
	} );
	_log.subscribe( event => _order.push( event.id ) );
	_log.append( 'first' );
	assert.deepEqual( _order, [ ..._order ].sort( ( a, b ) => a - b ), 'a live view (SSE) would get id 2 before id 1' );
} );

attack( S, 'unsubscribing stops delivery; unsubscribing inside the callback is safe', () => {
	const _log = fresh();
	const _seen = [];
	const _off = _log.subscribe( ( event ) => {
		_seen.push( event.kind );
		_off();
	} );
	_log.append( 'a' );
	_log.append( 'b' );
	assert.deepEqual( _seen, [ 'a' ] );
} );

attack( S, 'data with a BigInt is refused: nothing stored, nobody notified', () => {
	const _log = fresh();
	let _notified = 0;
	_log.subscribe( () => { _notified += 1; } );
	assert.throws( () => _log.append( 'k', { amount: 10n } ), TypeError );
	assert.equal( _notified, 0 );
	assert.deepEqual( _log.since( 0 ), [] );
} );

attack( S, 'data with a cycle is refused: nothing stored, nobody notified', () => {
	const _log = fresh();
	let _notified = 0;
	_log.subscribe( () => { _notified += 1; } );
	const _cycle = { a: 1 };
	_cycle.self = _cycle;
	assert.throws( () => _log.append( 'k', _cycle ), TypeError );
	assert.equal( _notified, 0 );
	assert.deepEqual( _log.since( 0 ), [] );
} );

attack( S, 'no data gives {}; null, strings, numbers and lists are kept as they are', () => {
	const _log = fresh();
	const _values = [ undefined, null, 'text', 0, -1.5, [ 1, 'a' ], true ];
	_values.forEach( value => _log.append( 'k', value ) );
	assert.deepEqual( _log.since( 0 ).map( event => event.data ), [ {}, null, 'text', 0, -1.5, [ 1, 'a' ], true ] );
} );

attack( S, 'the live event carries the same data the replay will show (Date, NaN, undefined)', () => {
	const _log = fresh();
	let _live;
	_log.subscribe( ( event ) => { _live = event; } );
	const _event = _log.append( 'k', { at: new Date( 0 ), amount: NaN, gone: undefined } );
	assert.deepEqual( _live.data, replayOf( _log, _event.id ).data, 'a subscriber derives state from what was really stored' );
} );

attack( S, 'changing the data object after append changes neither the stored nor the delivered event', () => {
	const _log = fresh();
	let _live;
	_log.subscribe( ( event ) => { _live = event; } );
	const _data = { status: 'approved' };
	const _event = _log.append( 'k', _data );
	_data.status = 'forged';
	assert.equal( replayOf( _log, _event.id ).data.status, 'approved' );
	assert.equal( _live.data.status, 'approved', 'what a subscriber keeps must not change behind its back' );
} );

attack( S, 'a kind that is not text is refused or kept as it was given', () => {
	const _log = fresh();
	const _problems = [];
	for ( const kind of [ true, 5, 10n ] ) {
		let _event;
		try {
			_event = _log.append( kind );
		} catch {
			continue;
		}
		const _back = replayOf( _log, _event.id ).kind;
		if ( _back !== _event.kind ) { _problems.push( `${typeof kind} ${String( kind )} came back as ${typeof _back} ${_back}` ); }
	}
	assert.deepEqual( _problems, [] );
} );

attack( S, 'a kind that SQLite cannot hold is refused before anything is stored or delivered', () => {
	const _log = fresh();
	let _notified = 0;
	_log.subscribe( () => { _notified += 1; } );
	for ( const kind of [ null, undefined, {}, [], () => 1, Symbol( 'k' ) ] ) {
		assert.throws( () => _log.append( kind ), Error );
	}
	assert.equal( _notified, 0 );
	assert.deepEqual( _log.since( 0 ), [] );
} );

attack( S, 'nodeVersion: the live value equals the replayed one for every hostile number', () => {
	const _log = fresh();
	const _problems = [];
	for ( const version of [ 0, -0, -1, 1, 0.5, 2 ** 53, Infinity, -Infinity, 5e-324, NaN ] ) {
		const _event = _log.append( 'k', {}, { nodeVersion: version } );
		const _back = replayOf( _log, _event.id ).nodeVersion;
		if ( !Object.is( _back, version ) && !( version === 0 && _back === 0 ) ) { _problems.push( `${version} → ${_back}` ); }
	}
	assert.deepEqual( _problems, [] );
} );

attack( S, 'a nodeVersion that can be appended never makes the log unreadable', () => {
	const _log = fresh();
	_log.append( 'before' );
	try {
		_log.append( 'k', {}, { nodeVersion: 9007199254740993n } );
	} catch {
		// refusing it is fine
	}
	assert.doesNotThrow( () => _log.since( 0 ), 'one row must not poison every replay' );
	assert.doesNotThrow( () => _log.forNode( null ) );
} );

attack( S, 'a 5 MB payload is stored and replayed intact', () => {
	const _log = fresh();
	const _text = 'x'.repeat( 5 * 1024 * 1024 );
	const _event = _log.append( 'big', { text: _text, list: Array.from( { length: 10000 }, ( _, i ) => i ) } );
	const _back = replayOf( _log, _event.id ).data;
	assert.equal( _back.text.length, _text.length );
	assert.equal( _back.list[ 9999 ], 9999 );
} );

attack( S, 'unicode survives: emoji, combining marks, RTL marks, NUL and lone surrogates', () => {
	const _log = fresh();
	const _data = { s: '😀👨‍👩‍👧 Cafe\u0301 \u202Eevil\u202C a\u0000b \uD800 \uDFFF \uFEFF' };
	const _event = _log.append( 'k', _data );
	assert.deepEqual( replayOf( _log, _event.id ).data, _data );
} );

attack( S, 'a __proto__ key in data is replayed as an own key and pollutes nothing', () => {
	const _log = fresh();
	const _event = _log.append( 'k', JSON.parse( '{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}' ) );
	const _back = replayOf( _log, _event.id ).data;
	assert.ok( Object.hasOwn( _back, '__proto__' ) );
	assert.equal( {}.polluted, undefined );
	assert.equal( {}.x, undefined );
} );

attack( S, 'random payloads replay exactly as JSON stores them (300 seeded trees)', () => {
	const _log = fresh();
	const _rnd = random( 42 );
	const _sent = Array.from( { length: 300 }, () => tree( _rnd, 4 ) );
	_sent.forEach( value => _log.append( 'k', value ) );
	assert.deepEqual( _log.since( 0, 1000 ).map( event => event.data ), _sent.map( value => JSON.parse( JSON.stringify( value ) ) ) );
} );

attack( S, 'after close and reopen the same events come back with the same ids, and new ids continue above them', () => {
	const _file = path.join( tempDir( 'eventlog' ), 'log.db' );
	const _db = new Db( _file );
	const _log = new EventLog( _db, 'core' );
	const _ids = Array.from( { length: 50 }, ( _, i ) => _log.append( 'k', { i }, { node: `n${i % 5}` } ).id );
	_db.close();
	const _again = new EventLog( new Db( _file ), 'core' );
	assert.deepEqual( _again.since( 0 ).map( event => event.id ), _ids );
	assert.equal( _again.forNode( 'n3' ).length, 10 );
	assert.ok( _again.append( 'next' ).id > _ids[ 49 ] );
} );

attack( S, 'ids are never reused, even if rows were deleted behind the log\'s back (AUTOINCREMENT)', () => {
	const _db = new Db( ':memory:' );
	const _log = new EventLog( _db, 'core' );
	const _last = Array.from( { length: 10 }, () => _log.append( 'k' ).id ).pop();
	_db.exec( 'DELETE FROM events' );
	assert.ok( _log.append( 'k' ).id > _last );
} );

attack( S, 'two logs on one database share the table and its ids; each notifies only its own subscribers', () => {
	const _db = new Db( ':memory:' );
	const _a = new EventLog( _db, 'core' );
	const _b = new EventLog( _db, 'gate' );
	const _seenA = [];
	_a.subscribe( event => _seenA.push( event.source ) );
	const _ids = [ _a.append( 'x' ).id, _b.append( 'y' ).id, _a.append( 'z' ).id ];
	assert.equal( new Set( _ids ).size, 3 );
	assert.deepEqual( _seenA, [ 'core', 'core' ] );
	assert.deepEqual( _b.since( 0 ).map( event => event.source ), [ 'core', 'gate', 'core' ] );
} );

attack( S, 'an append inside a transaction that rolls back is never delivered to subscribers', () => {
	const _db = new Db( ':memory:' );
	const _log = new EventLog( _db, 'gate' );
	const _seen = [];
	_log.subscribe( event => _seen.push( event.kind ) );
	assert.throws( () => _db.transaction( () => {
		_log.append( 'attempt_begun' );
		throw new Error( 'booking failed' );
	} ) );
	assert.deepEqual( _log.since( 0 ), [] );
	assert.deepEqual( _seen, [], 'the live log showed an event that never happened' );
} );

attack( S, 'an id once shown to subscribers is never given to a different event', () => {
	const _db = new Db( ':memory:' );
	const _log = new EventLog( _db, 'gate' );
	const _seen = new Map();
	_log.subscribe( ( event ) => {
		assert.ok( !_seen.has( event.id ) || _seen.get( event.id ) === event.kind, `id ${event.id} was ${_seen.get( event.id )}, now ${event.kind}` );
		_seen.set( event.id, event.kind );
	} );
	const _quiet = quiet();
	try {
		assert.throws( () => _db.transaction( () => {
			_log.append( 'phantom' );
			throw new Error( 'rolled back' );
		} ) );
		_log.append( 'real' );
	} finally {
		_quiet.restore();
	}
	assert.deepEqual( _quiet.errors, [], 'an SSE client deduplicating by id (E2) would drop the real event' );
} );

attack( S, 'an append inside a committed transaction is stored and delivered exactly once', () => {
	const _db = new Db( ':memory:' );
	const _log = new EventLog( _db, 'gate' );
	const _seen = [];
	_log.subscribe( event => _seen.push( event.id ) );
	const _event = _db.transaction( () => _log.append( 'booked' ) );
	assert.deepEqual( _seen, [ _event.id ] );
	assert.deepEqual( _log.since( 0 ).map( event => event.id ), [ _event.id ] );
} );

attack( S, 'constructing a second log on an existing table neither drops nor duplicates events', () => {
	const _db = new Db( ':memory:' );
	new EventLog( _db, 'a' ).append( 'k' );
	const _second = new EventLog( _db, 'b' );
	assert.equal( _second.since( 0 ).length, 1 );
} );

attack( S, '10000 events of 100 nodes: forNode and since stay correct and fast', () => {
	const _log = fresh();
	_log.db.transaction( () => { for ( let i = 0; i < 10000; i++ ) { _log.append( 'k', { i }, { node: `n${i % 100}` } ); } } );
	const _start = performance.now();
	const _mine = _log.forNode( 'n42' );
	assert.equal( _mine.length, 100 );
	assert.ok( _mine.every( event => event.data.i % 100 === 42 ) );
	assert.equal( _log.since( 9990, 100 ).length, 10 );
	assert.ok( performance.now() - _start < 2000 );
} );
