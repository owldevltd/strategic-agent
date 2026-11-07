// core/learn/journal.js under attack, part 2: signals and late effects (B8, L5), the observation and its censoring by
// contacts and the horizon (L2), at the edges of time, with hostile ids and listeners that fail.
import assert from 'node:assert/strict';
import { attack, attacks, hostile } from '../hostile.mjs';
import { journal, jnode, HOUR } from './kit.mjs';

const S = 'core/learn/journal.js';
const told = ( j ) => {
	const _list = [];
	j.listen( ( attempt, change, reason ) => _list.push( { attempt, change, reason } ) );
	return _list;
};

attack( S, 'L2: the first signal of a running attempt is kept with its time; a second one changes nothing', () => {
	const { journal: _j, clock } = journal();
	const _heard = told( _j );
	const _id = _j.start( jnode( 'n1' ), { id: 'mail' } );
	clock.now += 3 * HOUR;
	assert.deepEqual( _j.signal( _id ), { signalAfterH: 3 } );
	clock.now += HOUR;
	assert.equal( _j.signal( _id ), null );
	assert.equal( Date.parse( _j.get( _id ).signalAt ), clock.now - HOUR );
	assert.deepEqual( _heard.map( item => item.reason ), [ 'first_signal' ] );
} );

attack( S, 'L5, B8: a signal after a timeout corrects the result to late_effect and keeps that it was provisional', () => {
	const { journal: _j, clock } = journal();
	const _heard = told( _j );
	const _id = _j.start( jnode( 'n1' ), { id: 'mail' } );
	clock.now += 24 * HOUR;
	_j.end( _id, { outcome: 'timeout', cause: 'no_reaction' } );
	clock.now += 20 * HOUR;
	assert.deepEqual( _j.signal( _id ), { signalAfterH: 44, result: 'late_effect', provisional: 'timeout' } );
	const _row = _j.get( _id );
	assert.deepEqual( [ _row.outcome, _row.provisional, _row.cause ], [ 'late_effect', 'timeout', 'no_reaction' ] );
	assert.deepEqual( _heard.at( -1 ), { attempt: _id, change: { signalAfterH: 44, result: 'late_effect', provisional: 'timeout' }, reason: 'late_effect' } );
	assert.equal( _j.signal( _id ), null, 'one correction, not two' );
} );

attack( S, 'L5: a first signal before the timeout, then the timeout: the late effect keeps the time of the first signal', () => {
	const { journal: _j, clock } = journal();
	const _id = _j.start( jnode( 'n1' ), { id: 'mail' } );
	clock.now += 2 * HOUR;
	_j.signal( _id );
	clock.now += 2 * HOUR;
	_j.end( _id, { outcome: 'timeout' } );
	clock.now += 2 * HOUR;
	assert.deepEqual( _j.signal( _id ), { signalAfterH: 2, result: 'late_effect', provisional: 'timeout' } );
} );

attack( S, 'L3: a signal does not turn a done or failed attempt into anything else', () => {
	const { journal: _j } = journal();
	const [ _done, _wall ] = [ 'a', 'b' ].map( id => _j.start( jnode( 'n1' ), { id } ) );
	_j.end( _done, { outcome: 'done' } );
	_j.end( _wall, { outcome: 'wall', cause: 'not_reached' } );
	_j.signal( _done );
	_j.signal( _wall );
	assert.deepEqual( [ _j.get( _done ).outcome, _j.get( _wall ).outcome, _j.get( _wall ).provisional ], [ 'done', 'wall', null ] );
	assert.ok( _j.get( _done ).signalAt );
} );

attack( S, 'L2: a signal at the very end of the horizon counts, one millisecond later it does not', () => {
	const { journal: _j, clock } = journal();
	const [ _a, _b ] = [ 'a', 'b' ].map( id => _j.start( jnode( 'n1' ), { id }, {}, { horizonH: 2 } ) );
	clock.now += 2 * HOUR;
	assert.ok( _j.signal( _a ) );
	clock.now += 1;
	assert.equal( _j.signal( _b ), null );
	assert.equal( _j.get( _b ).signalAt, null );
} );

attack( S, 'a signal for an attempt nobody started is no signal, and nobody hears of it', () => {
	const { journal: _j } = journal();
	const _heard = told( _j );
	for ( const id of [ 77, 'x', null, undefined, -1, 0 ] ) {
		assert.equal( _j.signal( id ), null );
	}
	assert.deepEqual( _heard, [] );
} );

