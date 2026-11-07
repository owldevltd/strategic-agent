// core/node/node.js under attack, part 1: facts. E2 duplicates, hostile facts, E5 superseding and conflicts.
import assert from 'node:assert/strict';
import { attack, attacks, hostile, random } from '../hostile.mjs';
import { node, measured, about, Node, EventLog, Db } from './kit.mjs';

const S = 'core/node/node.js';

attack( S, 'a fact without an id gets a fresh id, a time, labels and the attempt of the open plan (L4)', () => {
	const _node = node();
	_node.plan = { open: true, attempt: 7 };
	const _fact = _node.addFact( { kind: 'note', origin: 'system' } );
	assert.match( _fact.id, /^fact-[0-9a-f]{16}$/ );
	assert.ok( !Number.isNaN( Date.parse( _fact.time ) ) );
	assert.deepEqual( [ _fact.labels, _fact.attempt ], [ [], 7 ] );
	assert.equal( _node.addFact( { kind: 'note', origin: 'system' } ).id === _fact.id, false, 'every fact gets its own id' );
} );

attack( S, 'a fact that names its own attempt keeps it, whatever attempt is open when it arrives (L4)', () => {
	const _node = node();
	_node.plan = { open: true, attempt: 9 };
	assert.equal( _node.addFact( { kind: 'delivered', origin: 'gate', attempt: 3 } ).attempt, 3 );
	_node.plan = { open: false, attempt: 9 };
	assert.equal( _node.addFact( { kind: 'note', origin: 'system' } ).attempt, null, 'no open plan: no attempt' );
} );

attack( S, 'E2: a fact with an id the node already has is dropped, without a second event', () => {
	const _node = node();
	assert.ok( _node.addFact( { id: 'f-1', kind: 'note', origin: 'a' } ) );
	assert.equal( _node.addFact( { id: 'f-1', kind: 'other', origin: 'b', data: { about: 'x', value: 1 } } ), null );
	assert.equal( _node.facts.length, 1 );
	assert.equal( _node.facts[ 0 ].kind, 'note', 'the first delivery stands' );
	assert.equal( _node.log.of( 'fact_delivered' ).length, 1 );
} );

attack( S, 'E2: a thousand deliveries of the same fact store it once', () => {
	const _node = node();
	for ( let i = 0; i < 1000; i++ ) { _node.addFact( measured( i, { id: 'same' } ) ); }
	assert.equal( _node.facts.length, 1 );
	assert.equal( _node.facts[ 0 ].data.value, 0 );
} );

attack( S, 'E2: an empty, zero or missing id is no id; each such fact is stored under a fresh one', () => {
	const _node = node();
	for ( const id of [ '', 0, false, null, undefined ] ) {
		const _fact = _node.addFact( { id, kind: 'note', origin: 'a' } );
		assert.match( _fact.id, /^fact-/, `id ${String( id )}` );
	}
	assert.equal( new Set( _node.facts.map( fact => fact.id ) ).size, 5 );
} );

attacks( S, hostile( 'keys' ).map( item => ( { ...item, name: `E2: a fact with the hostile id ${item.label} is stored under exactly that id, once` } ) ), ( { value } ) => {
	const _node = node();
	const _fact = _node.addFact( { id: value, kind: 'note', origin: 'a' } );
	if ( value === '' ) {
		assert.match( _fact.id, /^fact-/ );
		return;
	}
	assert.equal( _fact.id, value );
	assert.equal( _node.addFact( { id: value, kind: 'note', origin: 'b' } ), null );
	assert.equal( _node.facts.length, 1 );
	assert.equal( Object.getPrototypeOf( _node.facts[ 0 ] ), Object.prototype, 'no prototype was touched' );
} );

const _types = hostile( 'types' ).filter( item => typeof item.value !== 'bigint' );
attacks( S, _types.map( item => ( { ...item, name: `a fact whose data is ${item.label} is stored and contradicts nothing` } ) ), ( { value } ) => {
	const _node = node();
	_node.addFact( { kind: 'item_state', origin: 'a', data: value } );
	_node.addFact( { kind: 'item_state', origin: 'b', data: value } );
	assert.equal( _node.facts.length, 2 );
	assert.deepEqual( _node.conflicts(), [] );
	assert.equal( _node.valid().length, 2 );
} );

