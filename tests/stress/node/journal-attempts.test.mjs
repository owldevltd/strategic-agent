// core/learn/journal.js under attack, part 1: recording attempts (chapter 20, L2, L3, L4) with hostile ids, values that
// cannot be stored, results that must not be overwritten, credit, and what stays open for the choice (19).
import assert from 'node:assert/strict';
import { attack, attacks, hostile } from '../hostile.mjs';
import { journal, jnode, Journal, Db, HOUR } from './kit.mjs';

const S = 'core/learn/journal.js';
const count = db => db.get( 'SELECT COUNT(*) AS n FROM attempts' ).n;

attack( S, 'L2: an attempt is recorded with node, contract, strategy, situation, start, criterion, trigger and its horizon', () => {
	const { journal: _j, clock } = journal();
	const _id = _j.start( jnode( 'n1' ), { id: 'mail' }, { wall: 'no_reaction', contact: 'x' }, { criterion: 'k1', trigger: 'review', horizonH: 24 } );
	const _row = _j.get( _id );
	assert.deepEqual( [ _row.node, _row.contract, _row.strategy, JSON.parse( _row.situation ) ], [ 'n1', 'h-n1', 'mail', { wall: 'no_reaction', contact: 'x' } ] );
	assert.deepEqual( [ Date.parse( _row.startedAt ), _row.criterion, _row.trigger ], [ clock.now, 'k1', 'review' ] );
	assert.equal( Date.parse( _row.horizonUntil ), clock.now + 24 * HOUR );
	assert.deepEqual( [ _row.contribution, _row.contacts, _row.endedAt, _row.observationEnd ], [ '[]', '[]', null, null ] );
} );

attack( S, 'L2: without a horizon the attempt is observed for H = 168 h, and its trigger is the start', () => {
	const { journal: _j, clock } = journal();
	const _row = _j.get( _j.start( jnode( 'n1' ), { id: 'mail' } ) );
	assert.equal( Date.parse( _row.horizonUntil ), clock.now + Journal.HORIZON_H * HOUR );
	assert.deepEqual( [ _row.trigger, _row.criterion, JSON.parse( _row.situation ) ], [ 'start', null, {} ] );
} );

attack( S, 'a second journal on the same database sees the attempts of the first and adds no column twice', () => {
	const { db, journal: _j } = journal();
	const _id = _j.start( jnode( 'n1' ), { id: 'mail' } );
	const _again = new Journal( db );
	assert.equal( _again.get( _id ).strategy, 'mail' );
	const _columns = db.all( 'PRAGMA table_info( attempts )' ).map( column => column.name );
	assert.equal( _columns.length, new Set( _columns ).size );
} );

attack( S, 'a table from before L2 gets the new columns and keeps its rows', () => {
	const _db = new Db( ':memory:' );
	_db.exec( `CREATE TABLE attempts ( id INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT NOT NULL, contract TEXT NOT NULL, strategy TEXT NOT NULL,
		situation TEXT NOT NULL, startedAt TEXT NOT NULL, endedAt TEXT, outcome TEXT, cause TEXT, cost REAL )` );
	_db.run( 'INSERT INTO attempts ( node, contract, strategy, situation, startedAt ) VALUES ( \'n\', \'h\', \'old\', \'{}\', \'2026-01-01T00:00:00Z\' )' );
	const _j = new Journal( _db );
	assert.equal( _j.get( 1 ).strategy, 'old' );
	assert.deepEqual( Object.keys( Journal.COLUMNS ).filter( name => !( name in _j.get( 1 ) ) ), [] );
	assert.deepEqual( _j.open( 'n' ).map( row => ( { ...row } ) ), [ { strategy: 'old', criterion: null } ] );
} );

attacks( S, [ ...hostile( 'keys' ), ...hostile( 'strings' ).slice( 20, 22 ) ].map( item => ( {
	...item, name: `the node id ${item.label} is stored as it is and finds exactly its own attempts`,
} ) ), ( { value } ) => {
	const { db, journal: _j } = journal();
	const _id = _j.start( jnode( value ), { id: 'mail' } );
	_j.start( jnode( `${value}-other` ), { id: 'call' } );
	assert.deepEqual( _j.forNode( value ).map( row => row.id ), [ _id ] );
	assert.equal( count( db ), 2, 'nothing dropped, nothing injected' );
} );

