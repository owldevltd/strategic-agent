import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';

const [ Hash, Db, EventLog ] = await use( 'Lib.Hash', 'Lib.Db', 'Lib.EventLog' );

test( 'canonical hash ignores key order', () => {
	assert.equal( Hash.sha256( { a: 1, b: [ 2, { c: 3, d: 4 } ] } ), Hash.sha256( { b: [ 2, { d: 4, c: 3 } ], a: 1 } ) );
	assert.notEqual( Hash.sha256( { a: 1 } ), Hash.sha256( { a: 2 } ) );
} );

test( 'transaction rolls back on error and nests', () => {
	const _db = new Db( ':memory:' );
	_db.exec( 'CREATE TABLE t ( x INTEGER )' );
	assert.throws( () => _db.transaction( () => {
		_db.run( 'INSERT INTO t ( x ) VALUES ( 1 )' );
		_db.transaction( () => _db.run( 'INSERT INTO t ( x ) VALUES ( 2 )' ) );
		throw new Error( 'stop' );
	} ) );
	assert.equal( _db.get( 'SELECT COUNT(*) AS n FROM t' ).n, 0 );
} );

test( 'event log appends, replays and notifies', () => {
	const _log = new EventLog( new Db( ':memory:' ), 'test' );
	const _seen = [];
	_log.subscribe( event => _seen.push( event.kind ) );
	_log.append( 'contract_confirmed', { id: 'c1' }, { node: 'n1', nodeVersion: 1 } );
	_log.append( 'plan_accepted', {}, { node: 'n1', nodeVersion: 2 } );
	assert.deepEqual( _seen, [ 'contract_confirmed', 'plan_accepted' ] );
	assert.equal( _log.since( 1 ).length, 1 );
	assert.equal( _log.forNode( 'n1' )[ 0 ].data.id, 'c1' );
} );

test( 'a public demo limits one caller and everyone together within a window', async () => {
	const [ Limits ] = await use( 'Lib.Limits' );
	const _clock = { now: 0 };
	const _limits = new Limits( { perCaller: 2, total: 3, windowMs: 1000, now: () => _clock.now } );
	assert.deepEqual( [ _limits.take( 'a' ), _limits.take( 'a' ), _limits.take( 'a' ) ], [ true, true, false ] );
	assert.deepEqual( [ _limits.take( 'b' ), _limits.take( 'c' ) ], [ true, false ], 'three in total' );
	_clock.now = 1500;
	assert.equal( _limits.take( 'a' ), true, 'the window moves on' );
	assert.equal( Limits.caller( { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } } ), '10.0.0.1',
		'behind the proxy the address it added last counts; what the client wrote before it can be anything' );
	assert.equal( Limits.caller( { headers: { 'x-forwarded-for': '203.0.113.7' }, socket: { remoteAddress: '198.51.100.2' } } ), '198.51.100.2',
		'only the proxy on this machine may name the caller' );
} );
