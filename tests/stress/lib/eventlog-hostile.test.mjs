// lib/eventlog.js under attack, part 2: hostile node ids and hostile payload types, one test each. A node's history
// (forNode) must contain exactly its own events, whatever its id looks like; a payload is stored as JSON or refused
// before anything is written or delivered.
import assert from 'node:assert/strict';
import { attack, attacks, hostile } from '../hostile.mjs';
import { agency, distinct } from './tools.mjs';

const [ Db, EventLog ] = await agency.use( [ 'Lib.Db', 'Lib.EventLog' ] );
const S = 'lib/eventlog.js';

const fresh = () => new EventLog( new Db( ':memory:' ), 'test' );

const NODES = distinct( hostile( 'strings', 'keys' ) );
attacks( S, NODES.map( item => ( { ...item, name: `node id ${item.label}: forNode returns exactly its own events` } ) ), ( { value } ) => {
	const _log = fresh();
	const _before = Object.getOwnPropertyNames( Object.prototype ).join();
	_log.append( 'decoy', { n: 0 }, { node: `${value}x` } );
	const _mine = [ _log.append( 'mine', { n: 1 }, { node: value } ).id, _log.append( 'mine', { n: 2 }, { node: value, nodeVersion: 2 } ).id ];
	_log.append( 'decoy', { n: 3 }, { node: value.toUpperCase() === value ? `${value} ` : value.toUpperCase() } );
	const _history = _log.forNode( value );
	assert.deepEqual( _history.map( event => event.id ), _mine );
	assert.ok( _history.every( event => event.node === value && event.kind === 'mine' ) );
	assert.equal( _log.since( 0 ).length, 4, 'nothing was deleted or added by the id' );
	assert.equal( Object.getOwnPropertyNames( Object.prototype ).join(), _before );
} );

attacks( S, hostile( 'types' ).map( item => ( { ...item, name: `payload ${item.label}: stored as its JSON or refused with nothing written` } ) ), ( { value } ) => {
	const _log = fresh();
	let _notified = 0;
	_log.subscribe( () => { _notified += 1; } );
	let _event;
	try {
		_event = _log.append( 'k', value );
	} catch ( error ) {
		assert.ok( error instanceof TypeError, `unexpected ${error}` );
		assert.equal( _notified, 0 );
		assert.deepEqual( _log.since( 0 ), [] );
		return;
	}
	assert.equal( _notified, 1 );
	const _expected = value === undefined ? {} : JSON.parse( JSON.stringify( value ) );
	assert.deepEqual( _log.since( 0 )[ 0 ].data, _expected );
	assert.equal( _log.since( 0 )[ 0 ].id, _event.id );
} );

attacks( S, hostile( 'strings' ).filter( item => item.value.length < 1000 ).map( item => ( {
	...item, name: `kind ${item.label} is stored and replayed exactly`,
} ) ), ( { value } ) => {
	const _log = fresh();
	const _event = _log.append( value, { ok: true } );
	const [ _back ] = _log.since( 0 );
	assert.equal( _back.kind, value );
	assert.equal( _event.kind, value );
	assert.deepEqual( _back.data, { ok: true } );
} );

attack( S, 'the same callback subscribed twice gets each event once', () => {
	const _log = fresh();
	let _calls = 0;
	const _cb = () => { _calls += 1; };
	_log.subscribe( _cb );
	_log.subscribe( _cb );
	_log.append( 'k' );
	assert.equal( _calls, 1 );
} );

attack( S, 'since() at exactly the page size: 1000 events fit one page, the next page is empty', () => {
	const _log = fresh();
	_log.db.transaction( () => { for ( let i = 0; i < 1000; i++ ) { _log.append( 'k' ); } } );
	const _page = _log.since( 0 );
	assert.equal( _page.length, 1000 );
	assert.deepEqual( _log.since( _page[ 999 ].id ), [] );
} );
