// Stress tests of the pot (5.4, P1–P6): prices, bookings, reservations of children, the round minimum and the cost
// estimate of a strategy. The pot is the only thing between a node and an overspent budget, so every hostile number
// that reaches it must leave a finite, non-negative, honest account.
import assert from 'node:assert/strict';
import { attack, attacks, random, hostile } from '../hostile.mjs';
import { Pot, Catalog, Mission, purse, node, kinds, memoryLog } from './kit.mjs';

const POT = 'core/budget/pot.js';
const catalog = Catalog.load( Mission.load( 'survey' ) );
const honest = total => !Number.isNaN( total ) && total >= 0;

// --- price ---

attack( POT, 'price of a missing move is the default of one unit (P2: every move has a price)', () => {
	assert.deepEqual( Pot.price( null ), { units: 1, humanMinutes: 0, total: 1 } );
	assert.deepEqual( Pot.price( undefined ), { units: 1, humanMinutes: 0, total: 1 } );
} );

attack( POT, 'price of a free move is zero, not the default', () => {
	assert.deepEqual( Pot.price( { price: 0 } ), { units: 0, humanMinutes: 0, total: 0 } );
} );

attack( POT, 'a human minute costs one unit and is kept apart from the units (P1, P5)', () => {
	assert.deepEqual( Pot.price( { price: 0.1, humanMinutes: 2 } ), { units: 0.1, humanMinutes: 2, total: 2.1 } );
	assert.equal( Pot.MINUTE, 1 );
} );

attack( POT, 'a price written as a numeric string is read as its number', () => {
	assert.equal( Pot.price( { price: '0.5', humanMinutes: '1' } ).total, 1.5 );
} );

attack( POT, 'the catalog\'s outward actions cost their human minute on top of the units', () => {
	assert.equal( Pot.price( catalog.get( 'report.send' ) ).total, 1.1 );
	assert.equal( Pot.price( Catalog.load( Mission.load( 'invoices' ) ).get( 'payment.send' ) ).humanMinutes, 2 );
	assert.equal( Pot.price( catalog.get( 'move.cancel' ) ).total, 0, 'a cancellation is free (E6)' );
} );

attacks( POT, [
	{ name: 'price NaN never yields a NaN total', price: NaN },
	{ name: 'price "abc" never yields a NaN total', price: 'abc' },
	{ name: 'price -1 never refunds the pot', price: -1 },
	{ name: 'price -1e308 never refunds the pot', price: -1e308 },
	{ name: 'price {} never yields a NaN total', price: {} },
	{ name: 'price Infinity is an infinite cost, never a refund', price: Infinity },
	{ name: 'price null falls back to the default', price: null },
], ( item ) => {
	assert.ok( honest( Pot.price( { price: item.price } ).total ), `total ${Pot.price( { price: item.price } ).total}` );
} );

attacks( POT, [
	{ name: 'human minutes -10 never refund the pot', minutes: -10 },
	{ name: 'human minutes NaN never yield a NaN total', minutes: NaN },
	{ name: 'human minutes 0.5 are half a unit', minutes: 0.5 },
], ( item ) => {
	const _price = Pot.price( { price: 0, humanMinutes: item.minutes } );
	assert.ok( honest( _price.total ), `total ${_price.total}` );
	assert.ok( honest( _price.humanMinutes ), `minutes ${_price.humanMinutes}` );
} );

// --- book ---

attack( POT, 'a booking adds units and minutes to spent and logs each part (P5)', () => {
	const _node = purse( 10 );
	const _total = Pot.book( _node, { what: 'report.send', units: 0.1, humanMinutes: 1, ms: 12 } );
	assert.equal( _total, 1.1 );
	assert.equal( _node.spent, 1.1 );
	assert.deepEqual( _node.costs, { units: 0.1, humanMinutes: 1, ms: 12 } );
	assert.deepEqual( _node.events[ 0 ], { kind: 'cost_booked', what: 'report.send', units: 0.1, humanMinutes: 1, ms: 12, total: 1.1, spent: 1.1, left: 8.9 } );
} );

attack( POT, '0.1 + 0.2 is booked as 0.3: the pot never carries floating noise', () => {
	const _node = purse( 1 );
	Pot.book( _node, { what: 'a', units: 0.1 } );
	Pot.book( _node, { what: 'b', units: 0.2 } );
	assert.equal( _node.spent, 0.3 );
	assert.equal( Pot.left( _node ), 0.7 );
} );

