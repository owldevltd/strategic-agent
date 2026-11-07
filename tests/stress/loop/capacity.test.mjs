// Stress tests of the daily capacity of people (P6, 5.2): a large pot must not buy a person's whole day. Every ticket's
// minutes are counted against its day; a full day postpones the ticket to the next one if its deadline allows,
// otherwise the ticket goes out marked. Attacks: day and year boundaries, hostile minutes and deadlines, overbooking.
import assert from 'node:assert/strict';
import { attack, attacks, random, hostile } from '../hostile.mjs';
import { Capacity, Board, memoryLog, node } from './kit.mjs';

const CAP = 'core/budget/capacity.js';
const at = iso => Date.parse( iso );
const H = 3600000;

// A capacity whose clock the test moves.
function clock( iso, options = { dailyMinutes: 60, dayStartsHour: 8 } ) {
	const _clock = { now: at( iso ) };
	const _capacity = new Capacity( options, () => _clock.now );
	return { capacity: _capacity, clock: _clock };
}

// P6 as an invariant: every day's minutes are finite and not negative, and no day holds more than its capacity unless
// a marked ticket (one that could not wait) went onto it.
function sane( capacity, marked = new Set() ) {
	for ( const [ day, used ] of capacity.used ) {
		assert.equal( typeof used, 'number', `${day}: ${JSON.stringify( used )} is not a number of minutes` );
		assert.ok( Number.isFinite( used ) && used >= 0, `${day}: ${used} minutes` );
		assert.ok( used <= capacity.dailyMinutes || marked.has( day ), `${day}: ${used} of ${capacity.dailyMinutes} minutes without a marked ticket` );
	}
}

attack( CAP, 'a ticket within the day\'s capacity goes out at once and is counted', () => {
	const { capacity } = clock( '2026-11-04T10:00:00Z' );
	assert.deepEqual( capacity.take( 20 ), { ok: true, used: 20, of: 60 } );
	assert.deepEqual( capacity.take( 15 ), { ok: true, used: 35, of: 60 } );
} );

attack( CAP, 'a ticket that fills the day exactly still goes out', () => {
	const { capacity } = clock( '2026-11-04T10:00:00Z' );
	capacity.take( 45 );
	assert.equal( capacity.take( 15 ).ok, true );
	assert.equal( capacity.used.get( '2026-11-04' ), 60 );
} );

attack( CAP, 'one minute over a full day postpones the ticket to the next day\'s start when its deadline allows', () => {
	const { capacity } = clock( '2026-11-04T10:00:00Z' );
	capacity.take( 60 );
	assert.deepEqual( capacity.take( 1, '2026-11-06T00:00:00Z' ), { notBefore: '2026-11-05T08:00:00.000Z', used: 60, of: 60 } );
	assert.equal( capacity.used.get( '2026-11-05' ), 1, 'the minutes count on the day the ticket appears' );
} );

attack( CAP, 'a full day with a deadline before the next day marks the ticket and counts it today', () => {
	const { capacity } = clock( '2026-11-04T10:00:00Z' );
	capacity.take( 60 );
	assert.deepEqual( capacity.take( 5, '2026-11-04T18:00:00Z' ), { marked: true, used: 65, of: 60 } );
} );

attack( CAP, 'a ticket without a deadline cannot wait: it goes out marked', () => {
	const { capacity } = clock( '2026-11-04T10:00:00Z' );
	capacity.take( 60 );
	assert.equal( capacity.take( 5 ).marked, true );
} );

attack( CAP, 'a deadline exactly one hour after the next day\'s start is too close to wait for it', () => {
	const { capacity } = clock( '2026-11-04T10:00:00Z' );
	capacity.take( 60 );
	assert.equal( capacity.take( 5, '2026-11-05T09:00:00.000Z' ).marked, true );
} );

attack( CAP, 'a deadline one millisecond later lets the ticket wait for the next day', () => {
	const { capacity } = clock( '2026-11-04T10:00:00Z' );
	capacity.take( 60 );
	assert.equal( capacity.take( 5, '2026-11-05T09:00:00.001Z' ).notBefore, '2026-11-05T08:00:00.000Z' );
} );