attack( S, 'a fact that cannot be written to the log is not kept in memory either (Z4)', () => {
	const _node = node( { log: new EventLog( new Db( ':memory:' ), 'core' ) } );
	assert.throws( () => _node.addFact( { kind: 'note', origin: 'a', data: { size: 10n } } ) );
	assert.equal( _node.facts.length, 0, 'memory and log must not part ways: after a restart this fact would be gone' );
} );

attack( S, 'E5: of two facts from the same origin the younger counts, the older is superseded with an event', () => {
	const _node = node();
	const _old = _node.addFact( about( 'R-1', 'open', 'bank' ) );
	const _new = _node.addFact( about( 'R-1', 'paid', 'bank' ) );
	assert.equal( _old.superseded, true );
	assert.deepEqual( _node.valid().map( fact => fact.id ), [ _new.id ] );
	assert.deepEqual( _node.log.of( 'fact_superseded' ), [ { id: _old.id, by: _new.id } ] );
	assert.deepEqual( _node.conflicts(), [] );
} );

attack( S, 'E5: a chain of five versions from one origin leaves only the last one valid', () => {
	const _node = node();
	const _ids = [ 1, 2, 3, 4, 5 ].map( value => _node.addFact( about( 'R-1', value, 'bank' ) ).id );
	assert.deepEqual( _node.valid().map( fact => fact.id ), [ _ids[ 4 ] ] );
	assert.deepEqual( _node.log.of( 'fact_superseded' ).map( item => item.id ), _ids.slice( 0, 4 ) );
} );

attack( S, 'E5: the same value from another origin is agreement, not a conflict', () => {
	const _node = node();
	_node.addFact( about( 'R-1', { amount: 120, currency: 'EUR' }, 'bank' ) );
	_node.addFact( about( 'R-1', { amount: 120, currency: 'EUR' }, 'erp' ) );
	assert.deepEqual( _node.conflicts(), [] );
	assert.equal( _node.valid().length, 2 );
} );

attack( S, 'E5: different values from different origins record one conflict fact naming both facts', () => {
	const _node = node();
	const _a = _node.addFact( about( 'R-1', 'paid', 'bank' ) );
	const _b = _node.addFact( about( 'R-1', 'open', 'erp' ) );
	const [ _conflict ] = _node.conflicts();
	assert.deepEqual( _conflict.data, { about: 'R-1', of: 'item_state', facts: [ _a.id, _b.id ] } );
	assert.equal( _conflict.evidenceClass, 'observation' );
	assert.equal( _node.log.of( 'conflict' ).length, 1 );
	assert.equal( _a.superseded, undefined, 'neither side wins on its own' );
} );

attack( S, 'E5: the same value written with another key order is no conflict', () => {
	const _node = node();
	_node.addFact( about( 'R-1', { amount: 120, currency: 'EUR' }, 'bank' ) );
	_node.addFact( about( 'R-1', { currency: 'EUR', amount: 120 }, 'erp' ) );
	assert.deepEqual( _node.conflicts(), [], 'equal values must not block closing (E5, G6)' );
} );

attack( S, 'E5: three origins that all disagree record one conflict for the thing, not one per pair', () => {
	const _node = node();
	const _ids = [ [ 'a', 1 ], [ 'b', 2 ], [ 'c', 3 ] ].map( ( [ origin, value ] ) => _node.addFact( about( 'R-1', value, origin ) ).id );
	assert.equal( _node.conflicts().length, 1 );
	assert.deepEqual( _node.conflicts()[ 0 ].data.facts, _ids.slice( 0, 2 ), 'recorded when the first two disagreed' );
	assert.equal( _node.log.of( 'conflict' ).length, 1 );
} );

attack( S, 'E5: a superseded fact is not compared again; only the current version of each origin counts', () => {
	const _node = node();
	_node.addFact( about( 'R-1', 'old', 'bank' ) );
	const _current = _node.addFact( about( 'R-1', 'new', 'bank' ) );
	const _erp = _node.addFact( about( 'R-1', 'old', 'erp' ) );
	assert.deepEqual( _node.conflicts().map( fact => fact.data.facts ), [ [ _current.id, _erp.id ] ] );
} );

