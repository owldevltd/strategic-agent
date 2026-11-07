// Stress tests of core/inbound/expectations.js, part two: waiting. A timeout is a result, not an error (8.2); a late
// fact still counts (E4, B8); nothing waits forever and nothing is met without an answer.
import assert from 'node:assert/strict';
import { attack, attacks, within } from '../hostile.mjs';
import { Expectations, memoryDb, fakeNode, tryIt, sleep, T0, HOUR } from './rig.mjs';

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

attack( S, 'R3: a node already past its deadline gives an expectation that is due at once', async () => {
	const { ex } = store( { real: true } );
	const _made = open( ex, nodeUntil( Date.now() - HOUR ) );
	assert.ok( Date.parse( _made.until ) < Date.now() );
	assert.equal( ( await within( ex.wait( _made.id, { pollMs: 5 } ), 500 ) ).status, 'timed_out' );
} );

attack( S, '8.2: negative minutes make the expectation due at once; no reaction is a timeout, never a match', async () => {
	const { ex } = store( { real: true } );
	const _made = open( ex, nodeUntil( Date.now() + HOUR ), { minutes: -5 } );
	const _result = await within( ex.wait( _made.id, { pollMs: 5 } ), 500 );
	assert.deepEqual( _result, { status: 'timed_out', count: 0, need: 1 } );
	assert.equal( ex.get( _made.id ).status, 'timed_out' );
} );

attack( S, 'E4: a fact after the deadline is late but valid; the timed-out expectation is then met by waiting', async () => {
	const { ex, db } = store( { real: true } );
	const _made = open( ex, nodeUntil( Date.now() + HOUR ), { minutes: -1 } );
	db.run( 'UPDATE expectations SET status = \'timed_out\' WHERE id = :id', { id: _made.id } );
	assert.equal( ex.record( _made.id, { origin: 'o1', fact: 'f' } ).late, true );
	assert.equal( ex.get( _made.id ).status, 'timed_out', 'record alone does not move a timed-out expectation' );
	assert.equal( ( await within( ex.wait( _made.id, { pollMs: 5 } ), 500 ) ).status, 'met' );
} );

attacks( S, [ 0, -1 ].map( need => ( { name: `8.2: need ${need} is no way to be met without a single answer`, need } ) ), async ( { need } ) => {
	const { ex } = store( { real: true } );
	const _made = tryIt( () => open( ex, nodeUntil( Date.now() + HOUR ), { need, minutes: 0.0005 } ) );
	if ( _made.error ) { return; }
	const _result = await within( ex.wait( _made.value.id, { pollMs: 5 } ), 1000 );
	assert.notEqual( _result.status, 'met', 'no answer arrived; that is a timeout, not a match' );
} );

attack( S, 'create: need given as text counts as the number it names', () => {
	const { ex } = store();
	const _made = open( ex, nodeUntil(), { need: '2' } );
	ex.record( _made.id, { origin: 'o1', fact: 'f' } );
	assert.equal( ex.get( _made.id ).status, 'open' );
	ex.record( _made.id, { origin: 'o2', fact: 'f' } );
	assert.equal( ex.get( _made.id ).status, 'met' );
} );

attack( S, 'wait: met at once when the facts are already there', async () => {
	const { ex } = store( { real: true } );
	const _made = open( ex, nodeUntil( Date.now() + HOUR ) );
	ex.record( _made.id, { origin: 'o1', fact: 'f' } );
	assert.deepEqual( await within( ex.wait( _made.id, { pollMs: 5 } ), 200 ), { status: 'met', count: 1, need: 1 } );
} );

attack( S, 'wait: times out at the given time and marks the expectation timed out', async () => {
	const { ex } = store( { real: true } );
	const _made = open( ex, nodeUntil( Date.now() + HOUR ) );
	const _result = await within( ex.wait( _made.id, { until: new Date( Date.now() + 15 ).toISOString(), pollMs: 5 } ), 500 );
	assert.equal( _result.status, 'timed_out' );
	assert.equal( ex.get( _made.id ).status, 'timed_out' );
} );