attack( CAP, 'the last millisecond of a day and the first of the next count on different days', () => {
	const { capacity, clock: _clock } = clock( '2026-11-04T23:59:59.999Z' );
	capacity.take( 60 );
	_clock.now = at( '2026-11-05T00:00:00.000Z' );
	assert.deepEqual( capacity.take( 60 ), { ok: true, used: 60, of: 60 } );
} );

attack( CAP, 'a full New Year\'s Eve postpones to the first of January of the next year', () => {
	const { capacity } = clock( '2026-12-31T22:00:00Z' );
	capacity.take( 60 );
	assert.equal( capacity.take( 10, '2027-01-03T00:00:00Z' ).notBefore, '2027-01-01T08:00:00.000Z' );
} );

attack( CAP, 'a full 28 February of a leap year postpones to the 29th', () => {
	const { capacity } = clock( '2028-02-28T12:00:00Z' );
	capacity.take( 60 );
	assert.equal( capacity.take( 10, '2028-03-05T00:00:00Z' ).notBefore, '2028-02-29T08:00:00.000Z' );
} );

attack( CAP, 'a full 28 February of a common year postpones to the 1st of March', () => {
	const { capacity } = clock( '2027-02-28T12:00:00Z' );
	capacity.take( 60 );
	assert.equal( capacity.take( 10, '2027-03-05T00:00:00Z' ).notBefore, '2027-03-01T08:00:00.000Z' );
} );

attack( CAP, 'postponed minutes take their room on the next day; a ticket that arrives there finds less', () => {
	const { capacity, clock: _clock } = clock( '2026-11-04T10:00:00Z' );
	capacity.take( 60 );
	capacity.take( 40, '2026-11-08T00:00:00Z' );
	_clock.now = at( '2026-11-05T09:00:00Z' );
	assert.equal( capacity.take( 30, '2026-11-05T12:00:00Z' ).marked, true, '40 + 30 does not fit into 60' );
} );

attack( CAP, 'postponed tickets never overbook the next day: what does not fit there waits longer or is marked', () => {
	const { capacity } = clock( '2026-11-04T10:00:00Z' );
	const _marked = new Set();
	capacity.take( 60 );
	for ( const minutes of [ 50, 50, 50 ] ) {
		const _result = capacity.take( minutes, '2026-11-20T00:00:00Z' );
		if ( _result.marked ) { _marked.add( '2026-11-04' ); }
	}
	sane( capacity, _marked );
} );

attack( CAP, 'a ticket of zero minutes goes out even on a full day', () => {
	const { capacity } = clock( '2026-11-04T10:00:00Z' );
	capacity.take( 60 );
	assert.equal( capacity.take( 0 ).ok, true );
} );

attack( CAP, 'a ticket of minutes written as a string is counted as a number, never concatenated', () => {
	const { capacity } = clock( '2026-11-04T10:00:00Z' );
	capacity.take( '30' );
	capacity.take( 20 );
	sane( capacity );
	assert.equal( capacity.used.get( '2026-11-04' ), 50 );
} );

attack( CAP, 'a day with no capacity has room on no later day either: every ticket of a person goes out marked at once', () => {
	const { capacity } = clock( '2026-11-04T10:00:00Z', { dailyMinutes: 0, dayStartsHour: 8 } );
	assert.equal( capacity.take( 1, '2026-11-10T00:00:00Z' ).marked, true );
	assert.equal( capacity.take( 1, '2026-11-04T11:00:00Z' ).marked, true );
	assert.equal( capacity.take( 0, '2026-11-10T00:00:00Z' ).ok, true, 'a ticket of no minutes still fits' );
} );

attack( CAP, 'a day that starts at midnight postpones to 00:00 of the next day', () => {
	const { capacity } = clock( '2026-11-04T10:00:00Z', { dailyMinutes: 10, dayStartsHour: 0 } );
	capacity.take( 10 );
	assert.equal( capacity.take( 1, '2026-11-09T00:00:00Z' ).notBefore, '2026-11-05T00:00:00.000Z' );
} );

attack( CAP, 'a day that starts at 23:00 postpones to 23:00 of the next day, never into the past', () => {
	const { capacity } = clock( '2026-11-04T10:00:00Z', { dailyMinutes: 10, dayStartsHour: 23 } );
	capacity.take( 10 );
	const _result = capacity.take( 1, '2026-11-09T00:00:00Z' );
	assert.equal( _result.notBefore, '2026-11-05T23:00:00.000Z' );
	assert.ok( at( _result.notBefore ) > at( '2026-11-04T10:00:00Z' ) );
} );