attack( S, 'E5: facts of different kinds about the same thing do not contradict each other', () => {
	const _node = node();
	_node.addFact( about( 'R-1', 'paid', 'bank', 'payment_state' ) );
	_node.addFact( about( 'R-1', 'open', 'erp', 'invoice_state' ) );
	assert.deepEqual( _node.conflicts(), [] );
} );

attack( S, 'E5: a fact without a value, or without what it is about, is never compared', () => {
	const _node = node();
	_node.addFact( { kind: 'item_state', origin: 'a', data: { about: 'R-1' } } );
	_node.addFact( { kind: 'item_state', origin: 'b', data: { about: 'R-1' } } );
	_node.addFact( { kind: 'item_state', origin: 'a', data: { value: 1 } } );
	_node.addFact( { kind: 'item_state', origin: 'b', data: { value: 2 } } );
	assert.deepEqual( _node.conflicts(), [] );
	assert.equal( _node.facts.filter( fact => fact.superseded ).length, 0 );
} );

attacks( S, hostile( 'keys' ).map( item => ( { ...item, name: `E5: a conflict about the hostile thing ${item.label} is found and stays open` } ) ), ( { value } ) => {
	const _node = node();
	_node.addFact( about( value, 1, 'a' ) );
	_node.addFact( about( value, 2, 'b' ) );
	assert.equal( _node.conflicts().length, 1 );
	assert.equal( _node.conflicts()[ 0 ].data.about, value );
	assert.equal( ( {} ).polluted, undefined );
} );

attack( S, 'E5: a conflict_resolved fact closes the conflict about that thing only', () => {
	const _node = node();
	_node.addFact( about( 'R-1', 1, 'a' ) );
	_node.addFact( about( 'R-1', 2, 'b' ) );
	_node.addFact( about( 'R-2', 1, 'a' ) );
	_node.addFact( about( 'R-2', 2, 'b' ) );
	_node.addFact( { kind: 'conflict_resolved', origin: 'person', data: { about: 'R-1' } } );
	assert.deepEqual( _node.conflicts().map( fact => fact.data.about ), [ 'R-2' ] );
} );

attack( S, 'a conflict_resolved fact without data does not break the list of open conflicts', () => {
	const _node = node();
	_node.addFact( about( 'R-1', 1, 'a' ) );
	_node.addFact( about( 'R-1', 2, 'b' ) );
	_node.addFact( { kind: 'conflict_resolved', origin: 'person' } );
	assert.equal( _node.conflicts().length, 1, 'judge and G6 call conflicts() on every step' );
} );

attack( S, 'E5: a hundred and twenty origins that disagree are all kept, and every conflict names two different origins', () => {
	const _node = node();
	const _started = Date.now();
	for ( let i = 0; i < 120; i++ ) { _node.addFact( about( 'R-1', i, `origin-${i}` ) ); }
	assert.ok( Date.now() - _started < 15000, `took ${Date.now() - _started} ms` );
	const _origin = new Map( _node.facts.map( fact => [ fact.id, fact.origin ] ) );
	assert.ok( _node.conflicts().length > 0 );
	assert.ok( _node.conflicts().every( fact => _origin.get( fact.data.facts[ 0 ] ) !== _origin.get( fact.data.facts[ 1 ] ) ) );
	assert.equal( _node.facts.filter( fact => fact.kind === 'item_state' ).length, 120 );
} );

attack( S, 'E5: random interleavings of origins and values leave one current value per origin and thing', () => {
	const _rand = random( 4711 );
	const _node = node();
	for ( let i = 0; i < 300; i++ ) {
		_node.addFact( about( _rand.pick( [ 'R-1', 'R-2', 'R-3' ] ), _rand.int( 0, 3 ), _rand.pick( [ 'bank', 'erp', 'mail' ] ) ) );
	}
	const _current = new Map();
	for ( const fact of _node.valid().filter( item => item.kind === 'item_state' ) ) {
		const _key = `${fact.origin}/${fact.data.about}`;
		assert.ok( !_current.has( _key ) || _current.get( _key ) === fact.data.value, `${_key} has two current values` );
		_current.set( _key, fact.data.value );
	}
	assert.ok( _current.size > 0 );
} );