attack( POT, 'a thousand bookings of 0.001 add up to exactly one unit', () => {
	const _node = purse( 1 );
	for ( let i = 0; i < 1000; i++ ) {
		Pot.book( _node, { what: 'tick', units: 0.001 } );
	}
	assert.equal( _node.spent, 1 );
	assert.equal( Pot.left( _node ), 0 );
	assert.equal( _node.events.length, 1000, 'every booking is its own event (P5)' );
} );

attack( POT, 'a negative booking never lowers what was spent', () => {
	const _node = purse( 5, { spent: 4 } );
	Pot.book( _node, { what: 'refund', units: -3 } );
	assert.ok( _node.spent >= 4, `spent fell to ${_node.spent}` );
} );

attack( POT, 'a NaN booking never disables the budget check (Z6)', () => {
	const _node = purse( 1, { spent: 2 } );
	Pot.book( _node, { what: 'broken', units: NaN } );
	assert.ok( Pot.left( _node ) < 0, `left is ${Pot.left( _node )}: an overspent node must stay overspent` );
} );

attack( POT, 'an infinite booking exhausts the budget for good', () => {
	const _node = purse( 1e9 );
	Pot.book( _node, { what: 'endless', units: Infinity } );
	assert.ok( Pot.left( _node ) < 0 );
} );

attack( POT, 'the duration is logged but never counts as cost (P5: only the sum of units and minutes counts)', () => {
	const _node = purse( 1 );
	Pot.book( _node, { what: 'slow', units: 0, ms: 3600000 } );
	assert.equal( _node.spent, 0 );
	assert.equal( _node.costs.ms, 3600000 );
} );

attack( POT, 'a booking on a real node is an event in the log with what is left', () => {
	const _log = memoryLog();
	const _node = node( { log: _log } );
	Pot.book( _node, { what: 'analysis.run', units: 0.05 } );
	const [ _booked ] = kinds( _log, _node, 'cost_booked' );
	assert.equal( _booked.left, Pot.round( _node.contract.budget - 0.05 ) );
} );

// --- left ---

attack( POT, 'left counts the reservations of children, missing ones as zero', () => {
	assert.equal( Pot.left( purse( 10, { spent: 2, reserved: 3 } ) ), 5 );
	assert.equal( Pot.left( { contract: { budget: 10 }, spent: 2 } ), 8 );
} );

attack( POT, 'an overspent node has a negative left, never a clamped zero (Z6 needs the sign)', () => {
	assert.equal( Pot.left( purse( 1, { spent: 1.5 } ) ), -0.5 );
} );

attack( POT, 'a budget of zero leaves nothing at the start', () => {
	assert.equal( Pot.left( purse( 0 ) ), 0 );
} );

// --- reserve ---

attack( POT, 'a child may reserve exactly what is left (P4)', () => {
	const _parent = purse( 10, { spent: 4 } );
	assert.equal( Pot.reserve( _parent, 6 ), true );
	assert.equal( Pot.left( _parent ), 0 );
	assert.equal( _parent.events.at( -1 ).kind, 'budget_reserved' );
} );

attack( POT, 'a reservation one thousandth above what is left is refused and changes nothing', () => {
	const _parent = purse( 10, { spent: 4 } );
	assert.equal( Pot.reserve( _parent, 6.001 ), false );
	assert.equal( _parent.reserved, 0 );
	assert.equal( _parent.events.length, 0 );
} );

attack( POT, 'reserving 0.1 + 0.2 from 0.3 left succeeds: the pot counts in rounded units', () => {
	assert.equal( Pot.reserve( purse( 0.3 ), 0.1 + 0.2 ), true );
} );

attack( POT, 'a reservation of zero is allowed and reserves nothing', () => {
	const _parent = purse( 5 );
	assert.equal( Pot.reserve( _parent, 0 ), true );
	assert.equal( Pot.left( _parent ), 5 );
} );

attack( POT, 'a negative reservation never raises what the parent has left (P4)', () => {
	const _parent = purse( 10 );
	Pot.reserve( _parent, -5 );
	assert.ok( Pot.left( _parent ) <= 10, `left grew to ${Pot.left( _parent )}` );
} );