attack( S, '20.1: a signal is still recorded after the observation ended at a contact, as long as the horizon allows', () => {
	const { journal: _j, clock } = journal();
	const _n = jnode( 'n1' );
	const _mail = _j.start( _n, { id: 'mail' } );
	_j.contact( _n, 'supplier', { by: _mail, trigger: 'start' } );
	_j.end( _mail, { outcome: 'timeout' } );
	clock.now += HOUR;
	const _call = _j.start( _n, { id: 'call' } );
	_j.contact( _n, 'supplier', { by: _call, trigger: 'review' } );
	assert.equal( JSON.parse( _j.get( _mail ).observationEnd ).reason, 'contact' );
	assert.equal( _j.signal( _mail ).result, 'late_effect' );
} );

attack( S, 'L2: the paper\'s example: the call ends the mail\'s observation at 41.5 h, the late answer makes it a late effect after 44 h', () => {
	const { journal: _j, clock } = journal( '2026-11-03T16:00:00Z' );
	const _n = jnode( 'supplier-goal' );
	const _mail = _j.start( _n, { id: 'contact.email_send' }, {}, { criterion: 'k1' } );
	_j.contact( _n, 'contact:4711', { by: _mail, trigger: 'start' } );
	clock.now = Date.parse( '2026-11-04T16:00:00Z' );
	_j.end( _mail, { outcome: 'timeout', cause: 'no_reaction' } );
	clock.now = Date.parse( '2026-11-05T09:30:00Z' );
	const _call = _j.start( _n, { id: 'contact.call' }, {}, { criterion: 'k1', trigger: 'review' } );
	_j.contact( _n, 'contact:4711', { by: _call, trigger: 'review' } );
	clock.now = Date.parse( '2026-11-05T12:00:00Z' );
	assert.deepEqual( JSON.parse( _j.get( _mail ).observationEnd ), { fromH: 41.5, reason: 'contact', trigger: 'review' } );
	assert.deepEqual( _j.signal( _mail ), { signalAfterH: 44, result: 'late_effect', provisional: 'timeout' } );
	assert.equal( _j.get( _call ).observationEnd, null );
} );

attack( S, 'L2: a contact ends the observation of the earlier attempts that reached the same side, never of the contacting one', () => {
	const { journal: _j } = journal();
	const _n = jnode( 'n1' );
	const [ _a, _b, _c ] = [ 'a', 'b', 'c' ].map( id => _j.start( _n, { id } ) );
	_j.contact( _n, 'supplier', { by: _a, trigger: 'start' } );
	_j.contact( _n, 'other-side', { by: _b, trigger: 'start' } );
	_j.contact( _n, 'supplier', { by: _c, trigger: 'review' } );
	_j.contact( _n, 'supplier', { by: _c, trigger: 'review' } );
	assert.equal( JSON.parse( _j.get( _a ).observationEnd ).trigger, 'review' );
	assert.deepEqual( [ _j.get( _b ).observationEnd, _j.get( _c ).observationEnd ], [ null, null ] );
	assert.deepEqual( JSON.parse( _j.get( _c ).contacts ), [ 'supplier' ], 'a side is noted once' );
} );

attack( S, 'L2: a contact ends the observation of every attempt with that side, also of another node\'s', () => {
	const { journal: _j } = journal();
	const _theirs = _j.start( jnode( 'n2' ), { id: 'mail' } );
	_j.contact( jnode( 'n2' ), 'supplier', { by: _theirs, trigger: 'start' } );
	const _other = _j.start( jnode( 'n3' ), { id: 'mail' } );
	_j.contact( jnode( 'n3' ), 'other-side', { by: _other, trigger: 'start' } );
	const _mine = _j.start( jnode( 'n1' ), { id: 'call' } );
	_j.contact( jnode( 'n1' ), 'supplier', { by: _mine, trigger: 'review' } );
	assert.deepEqual( JSON.parse( _j.get( _theirs ).observationEnd ), { fromH: 0, reason: 'contact', trigger: 'review' },
		'what the side does now follows the new contact, whichever node made it' );
	assert.equal( _j.get( _other ).observationEnd, null, 'another side is not touched' );
	assert.equal( _j.get( _mine ).observationEnd, null );
} );

