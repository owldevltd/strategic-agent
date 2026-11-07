// Stress tests of core/ticket/board.js against the daily capacity of the people (P6): before a ticket reaches a person
// its minutes count against the day; when the day is full it waits for the next day if its deadline allows, otherwise
// it goes out marked. A ticket to a parent node takes no person's time.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { Capacity, EventLog, memoryDb, fakeNode, quietBoard, tryIt, T0, HOUR } from './rig.mjs';

const S = 'core/ticket/board.js';
const NEXT_MORNING = '2026-11-05T08:00:00.000Z';

// A board with a daily capacity of `daily` minutes, both on one clock the test moves.
function day( { daily = 60, start = T0, deadline = T0 + 48 * HOUR } = {} ) {
	const _clock = { now: start };
	const _capacity = new Capacity( { dailyMinutes: daily, dayStartsHour: 8 }, () => _clock.now );
	const _board = quietBoard( new EventLog( memoryDb(), 'core' ), { now: () => _clock.now, capacity: _capacity } );
	const _node = fakeNode( 'node-a', { deadline: new Date( deadline ).toISOString() } );
	return { board: _board, clock: _clock, capacity: _capacity, node: _node };
}
const ask = ( d, minutes, spec = {} ) => d.board.ask( d.node, { question: `${minutes} minutes`, options: [ 'ok' ], recommendation: 'ok', minutes, ...spec } );
const shown = d => d.board.list().map( item => item.question );
const ticket = ( d, question ) => [ ...d.board.open.values() ].find( item => item.question === question );

attack( S, 'P6: a ticket to a parent node takes no person\'s time', () => {
	const d = day( { daily: 10 } );
	ask( d, 500, { to: 'parent' } );
	ask( d, 10 );
	assert.deepEqual( [ ...d.capacity.used ], [ [ '2026-11-04', 10 ] ] );
	assert.deepEqual( shown( d ), [ '500 minutes', '10 minutes' ] );
} );

attack( S, 'P6: within the day\'s capacity a ticket is shown at once, neither postponed nor marked', () => {
	const d = day();
	ask( d, 30 );
	ask( d, 30 );
	const _list = d.board.list();
	assert.deepEqual( _list.map( item => [ item.notBefore, item.overCapacity ] ), [ [ null, false ], [ null, false ] ] );
} );

attack( S, 'P6: with the day full a ticket whose deadline allows it waits for the next morning, unseen until then', () => {
	const d = day();
	ask( d, 40 );
	ask( d, 30 );
	assert.equal( ticket( d, '30 minutes' ).notBefore, NEXT_MORNING );
	assert.deepEqual( shown( d ), [ '40 minutes' ] );
	assert.deepEqual( d.board.bundles().map( item => item.minutes ), [ 40 ] );
	d.clock.now = Date.parse( NEXT_MORNING ) - 1;
	assert.deepEqual( shown( d ), [ '40 minutes' ] );
	d.clock.now += 1;
	assert.deepEqual( shown( d ), [ '40 minutes', '30 minutes' ] );
} );

attack( S, 'P6: with the day full and no time to wait, the ticket goes out at once, marked', () => {
	const d = day( { deadline: T0 + 20 * HOUR } );
	ask( d, 60 );
	ask( d, 5 );
	const _late = ticket( d, '5 minutes' );
	assert.deepEqual( [ _late.notBefore, _late.overCapacity ], [ null, true ] );
	assert.deepEqual( shown( d ), [ '60 minutes', '5 minutes' ] );
} );

attack( S, 'P6 at midnight: what was moved to the next day already counts when that day begins', () => {
	const d = day( { start: Date.parse( '2026-11-04T23:59:00Z' ) } );
	ask( d, 60 );
	ask( d, 30 );
	assert.equal( ticket( d, '30 minutes' ).notBefore, NEXT_MORNING );
	d.clock.now = Date.parse( '2026-11-05T00:01:00Z' );
	ask( d, 40 );
	assert.equal( ticket( d, '40 minutes' ).notBefore, '2026-11-06T08:00:00.000Z', 'the 30 postponed minutes plus 40 exceed the day' );
	assert.deepEqual( [ ...d.capacity.used ], [ [ '2026-11-04', 60 ], [ '2026-11-05', 30 ], [ '2026-11-06', 40 ] ] );
} );

attack( S, 'P6: a new day has its full capacity again', () => {
	const d = day();
	ask( d, 60 );
	d.clock.now = Date.parse( '2026-11-05T09:00:00Z' );
	ask( d, 60 );
	assert.equal( ticket( d, '60 minutes' ).notBefore, null );
	assert.equal( d.board.list().length, 2 );
} );

attack( S, 'P6: a ticket that names no minutes counts two of them', () => {
	const d = day( { daily: 3 } );
	d.board.ask( d.node, { question: 'default', options: [ 'ok' ] } );
	assert.deepEqual( [ ...d.capacity.used ], [ [ '2026-11-04', 2 ] ] );
} );

attack( S, 'P6: a ticket of zero minutes fits a full day', () => {
	const d = day();
	ask( d, 60 );
	ask( d, 0 );
	assert.equal( ticket( d, '0 minutes' ).notBefore, null );
	assert.equal( ticket( d, '0 minutes' ).overCapacity, false );
} );

attack( S, 'R3, P6: a postponed ticket still expires at its deadline, not before it was shown', () => {
	const d = day( { deadline: Date.parse( '2026-11-06T10:00:00Z' ) } );
	ask( d, 60 );
	const _waiting = ask( d, 30 );
	d.clock.now = Date.parse( '2026-11-05T07:00:00Z' );
	d.board.expire();
	assert.ok( ticket( d, '30 minutes' ), 'still open while it waits for its day' );
	d.clock.now = Date.parse( '2026-11-06T10:00:01Z' );
	d.board.expire();
	return _waiting.then( answer => assert.equal( answer.expired, true ) );
} );

attack( S, 'P6: a ticket with negative minutes frees no capacity for the others', () => {
	const d = day();
	tryIt( () => ask( d, -1000 ) );
	for ( let i = 0; i < 4; i++ ) {
		ask( d, 30, { question: `q${i}` } );
	}
	const _postponed = [ 'q0', 'q1', 'q2', 'q3' ].filter( question => ticket( d, question )?.notBefore );
	assert.equal( _postponed.length, 2, `${4 - _postponed.length} tickets of 30 minutes fit a day of 60` );
} );

attack( S, 'P6: a ticket with minutes that are no number never poisons a day\'s capacity', () => {
	const d = day();
	tryIt( () => ask( d, NaN ) );
	d.clock.now = Date.parse( '2026-11-05T09:00:00Z' );
	ask( d, 10, { question: 'next day' } );
	assert.equal( ticket( d, 'next day' ).notBefore, null, 'a 10-minute ticket did not fit an empty day' );
} );

attacks( S, [ 'Client', 'hr' ].map( to => ( { name: `P6: a ticket to a person named "${to}" counts against the capacity like any ticket to a person`, to } ) ),
	( { to } ) => {
		const d = day( { daily: 10 } );
		ask( d, 500, { to } );
		assert.notDeepEqual( [ ...d.capacity.used ], [], 'five hundred minutes of a person went past the capacity' );
	} );

attack( S, 'P6: the minutes of a bundle are those of the tickets a person sees today', () => {
	const d = day();
	ask( d, 50 );
	ask( d, 30 );
	ask( d, 5, { to: 'parent' } );
	assert.deepEqual( d.board.bundles().map( item => [ item.to, item.minutes ] ), [ [ 'client', 50 ], [ 'parent', 5 ] ] );
} );