attack( CAP, 'separate days keep separate counts; a busy Monday does not fill Tuesday', () => {
	const { capacity, clock: _clock } = clock( '2026-11-02T10:00:00Z' );
	capacity.take( 55 );
	_clock.now = at( '2026-11-03T10:00:00Z' );
	assert.deepEqual( capacity.take( 55 ), { ok: true, used: 55, of: 60 } );
	assert.deepEqual( [ ...capacity.used ], [ [ '2026-11-02', 55 ], [ '2026-11-03', 55 ] ] );
} );

attack( CAP, 'the day is the UTC calendar day of the moment the ticket is asked', () => {
	assert.equal( Capacity.day( at( '2026-11-04T23:30:00-02:00' ) ), '2026-11-05' );
	assert.equal( Capacity.day( at( '2026-11-04T00:30:00+14:00' ) ), '2026-11-03' );
} );

attack( CAP, 'a broken clock is refused: no minutes are counted on an invalid day', () => {
	const _capacity = new Capacity( {}, () => NaN );
	assert.throws( () => _capacity.take( 5 ), RangeError );
	assert.equal( _capacity.used.size, 0 );
} );

attack( CAP, 'the base setup sets 60 minutes a day starting at 08:00', () => {
	const _capacity = Capacity.load();
	assert.equal( _capacity.dailyMinutes, 60 );
	assert.equal( _capacity.dayStartsHour, 8 );
} );

attack( CAP, 'a missing base setup falls back to 60 minutes from 08:00 instead of failing', () => {
	const _capacity = Capacity.load( 'catalog/no-such-base.json' );
	assert.deepEqual( [ _capacity.dailyMinutes, _capacity.dayStartsHour ], [ 60, 8 ] );
} );

attack( CAP, 'the default constructor has the paper\'s values and its own clock', () => {
	const _capacity = new Capacity();
	assert.deepEqual( [ _capacity.dailyMinutes, _capacity.dayStartsHour ], [ 60, 8 ] );
	assert.ok( Math.abs( _capacity.now() - Date.now() ) < 1000 );
} );

attack( CAP, 'fuzz: tickets that cannot wait never push a day past its capacity except as marked (seed 11)', () => {
	const _rand = random( 11 );
	const { capacity, clock: _clock } = clock( '2026-11-02T00:00:00Z' );
	const _marked = new Set();
	for ( let i = 0; i < 400; i++ ) {
		_clock.now = at( '2026-11-02T00:00:00Z' ) + Math.floor( _rand() * 7 * 24 ) * H;
		const _result = capacity.take( _rand.int( 0, 25 ), new Date( _clock.now + 30 * 60000 ).toISOString() );
		assert.ok( !_result.notBefore, 'a deadline in half an hour never waits for the next day' );
		if ( _result.marked ) { _marked.add( Capacity.day( _clock.now ) ); }
	}
	sane( capacity, _marked );
} );

attack( CAP, 'fuzz: a ticket is never postponed past its own deadline (R3) (seed 23)', () => {
	const _rand = random( 23 );
	const { capacity, clock: _clock } = clock( '2026-11-02T09:00:00Z', { dailyMinutes: 30, dayStartsHour: 8 } );
	for ( let i = 0; i < 300; i++ ) {
		_clock.now += _rand.int( 0, 3 ) * H;
		const _deadline = new Date( _clock.now + _rand.int( 1, 72 ) * H ).toISOString();
		const _result = capacity.take( _rand.int( 1, 20 ), _deadline );
		if ( _result.notBefore ) {
			assert.ok( at( _result.notBefore ) + H < at( _deadline ), `${_result.notBefore} for a deadline ${_deadline}` );
		}
	}
} );

attacks( CAP, hostile( 'dates' ).map( item => ( { ...item, name: `a hostile deadline ${item.label} never postpones a ticket past it` } ) ), ( item ) => {
	const { capacity } = clock( '2026-11-04T10:00:00Z' );
	capacity.take( 60 );
	const _result = capacity.take( 10, item.value );
	assert.ok( _result.marked || _result.notBefore, 'a full day either postpones or marks' );
	if ( _result.notBefore ) {
		assert.ok( at( _result.notBefore ) < at( item.value ), `${_result.notBefore} is after the deadline ${item.value}` );
	}
} );