attack( S, 'a contact without a side is no contact', () => {
	const { journal: _j } = journal();
	const _n = jnode( 'n1' );
	const _a = _j.start( _n, { id: 'a' } );
	_j.contact( _n, 'supplier', { by: _a, trigger: 'start' } );
	const _b = _j.start( _n, { id: 'b' } );
	for ( const target of [ '', null, undefined, 0, false ] ) {
		_j.contact( _n, target, { by: _b, trigger: 'review' } );
	}
	assert.deepEqual( [ _j.get( _a ).observationEnd, _j.get( _b ).contacts ], [ null, '[]' ] );
} );

attack( S, 'L2: an attempt whose id comes as text does not end its own observation by its own contact', () => {
	const { journal: _j } = journal();
	const _n = jnode( 'n1' );
	const _a = _j.start( _n, { id: 'a' } );
	_j.contact( _n, 'supplier', { by: _a, trigger: 'start' } );
	_j.contact( _n, 'supplier', { by: String( _a ), trigger: 'again' } );
	assert.equal( _j.get( _a ).observationEnd, null, 'an attempt does not censor itself' );
} );

attack( S, 'L2: a contact from no attempt (no open plan) still ends the observation of the earlier ones, and is noted nowhere', () => {
	const { journal: _j } = journal();
	const _n = jnode( 'n1' );
	const _a = _j.start( _n, { id: 'a' } );
	_j.contact( _n, 'supplier', { by: _a, trigger: 'start' } );
	_j.contact( _n, 'supplier', { by: undefined, trigger: null } );
	assert.deepEqual( JSON.parse( _j.get( _a ).observationEnd ), { fromH: 0, reason: 'contact', trigger: null } );
	assert.deepEqual( JSON.parse( _j.get( _a ).contacts ), [ 'supplier' ] );
} );

attacks( S, hostile( 'keys' ).filter( item => item.value ).map( item => ( { ...item, name: `L2: the side ${item.label} censors only a contact with exactly that side` } ) ), ( { value } ) => {
	const { journal: _j } = journal();
	const _n = jnode( 'n1' );
	const [ _a, _b, _c ] = [ 'a', 'b', 'c' ].map( id => _j.start( _n, { id } ) );
	_j.contact( _n, value, { by: _a, trigger: 'start' } );
	_j.contact( _n, `${value}x`, { by: _b, trigger: 'start' } );
	_j.contact( _n, value, { by: _c, trigger: 'review' } );
	assert.deepEqual( [ Boolean( _j.get( _a ).observationEnd ), Boolean( _j.get( _b ).observationEnd ) ], [ true, false ] );
} );

attack( S, 'L2: the end of an observation is written once, with the hours since the start, its reason and trigger', () => {
	const { journal: _j, clock } = journal();
	const _heard = told( _j );
	const _id = _j.start( jnode( 'n1' ), { id: 'a' } );
	clock.now += 1.5 * HOUR;
	_j.endObservation( _id, { reason: 'contact', trigger: 'review' } );
	clock.now += HOUR;
	_j.endObservation( _id, { reason: 'horizon', trigger: 'horizon' } );
	assert.deepEqual( JSON.parse( _j.get( _id ).observationEnd ), { fromH: 1.5, reason: 'contact', trigger: 'review' } );
	assert.deepEqual( _heard.map( item => item.reason ), [ 'observation_ended' ] );
	assert.doesNotThrow( () => _j.endObservation( 999, { reason: 'contact' } ) );
} );

attack( S, 'L2: the sweep ends observations whose horizon has passed, not one millisecond early', () => {
	const { journal: _j, clock } = journal();
	const _id = _j.start( jnode( 'n1' ), { id: 'a' }, {}, { horizonH: 1 } );
	clock.now += HOUR;
	_j.sweep();
	assert.equal( _j.get( _id ).observationEnd, null );
	clock.now += 1;
	_j.sweep();
	assert.deepEqual( JSON.parse( _j.get( _id ).observationEnd ), { fromH: 1, reason: 'horizon', trigger: 'horizon' } );
} );