attacks( S, [
	{ name: 'a situation that cannot be written as JSON leaves no half attempt behind', situation: ( () => {
		const _loop = {};
		_loop.self = _loop;
		return _loop;
	} )() },
	{ name: 'a situation with a big integer leaves no half attempt behind', situation: { count: 10n } },
	{ name: 'an impossible horizon leaves no half attempt behind', options: { horizonH: NaN } },
	{ name: 'an endless horizon leaves no half attempt behind', options: { horizonH: Infinity } },
	{ name: 'a strategy without an id leaves no half attempt behind', strategy: {} },
], ( { situation = {}, options = {}, strategy = { id: 'mail' } } ) => {
	const { db, journal: _j } = journal();
	assert.throws( () => _j.start( jnode( 'n1' ), strategy, situation, options ) );
	assert.equal( count( db ), 0 );
} );

attack( S, 'L2: a horizon of zero hours ends where the attempt starts; a signal at that instant still counts', () => {
	const { journal: _j, clock } = journal();
	const _id = _j.start( jnode( 'n1' ), { id: 'mail' }, {}, { horizonH: 0 } );
	assert.equal( Date.parse( _j.get( _id ).horizonUntil ), clock.now );
	assert.ok( _j.signal( _id ) );
} );

attack( S, 'attempt ids grow and forNode lists a node\'s attempts in that order, a thousand of them quickly', () => {
	const { journal: _j } = journal();
	const _started = Date.now();
	const _ids = Array.from( { length: 1000 }, ( _, i ) => _j.start( jnode( i % 2 ? 'odd' : 'even' ), { id: `s${i}` } ) );
	assert.deepEqual( _j.forNode( 'even' ).map( row => row.id ), _ids.filter( ( _, i ) => i % 2 === 0 ) );
	assert.equal( _j.all().length, 1000 );
	assert.ok( Date.now() - _started < 10000 );
} );

attack( S, 'L3: the result is written once; a second end does not overwrite it', () => {
	const { journal: _j, clock } = journal();
	const _id = _j.start( jnode( 'n1' ), { id: 'mail' } );
	clock.now += HOUR;
	_j.end( _id, { outcome: 'wall', cause: 'no_reaction', cost: 1.5 } );
	clock.now += HOUR;
	_j.end( _id, { outcome: 'done', cost: 99 } );
	const _row = _j.get( _id );
	assert.deepEqual( [ _row.outcome, _row.cause, _row.cost, Date.parse( _row.endedAt ) ], [ 'wall', 'no_reaction', 1.5, clock.now - HOUR ] );
} );

attack( S, 'ending an attempt nobody started changes nothing and does not throw', () => {
	const { db, journal: _j } = journal();
	_j.start( jnode( 'n1' ), { id: 'mail' } );
	for ( const id of [ 999, 'x', null, -1, 0 ] ) {
		assert.doesNotThrow( () => _j.end( id, { outcome: 'done' } ) );
	}
	assert.equal( db.get( 'SELECT COUNT(*) AS n FROM attempts WHERE endedAt IS NOT NULL' ).n, 0 );
} );

attack( S, 'an outcome that is not a code is refused before anything is written', () => {
	const { journal: _j } = journal();
	const _id = _j.start( jnode( 'n1' ), { id: 'mail' } );
	assert.throws( () => _j.end( _id, { outcome: { result: 'done' } } ) );
	assert.equal( _j.get( _id ).endedAt, null );
} );

attack( S, 'get finds an attempt by its number, also given as text', () => {
	const { journal: _j } = journal();
	const _id = _j.start( jnode( 'n1' ), { id: 'mail' } );
	assert.equal( _j.get( _id ).id, _id );
	assert.equal( _j.get( String( _id ) ).id, _id );
	for ( const id of [ 'x', null, undefined, NaN, -1, 1.5, {} ] ) {
		assert.equal( _j.get( id ), null, String( id ) );
	}
} );

attacks( S, [ true, [ 1 ], ' 1 ', '1e0', '0x1' ].map( value => ( {
	name: `L4: credit given to ${JSON.stringify( value )}, which is no attempt number, reaches no attempt`, value,
} ) ), ( { value } ) => {
	const { journal: _j } = journal();
	const _id = _j.start( jnode( 'n1' ), { id: 'mail' } );
	assert.equal( _id, 1 );
	_j.credit( value, 'k1' );
	assert.deepEqual( JSON.parse( _j.get( _id ).contribution ), [], 'a fact that carries a forged attempt must not credit attempt 1' );
} );

attack( S, 'L4: a criterion is credited once, and whoever keeps lessons hears of it', () => {
	const { journal: _j } = journal();
	const _told = [];
	_j.listen( ( ...args ) => _told.push( args ) );
	const _id = _j.start( jnode( 'n1' ), { id: 'mail' } );
	_j.credit( _id, 'k1' );
	_j.credit( _id, 'k1' );
	_j.credit( _id, 'k2' );
	assert.deepEqual( JSON.parse( _j.get( _id ).contribution ), [ 'k1', 'k2' ] );
	assert.deepEqual( _told, [ [ _id, { contribution: [ 'k1' ] }, 'late_credit' ], [ _id, { contribution: [ 'k1', 'k2' ] }, 'late_credit' ] ] );
} );

