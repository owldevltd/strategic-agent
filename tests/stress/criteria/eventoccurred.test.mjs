// core/criteria/eventoccurred.js (ereignis_eingetreten, 14.1): the event took place in its window, confirmed by a
// participant in the named role or recorded by a system that logs the event with its participants. A calendar
// entry only shows it was planned. Attacks: roles, classes, window edges and zones, records without participants.
import { DEADLINE, WINDOW, assert, attack, attacks, fact, make, registry, shift } from './kit.mjs';
import { outcomeSuite } from './suites.mjs';

const S = 'core/criteria/eventoccurred.js';
const VALUES = { event: 'meeting:t-88', window: WINDOW, role: 'participant' };
const IN = '2026-11-11T10:00:00.000Z';
const confirmed = ( data = {}, extra = {} ) => fact( 'event_confirmed', { event: 'meeting:t-88', at: IN, role: 'participant', ...data }, 'confirmation', extra );
const recorded = ( data = {}, extra = {} ) => fact( 'event_recorded', { event: 'meeting:t-88', at: IN, participants: [ 'p1', 'p2' ], ...data }, 'observation', extra );
const met = ( facts, values = VALUES ) => make( 'event_occurred', values ).check( facts ).met;

outcomeSuite( S, { type: 'event_occurred', values: VALUES, good: () => [ confirmed() ], refused: [ 'derivation', 'claim', 'observation' ] } );

attack( S, 'a confirmation by a participant in the named role meets it', () => {
	const _yes = confirmed();
	assert.deepEqual( make( 'event_occurred', VALUES ).check( [ _yes ] ), { met: true, evidence: [ _yes.id ], reason: '' } );
} );

attack( S, 'a record of a system that logs the event meets it', () => {
	assert.equal( met( [ recorded() ] ), true );
} );

attack( S, 'a calendar entry is an observation, but it only proves the event was planned', () => {
	assert.equal( met( [ fact( 'calendar_entry', { event: 'meeting:t-88', at: IN } ) ] ), false );
} );

attacks( S, [
	{ name: 'a confirmation by another role does not count', data: { role: 'organiser' } },
	{ name: 'a confirmation without any role does not count when a role is named', data: { role: undefined } },
	{ name: 'a confirmation by the role in another case does not count', data: { role: 'Participant' } },
	{ name: 'a confirmation of another event does not count', data: { event: 'meeting:t-89' } },
	{ name: 'a confirmation of the event id with a suffix does not count', data: { event: 'meeting:t-88x' } },
], ( { data } ) => {
	assert.equal( met( [ confirmed( data ) ] ), false );
} );

attack( S, 'without a named role a confirmation by anyone in a role counts', () => {
	assert.equal( met( [ confirmed( { role: 'organiser' } ) ], { event: 'meeting:t-88', window: WINDOW } ), true );
} );

attacks( S, [
	{ name: 'a confirmation recorded as an observation is the wrong class for a confirmation', fn: () => confirmed( {}, { evidenceClass: 'observation' } ) },
	{ name: 'a record given as a confirmation is the wrong class for a record', fn: () => recorded( {}, { evidenceClass: 'confirmation' } ) },
	{ name: 'a record claimed by the agent is no record', fn: () => recorded( {}, { evidenceClass: 'claim' } ) },
	{ name: 'a confirmation derived by an AI from free text is no confirmation', fn: () => confirmed( {}, { evidenceClass: 'derivation' } ) },
], ( { fn } ) => {
	assert.equal( met( [ fn() ] ), false );
} );