attack( POT, 'a NaN reservation is refused and never poisons the parent\'s account', () => {
	const _parent = purse( 10 );
	assert.equal( Pot.reserve( _parent, NaN ), false );
	assert.equal( Pot.left( _parent ), 10 );
} );

attack( POT, 'an infinite reservation is refused', () => {
	assert.equal( Pot.reserve( purse( 1e12 ), Infinity ), false );
} );

attack( POT, 'nothing can be reserved from an overspent parent, not even zero', () => {
	assert.equal( Pot.reserve( purse( 1, { spent: 2 } ), 0 ), false );
} );

attack( POT, 'fuzz: 500 random reservations and bookings never reserve more than the parent had left (seed 7)', () => {
	const _rand = random( 7 );
	const _parent = purse( 100 );
	for ( let i = 0; i < 500; i++ ) {
		const _amount = Pot.round( _rand() * 20 );
		const _before = Pot.left( _parent );
		if ( _rand() < 0.5 ) {
			const _ok = Pot.reserve( _parent, _amount );
			assert.equal( _ok, _amount <= _before, `step ${i}: ${_amount} of ${_before}` );
			assert.ok( Pot.left( _parent ) >= 0 || !_ok, `step ${i}: a reservation drove left below zero` );
		} else if ( _parent.reserved > 0 ) {
			Pot.release( _parent, { id: `c${i}`, contract: { budget: Math.min( _amount, _parent.reserved ) }, spent: 0 } );
		}
	}
	assert.ok( _parent.reserved <= 100 );
} );

// --- release ---

attack( POT, 'a released child returns its rest and its spending becomes the parent\'s (P4)', () => {
	const _parent = purse( 10 );
	Pot.reserve( _parent, 6 );
	Pot.release( _parent, { id: 'c1', contract: { budget: 6 }, spent: 2.5, costs: { units: 0.5, humanMinutes: 2, ms: 9 } } );
	assert.equal( _parent.reserved, 0 );
	assert.equal( _parent.spent, 2.5 );
	assert.equal( Pot.left( _parent ), 7.5 );
	assert.deepEqual( _parent.events.at( -1 ), { kind: 'budget_returned', child: 'c1', returned: 3.5, left: 7.5 } );
} );

attack( POT, 'a child that overspent its reservation is charged in full to the parent', () => {
	const _parent = purse( 10 );
	Pot.reserve( _parent, 2 );
	Pot.release( _parent, { id: 'c1', contract: { budget: 2 }, spent: 5, costs: { units: 5, humanMinutes: 0, ms: 0 } } );
	assert.equal( _parent.spent, 5 );
	assert.equal( _parent.events.at( -1 ).returned, -3 );
} );

attack( POT, 'a release without a reservation never drives reserved below zero', () => {
	const _parent = purse( 10 );
	Pot.release( _parent, { id: 'c1', contract: { budget: 4 }, spent: 0 } );
	assert.equal( _parent.reserved, 0 );
	assert.equal( Pot.left( _parent ), 10 );
} );

attack( POT, 'a child that never booked anything costs the parent nothing on release', () => {
	const _parent = purse( 3 );
	Pot.reserve( _parent, 3 );
	Pot.release( _parent, { id: 'c1', contract: { budget: 3 }, spent: 0 } );
	assert.equal( _parent.spent, 0 );
	assert.equal( Pot.left( _parent ), 3 );
} );

attack( POT, 'after a reallocation (5.4) a release frees only that child\'s rest, never the reservation of an open sibling', () => {
	const _parent = purse( 30 );
	const _a = { id: 'a', contract: { budget: 10 }, spent: 4, state: 'closed', costs: { units: 4, humanMinutes: 0, ms: 0 } };
	const _b = { id: 'b', contract: { budget: 10 }, spent: 0, state: 'executing' };
	Pot.reserve( _parent, 10 );
	Pot.reserve( _parent, 10 );
	// What Runner.reallocate does at a judgment while both children are open.
	_parent.reserved = Pot.round( ( 10 - _a.spent ) + ( 10 - _b.spent ) );
	Pot.release( _parent, _a );
	assert.equal( Pot.left( _parent ), 30 - 4 - 10, 'the open sibling still needs its 10' );
} );

// --- the round minimum (P3) ---