attack( S, 'a fact cannot arrive already superseded and still push its predecessor out (E5)', () => {
	const _node = node();
	_node.addFact( about( 'R-1', 'paid', 'bank' ) );
	_node.addFact( { ...about( 'R-1', 'open', 'bank' ), superseded: true } );
	assert.equal( _node.valid().filter( fact => fact.data?.about === 'R-1' ).length, 1, 'something about R-1 must still count' );
} );

attack( S, 'a fact cannot backdate itself before a criterion deadline it arrived after (B2, L4)', () => {
	const _deadline = new Date( Date.now() - 60000 ).toISOString();
	const _node = node( { criteria: [ { id: 'k1', type: 'number_in_range', values: { quantity: 'answers', min: 2 }, deadline: _deadline } ] } );
	_node.addFact( measured( 5, { time: '2020-01-01T00:00:00Z' } ) );
	assert.equal( _node.openOutcomes().length, 1, 'a fact that arrives after the deadline does not meet the criterion' );
} );

attack( S, 'a malformed fact never leaves the node half-written: stored and credited, or refused', () => {
	const _node = node( { criteria: [ { id: 'k1', type: 'items_resolved', values: { collection: 'invoices', items: [ 'R-1' ], outcomes: [ 'paid' ] } } ] } );
	let _error = null;
	try {
		_node.addFact( { kind: 'item_resolved', origin: 'gate' } );
	} catch ( error ) {
		_error = error;
	}
	assert.equal( _error, null, 'the fact is stored and its event written, so the credit step must not throw afterwards' );
} );

attack( S, 'the fact_delivered event carries the stored fact itself, so a restart can rebuild it (Z4)', () => {
	const _node = node();
	_node.plan = { open: true, attempt: 2 };
	const _fact = _node.addFact( measured( 1, { validUntil: '2030-01-01T00:00:00Z' } ) );
	const [ _event ] = _node.log.events.filter( event => event.kind === 'fact_delivered' );
	assert.deepEqual( _event.data, JSON.parse( JSON.stringify( _fact ) ) );
	assert.equal( _event.node, _node.id );
} );

attack( S, 'no prototype is polluted by facts whose data carries __proto__ or constructor keys', () => {
	const _node = node();
	const _data = JSON.parse( '{"__proto__": {"polluted": true}, "about": "x", "value": 1, "constructor": {"prototype": {"bad": 1}}}' );
	_node.addFact( { kind: 'item_state', origin: 'a', data: _data } );
	_node.addFact( { kind: 'item_state', origin: 'b', data: { ..._data, value: 2 } } );
	assert.equal( ( {} ).polluted, undefined );
	assert.equal( ( {} ).bad, undefined );
	assert.equal( _node.conflicts().length, 1 );
} );

attack( S, 'Node.reason reads the first reason or error of a detail and never throws', () => {
	const _cases = [ [ 'text', 'text' ], [ [ 'first', 'second' ], 'first' ], [ [ { reason: 'r' } ], 'r' ], [ [ { error: 'e' } ], 'e' ],
		[ null, '' ], [ [], '' ], [ [ null ], '' ], [ {}, '' ], [ [ Symbol( 'x' ) ], '' ] ];
	_cases.forEach( ( [ detail, expected ], i ) => assert.equal( Node.reason( detail ), expected, `case ${i}` ) );
} );

attack( S, 'a node without a log does all its work silently: move, facts, conflicts, walls', () => {
	const _node = node( { log: null } );
	_node.move( 'confirmed' );
	_node.addFact( about( 'R-1', 1, 'a' ) );
	_node.addFact( about( 'R-1', 2, 'b' ) );
	_node.hitWall( 'no_reaction', [ 'nothing came' ] );
	assert.deepEqual( [ _node.state, _node.conflicts().length, _node.walls.length ], [ 'confirmed', 1, 1 ] );
} );