attack( S, 'L2: the observation runs to the horizon also for running attempts and after the node closed, and ends once', () => {
	const { journal: _j, clock } = journal();
	const _heard = told( _j );
	const _running = _j.start( jnode( 'n1' ), { id: 'a' }, {}, { horizonH: 1 } );
	const _closed = _j.start( jnode( 'n2' ), { id: 'b' }, {}, { horizonH: 1 } );
	_j.end( _closed, { outcome: 'done' } );
	_j.contractSuccess( jnode( 'n2' ), true );
	clock.now += 2 * HOUR;
	_j.sweep();
	_j.sweep();
	assert.ok( _j.get( _running ).observationEnd && _j.get( _closed ).observationEnd );
	assert.equal( _heard.length, 2 );
} );

attack( S, 'L2: a contact before the horizon decides the reason; the sweep does not overwrite it', () => {
	const { journal: _j, clock } = journal();
	const _n = jnode( 'n1' );
	const _a = _j.start( _n, { id: 'a' }, {}, { horizonH: 1 } );
	_j.contact( _n, 'supplier', { by: _a, trigger: 'start' } );
	_j.contact( _n, 'supplier', { by: _j.start( _n, { id: 'b' } ), trigger: 'review' } );
	clock.now += 2 * HOUR;
	_j.sweep();
	assert.equal( JSON.parse( _j.get( _a ).observationEnd ).reason, 'contact' );
} );

attack( S, 'L2: an attempt observed past the year 9999 is not swept away at once', () => {
	const { journal: _j } = journal();
	const _id = _j.start( jnode( 'n1' ), { id: 'a' }, {}, { horizonH: 1e8 } );
	_j.sweep();
	assert.equal( _j.get( _id ).observationEnd, null, `its horizon is ${_j.get( _id ).horizonUntil}` );
	assert.ok( _j.signal( _id ), 'signal() agrees that the horizon has not passed' );
} );

attack( S, 'a listener that fails does not keep the sweep from ending every due observation', () => {
	const { journal: _j, clock } = journal();
	const _ids = [ 'a', 'b', 'c' ].map( id => _j.start( jnode( 'n1' ), { id }, {}, { horizonH: 1 } ) );
	_j.listen( () => {
		throw new Error( 'memory full' );
	} );
	clock.now += 2 * HOUR;
	try {
		_j.sweep();
	} catch {
		// a listener's failure is its own; what matters is the journal
	}
	assert.deepEqual( _ids.map( id => Boolean( _j.get( id ).observationEnd ) ), [ true, true, true ] );
} );

attack( S, 'every listener hears every change, in the order they listened, with attempt, change and reason', () => {
	const { journal: _j, clock } = journal();
	const _order = [];
	_j.listen( ( attempt, change, reason ) => _order.push( [ 'first', attempt, reason ] ) );
	_j.listen( ( attempt, change, reason ) => _order.push( [ 'second', attempt, reason ] ) );
	const _id = _j.start( jnode( 'n1' ), { id: 'a' } );
	_j.credit( _id, 'k1' );
	clock.now += HOUR;
	_j.signal( _id );
	assert.deepEqual( _order, [ [ 'first', _id, 'late_credit' ], [ 'second', _id, 'late_credit' ], [ 'first', _id, 'first_signal' ], [ 'second', _id, 'first_signal' ] ] );
} );

attack( S, '19: a provisional timeout stays open for the choice until its observation ends, then it is free again', () => {
	const { journal: _j, clock } = journal();
	const _n = jnode( 'n1' );
	const _id = _j.start( _n, { id: 'mail' }, {}, { criterion: 'k1', horizonH: 5 } );
	_j.end( _id, { outcome: 'timeout', cause: 'no_reaction' } );
	assert.deepEqual( _j.open( 'n1' ).map( row => row.strategy ), [ 'mail' ] );
	clock.now += 6 * HOUR;
	_j.sweep();
	assert.deepEqual( _j.open( 'n1' ), [] );
	assert.equal( _j.signal( _id ), null, 'after the horizon nothing is recorded any more' );
} );

attack( S, 'L4: credit that arrives after the attempt ended is still booked and told as late credit', () => {
	const { journal: _j, clock } = journal();
	const _heard = told( _j );
	const _id = _j.start( jnode( 'n1' ), { id: 'a' } );
	_j.end( _id, { outcome: 'timeout', cause: 'no_reaction' } );
	clock.now += 10 * HOUR;
	_j.credit( _id, 'k1' );
	assert.deepEqual( JSON.parse( _j.get( _id ).contribution ), [ 'k1' ] );
	assert.equal( _heard.at( -1 ).reason, 'late_credit' );
} );