attack( POT, 'a round that cost less than one unit is booked up to one (P3)', () => {
	const _node = purse( 10, { spent: 0.3 } );
	assert.equal( Pot.closeRound( _node, 0 ), 1 );
	assert.equal( _node.spent, 1 );
	assert.equal( _node.events.at( -1 ).what, 'round minimum' );
} );

attack( POT, 'a round of exactly one unit books nothing more', () => {
	const _node = purse( 10, { spent: 3 } );
	assert.equal( Pot.closeRound( _node, 2 ), 1 );
	assert.equal( _node.events.length, 0 );
} );

attack( POT, 'a round of 0.999 is topped up by exactly 0.001', () => {
	const _node = purse( 10, { spent: 0.999 } );
	Pot.closeRound( _node, 0 );
	assert.equal( _node.events.at( -1 ).units, 0.001 );
	assert.equal( _node.spent, 1 );
} );

attack( POT, 'a round that cost nothing still costs one unit', () => {
	const _node = purse( 10, { spent: 5 } );
	assert.equal( Pot.closeRound( _node, 5 ), 1 );
	assert.equal( _node.spent, 6 );
} );

attack( POT, 'a round above the minimum is returned as it was and never rounded down', () => {
	const _node = purse( 10, { spent: 7.25 } );
	assert.equal( Pot.closeRound( _node, 2 ), 5.25 );
} );

attack( POT, 'the round minimum may overspend a node with nothing left: the budget check then aborts it (Z6)', () => {
	const _node = purse( 1, { spent: 0.8 } );
	Pot.closeRound( _node, 0.5 );
	assert.equal( _node.spent, 1.5 );
	assert.ok( Pot.left( _node ) < 0 );
} );

// --- the estimate k(s) of chapter 19 ---

attack( POT, 'k(s) is never below what its moves cost by the catalog', () => {
	const _strategy = { price: 0.1, steps: [ { move: 'report.draft' }, { move: 'report.send' } ] };
	assert.equal( Pot.strategyCost( _strategy, catalog ), 1.6 );
} );

attack( POT, 'k(s) takes the strategy\'s own estimate when it is higher', () => {
	assert.equal( Pot.strategyCost( { price: 3, steps: [ { move: 'analysis.run' } ] }, catalog ), 3 );
} );

attack( POT, 'k(s) of a strategy without steps or price is the round minimum', () => {
	assert.equal( Pot.strategyCost( {}, catalog ), 1 );
} );

attack( POT, 'an unknown move in a strategy is priced at the default, never at zero', () => {
	assert.equal( Pot.strategyCost( { steps: [ { move: 'invented.move' }, { move: 'invented.move' } ] }, catalog ), 2 );
} );

attack( POT, 'without a catalog every step costs the default unit', () => {
	assert.equal( Pot.strategyCost( { steps: [ { move: 'a' }, { move: 'b' }, { move: 'c' } ] }, null ), 3 );
} );

attack( POT, 'a negative strategy price never lowers k(s) below its moves', () => {
	assert.equal( Pot.strategyCost( { price: -50, steps: [ { move: 'report.send' } ] }, catalog ), 1.1 );
} );

attack( POT, 'a non-numeric strategy price never makes k(s) NaN', () => {
	const _cost = Pot.strategyCost( { price: 'cheap', steps: [ { move: 'report.send' } ] }, catalog );
	assert.ok( Number.isFinite( _cost ) && _cost >= 1.1, `k(s) = ${_cost}` );
} );

attack( POT, 'k(s) of a strategy of ten thousand steps is their exact sum', () => {
	const _steps = Array.from( { length: 10000 }, () => ( { move: 'analysis.run' } ) );
	assert.equal( Pot.strategyCost( { steps: _steps }, catalog ), 500 );
} );

// --- round ---

attacks( POT, hostile( 'numbers' ).map( item => ( { ...item, name: `round keeps ${item.label} within a thousandth or NaN as NaN` } ) ), ( item ) => {
	const _rounded = Pot.round( item.value );
	if ( Number.isNaN( item.value ) ) {
		assert.ok( Number.isNaN( _rounded ) );
	} else if ( Math.abs( item.value ) < 1e15 ) {
		assert.ok( Math.abs( _rounded - item.value ) <= 0.0005, `${item.value} → ${_rounded}` );
	} else {
		assert.equal( Math.sign( _rounded ), Math.sign( item.value ), `${item.value} → ${_rounded}` );
	}
} );