attack( S, 'wait: waiting longer never moves the expectation\'s own deadline; what comes after it is still late', async () => {
	const { ex } = store( { real: true } );
	const _made = open( ex, nodeUntil( Date.now() + HOUR ), { minutes: 0.0002 } );
	const _waiting = ex.wait( _made.id, { until: new Date( Date.now() + 2000 ).toISOString(), pollMs: 5 } );
	await sleep( 30 );
	assert.equal( ex.record( _made.id, { origin: 'o1', fact: 'f' } ).late, true );
	assert.equal( ( await within( _waiting, 500 ) ).status, 'met' );
	assert.equal( Date.parse( ex.get( _made.id ).until ), Date.parse( _made.until ) );
} );

attack( S, 'wait: stop() ends the wait as stopped and leaves the expectation open for a late answer', async () => {
	const { ex } = store( { real: true } );
	const _made = open( ex, nodeUntil( Date.now() + HOUR ) );
	let _stop = false;
	setTimeout( () => {
		_stop = true;
	}, 10 );
	const _result = await within( ex.wait( _made.id, { stop: () => _stop, pollMs: 5 } ), 500 );
	assert.equal( _result.status, 'stopped' );
	assert.equal( ex.get( _made.id ).status, 'open' );
} );

attack( S, 'wait: a fact wakes the waiter at once, not at the next poll', async () => {
	const { ex } = store( { real: true } );
	const _made = open( ex, nodeUntil( Date.now() + HOUR ) );
	const _started = Date.now();
	const _waiting = ex.wait( _made.id, { pollMs: 400 } );
	setTimeout( () => ex.record( _made.id, { origin: 'o1', fact: 'f' } ), 5 );
	assert.equal( ( await within( _waiting, 1000 ) ).status, 'met' );
	assert.ok( Date.now() - _started < 300, `woke after ${Date.now() - _started} ms` );
} );

attack( S, 'wait: a fact for another expectation never ends this wait', async () => {
	const { ex } = store( { real: true } );
	const _mine = open( ex, nodeUntil( Date.now() + HOUR ) );
	const _other = open( ex, nodeUntil( Date.now() + HOUR ) );
	const _waiting = ex.wait( _mine.id, { until: new Date( Date.now() + 40 ).toISOString(), pollMs: 5 } );
	setTimeout( () => ex.record( _other.id, { origin: 'o1', fact: 'f' } ), 5 );
	assert.equal( ( await within( _waiting, 500 ) ).status, 'timed_out' );
} );

attack( S, 'wait: an unknown expectation fails at once instead of hanging', async () => {
	const { ex } = store( { real: true } );
	await assert.rejects( within( ex.wait( 'ex-nothing', { pollMs: 5 } ), 200 ), error => !/did not settle/.test( error.message ) );
} );

attack( S, 'wait: no listener is left behind once a wait has ended', async () => {
	const { ex } = store( { real: true } );
	const _made = open( ex, nodeUntil( Date.now() + HOUR ) );
	await within( ex.wait( _made.id, { until: new Date( Date.now() + 20 ).toISOString(), pollMs: 10 } ), 500 );
	await sleep( 40 );
	assert.equal( ex._bus._handlers.get( 'fact' )?.size ?? 0, 0 );
} );

attack( S, 'wait: twenty waiters on one expectation all end met after a single fact', async () => {
	const { ex } = store( { real: true } );
	const _made = open( ex, nodeUntil( Date.now() + HOUR ) );
	const _waiting = Array.from( { length: 20 }, () => ex.wait( _made.id, { pollMs: 50 } ) );
	setTimeout( () => ex.record( _made.id, { origin: 'o1', fact: 'f' } ), 5 );
	const _results = await within( Promise.all( _waiting ), 1000 );
	assert.ok( _results.every( item => item.status === 'met' ) );
} );