attacks( CAP, hostile( 'numbers' ).map( item => ( {
	...item, name: `hostile minutes ${String( item.value )} leave every day a finite count within capacity`,
} ) ), ( item ) => {
	const { capacity } = clock( '2026-11-04T10:00:00Z' );
	const _marked = new Set();
	capacity.take( 30 );
	const _result = capacity.take( item.value, '2026-11-20T00:00:00Z' );
	if ( _result.marked ) { _marked.add( '2026-11-04' ); }
	capacity.take( 10, '2026-11-20T00:00:00Z' );
	sane( capacity, _marked );
	const _honest = [ ...capacity.used.values() ].reduce( ( sum, used ) => sum + used, 0 );
	assert.ok( _honest >= 40, `the honest tickets took 40 minutes, the days count ${_honest}` );
} );

attack( CAP, 'a single ticket longer than a whole day is never postponed onto a day it cannot fit into', () => {
	const { capacity } = clock( '2026-11-04T10:00:00Z' );
	const _result = capacity.take( 90, '2026-11-20T00:00:00Z' );
	const _marked = new Set( _result.marked ? [ '2026-11-04' ] : [] );
	sane( capacity, _marked );
} );

// --- the capacity as the board applies it (8.4, P6) ---

function board( iso, dailyMinutes = 10 ) {
	const _clock = { now: at( iso ) };
	const _capacity = new Capacity( { dailyMinutes, dayStartsHour: 8 }, () => _clock.now );
	const _board = new Board( memoryLog(), { capacity: _capacity, now: () => _clock.now, sweepMs: 60000 } );
	return { board: _board, clock: _clock, capacity: _capacity };
}

attack( CAP, 'a postponed ticket is hidden from the person until its day starts, then shown', () => {
	const { board: _board, clock: _clock } = board( '2026-11-04T10:00:00Z' );
	const _node = node( { hours: 24 * 7 } );
	_board.ask( _node, { question: 'a', options: [ 'ok' ], minutes: 10 } );
	_board.ask( _node, { question: 'b', options: [ 'ok' ], minutes: 5 } );
	assert.deepEqual( _board.list().map( ticket => ticket.question ), [ 'a' ] );
	_clock.now = at( '2026-11-05T08:00:00Z' );
	assert.deepEqual( _board.list().map( ticket => ticket.question ), [ 'a', 'b' ] );
} );

attack( CAP, 'a ticket that cannot wait is shown at once and marked as over capacity', () => {
	const { board: _board } = board( '2026-11-04T10:00:00Z' );
	// The node's deadline on the board's own clock: two hours after it, whatever day the test runs.
	const _node = node( { over: { deadline: '2026-11-04T12:00:00Z' } } );
	_board.ask( _node, { question: 'a', options: [ 'ok' ], minutes: 10 } );
	_board.ask( _node, { question: 'urgent', options: [ 'ok' ], minutes: 5 } );
	const _urgent = _board.list().find( ticket => ticket.question === 'urgent' );
	assert.equal( _urgent.overCapacity, true );
	assert.equal( _urgent.notBefore, null );
} );

attack( CAP, 'a ticket to a parent node takes no person\'s minutes', () => {
	const { board: _board, capacity } = board( '2026-11-04T10:00:00Z' );
	_board.ask( node(), { question: 'to parent', options: [ 'stop' ], minutes: 500, to: 'parent' } );
	assert.equal( capacity.used.size, 0 );
} );

attack( CAP, 'the ticket\'s deadline for the capacity is never later than its node\'s (R3)', () => {
	const { board: _board, capacity } = board( '2026-11-04T10:00:00Z' );
	const _node = node( { over: { deadline: '2026-11-04T13:00:00Z' } } );
	_board.ask( _node, { question: 'a', options: [ 'ok' ], minutes: 10 } );
	_board.ask( _node, { question: 'late', options: [ 'ok' ], minutes: 5, deadline: '2026-12-31T00:00:00Z' } );
	assert.equal( _board.list().find( ticket => ticket.question === 'late' ).overCapacity, true, 'the node\'s deadline does not allow the next day' );
	assert.equal( capacity.used.get( '2026-11-04' ), 15 );
} );