attacks( S, [
	{ name: 'at exactly the window start it counts', at: WINDOW[ 0 ], want: true },
	{ name: 'at exactly the window end it counts', at: WINDOW[ 1 ], want: true },
	{ name: '1 ms before the window it does not count', at: shift( WINDOW[ 0 ], -1 ), want: false },
	{ name: '1 ms after the window it does not count', at: shift( WINDOW[ 1 ], 1 ), want: false },
	{ name: 'the window start written at +14:00 counts', at: '2026-11-09T22:00:00+14:00', want: true },
	{ name: 'one minute before the window written at -12:00 does not count', at: '2026-11-08T19:59:00-12:00', want: false },
	{ name: 'without a time it does not count', at: undefined, want: false },
	{ name: 'a time given as an epoch number does not count', at: Date.parse( IN ), want: false },
], ( { at, want } ) => {
	assert.equal( met( [ confirmed( { at } ) ] ), want );
	assert.equal( met( [ recorded( { at } ) ] ), want );
} );

attack( S, 'a record whose participant list is empty shows a room that was open, not an event that took place', () => {
	assert.equal( met( [ recorded( { participants: [] } ) ] ), false );
} );

attack( S, 'K3: "after" is checked by G1 (timing), never by this predicate', () => {
	assert.equal( met( [ confirmed() ], { ...VALUES, after: 'k0' } ), true );
} );

attack( S, 'a confirmation that arrived after the criterion\'s deadline does not count, even for a time inside the window', () => {
	const _late = confirmed( {}, { time: shift( DEADLINE, 1 ) } );
	assert.equal( make( 'event_occurred', VALUES, { deadline: DEADLINE } ).check( [ _late ] ).met, false );
} );

attack( S, 'of a calendar entry and a record, the record is the evidence', () => {
	const _record = recorded();
	assert.deepEqual( make( 'event_occurred', VALUES ).check( [ fact( 'calendar_entry', { event: 'meeting:t-88', at: IN } ), _record ] ).evidence, [ _record.id ] );
} );

attack( S, 'a superseded confirmation leaves the event unproven (E5)', () => {
	assert.equal( met( [ confirmed( {}, { superseded: true } ) ] ), false );
} );

attack( S, 'the reason names what is missing', () => {
	assert.equal( make( 'event_occurred', VALUES ).check( [] ).reason, 'no confirmation or record of the event' );
} );

attack( S, 'a window across the autumn DST switch, written with offsets, contains the repeated hour', () => {
	const _values = { event: 'call', window: [ '2026-10-25T02:30:00+02:00', '2026-10-25T02:30:00+01:00' ] };
	assert.equal( met( [ recorded( { event: 'call', at: '2026-10-25T02:59:00+02:00' } ) ], _values ), true );
	assert.equal( met( [ recorded( { event: 'call', at: '2026-10-25T02:31:00+01:00' } ) ], _values ), false );
} );

attacks( S, [
	{ name: 'validate: a window that ends before it starts is refused (K2)', values: { ...VALUES, window: [ WINDOW[ 1 ], WINDOW[ 0 ] ] }, want: /K2/ },
	{ name: 'validate: a window of one instant is refused (K2)', values: { ...VALUES, window: [ WINDOW[ 0 ], WINDOW[ 0 ] ] }, want: /K2/ },
	{ name: 'validate: a missing event is refused', values: { window: WINDOW }, want: /event is missing/ },
	{ name: 'validate: a role given as a list is refused', values: { ...VALUES, role: [ 'participant' ] }, want: /role must be text/ },
	{ name: 'validate: an "after" that is no id text is refused', values: { ...VALUES, after: 1 }, want: /after must be text/ },
	{ name: 'validate: a window of words is refused', values: { ...VALUES, window: [ 'monday', 'friday' ] }, want: /must be a window/ },
], ( { values, want } ) => {
	assert.match( make( 'event_occurred', values ).validate().join(), want );
} );

attack( S, 'its evidence kinds are exactly the confirmation and the record, not the calendar', () => {
	assert.deepEqual( registry.types.event_occurred.EVIDENCE, [ 'event_confirmed', 'event_recorded' ] );
	assert.equal( registry.types.event_occurred.WINDOW_AFTER_DEADLINE, false );
} );