attack( S, 'L4: credit for an attempt nobody started is dropped quietly', () => {
	const { journal: _j } = journal();
	const _told = [];
	_j.listen( ( ...args ) => _told.push( args ) );
	assert.doesNotThrow( () => _j.credit( 42, 'k1' ) );
	assert.deepEqual( _told, [] );
} );

attack( S, 'L4: credit without a criterion is no credit', () => {
	const { journal: _j } = journal();
	const _id = _j.start( jnode( 'n1' ), { id: 'mail' } );
	_j.credit( _id, undefined );
	_j.credit( _id, undefined );
	assert.deepEqual( JSON.parse( _j.get( _id ).contribution ), [] );
} );

attacks( S, hostile( 'keys' ).filter( item => item.value ).map( item => ( { ...item, name: `L4: the criterion id ${item.label} is credited verbatim and once` } ) ), ( { value } ) => {
	const { journal: _j } = journal();
	const _id = _j.start( jnode( 'n1' ), { id: 'mail' } );
	_j.credit( _id, value );
	_j.credit( _id, value );
	assert.deepEqual( JSON.parse( _j.get( _id ).contribution ), [ value ] );
} );

attack( S, '19: open for the choice are running attempts and provisional timeouts whose observation goes on', () => {
	const { journal: _j } = journal();
	const _n = jnode( 'n1' );
	const [ _running, _timeout, _done, _wall, _ended ] = [ 'run', 'wait', 'done', 'wall', 'gone' ].map( id => _j.start( _n, { id }, {}, { criterion: 'k1' } ) );
	_j.end( _timeout, { outcome: 'timeout', cause: 'no_reaction' } );
	_j.end( _done, { outcome: 'done' } );
	_j.end( _wall, { outcome: 'wall', cause: 'not_reached' } );
	_j.end( _ended, { outcome: 'timeout' } );
	_j.endObservation( _ended, { reason: 'contact', trigger: 'review' } );
	assert.deepEqual( _j.open( 'n1' ).map( row => row.strategy ), [ 'run', 'wait' ] );
	assert.equal( _j.get( _running ).endedAt, null );
	assert.deepEqual( _j.open( 'other' ), [] );
} );

attack( S, '19: a provisional timeout corrected to a late effect is no longer open', () => {
	const { journal: _j } = journal();
	const _id = _j.start( jnode( 'n1' ), { id: 'mail' } );
	_j.end( _id, { outcome: 'timeout', cause: 'no_reaction' } );
	_j.signal( _id );
	assert.deepEqual( _j.open( 'n1' ), [] );
} );

attack( S, 'L3: the contract\'s success is written for every attempt of that node and of no other', () => {
	const { journal: _j } = journal();
	const [ _a, _b, _other ] = [ [ 'n1', 'a' ], [ 'n1', 'b' ], [ 'n2', 'c' ] ].map( ( [ id, s ] ) => _j.start( jnode( id ), { id: s } ) );
	_j.contractSuccess( jnode( 'n1' ), true );
	assert.deepEqual( [ _j.get( _a ).contractSuccess, _j.get( _b ).contractSuccess, _j.get( _other ).contractSuccess ], [ 1, 1, null ] );
	_j.contractSuccess( jnode( 'n1' ), false );
	assert.equal( _j.get( _a ).contractSuccess, 0 );
	assert.doesNotThrow( () => _j.contractSuccess( jnode( 'nobody' ), true ) );
} );

attack( S, 'hours between two times are rounded to a hundredth; unreadable times give no number', () => {
	assert.equal( Journal.hours( '2026-11-03T16:00:00Z', '2026-11-05T12:00:00Z' ), 44 );
	assert.equal( Journal.hours( '2026-11-03T16:00:00Z', '2026-11-03T16:00:18Z' ), 0.01 );
	assert.equal( Journal.hours( '2026-11-03T16:00:00Z', '2026-11-03T16:00:00Z' ), 0 );
	assert.ok( Number.isNaN( Journal.hours( 'x', '2026-11-03T16:00:00Z' ) ) );
} );

attack( S, 'all() gives every attempt of every node in the order they started', () => {
	const { journal: _j } = journal();
	const _ids = [ 'a', 'b', 'a', 'c' ].map( id => _j.start( jnode( id ), { id: `s-${id}` } ) );
	assert.deepEqual( _j.all().map( row => row.id ), _ids );
} );
