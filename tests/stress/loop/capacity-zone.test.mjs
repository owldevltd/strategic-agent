// The daily capacity of people (P6) in the time zone of the base setup: a person's day is their local day, and a ticket
// postponed to the next day goes out when that day starts there, also across a change of daylight saving time.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { Capacity } from './kit.mjs';

const CAP = 'core/budget/capacity.js';
const at = iso => Date.parse( iso );

attacks( CAP, [
	{ name: 'zone: 23:30 UTC is already the next day in Berlin', time: '2026-11-04T23:30:00Z', zone: 'Europe/Berlin', want: '2026-11-05' },
	{ name: 'zone: 03:00 UTC is still the day before in Los Angeles', time: '2026-11-05T03:00:00Z', zone: 'America/Los_Angeles', want: '2026-11-04' },
	{ name: 'zone: UTC is the UTC day', time: '2026-11-04T23:30:00Z', zone: 'UTC', want: '2026-11-04' },
	{ name: 'zone: India is half an hour off the hour', time: '2026-11-04T18:45:00Z', zone: 'Asia/Kolkata', want: '2026-11-05' },
], ( { time, zone, want } ) => {
	assert.equal( Capacity.day( at( time ), zone ), want );
} );

attacks( CAP, [
	{ name: 'at: 08:00 in Berlin in winter is 07:00 UTC', date: '2026-11-05', hour: 8, zone: 'Europe/Berlin', want: '2026-11-05T07:00:00.000Z' },
	{ name: 'at: 08:00 in Berlin in summer is 06:00 UTC', date: '2026-07-01', hour: 8, zone: 'Europe/Berlin', want: '2026-07-01T06:00:00.000Z' },
	{ name: 'at: 08:00 in New York in winter is 13:00 UTC', date: '2026-11-05', hour: 8, zone: 'America/New_York', want: '2026-11-05T13:00:00.000Z' },
	{ name: 'at: the day after the clocks went back still starts at 08:00 local', date: '2026-10-26', hour: 8, zone: 'Europe/Berlin', want: '2026-10-26T07:00:00.000Z' },
	{ name: 'at: 08:00 UTC is 08:00 UTC', date: '2026-11-05', hour: 8, zone: 'UTC', want: '2026-11-05T08:00:00.000Z' },
], ( { date, hour, zone, want } ) => {
	assert.equal( new Date( Capacity.at( date, hour, zone ) ).toISOString(), want );
} );

attack( CAP, 'zone: a full day in Berlin postpones the ticket to 08:00 Berlin time the next day', () => {
	const _clock = { now: at( '2026-11-04T15:00:00Z' ) };
	const _capacity = new Capacity( { dailyMinutes: 10, dayStartsHour: 8, timeZone: 'Europe/Berlin' }, () => _clock.now );
	assert.equal( _capacity.take( 10 ).ok, true );
	assert.equal( _capacity.take( 5, '2026-11-09T00:00:00Z' ).notBefore, '2026-11-05T07:00:00.000Z' );
} );

attack( CAP, 'zone: a ticket at 23:30 UTC counts on the Berlin day it is already', () => {
	const _clock = { now: at( '2026-11-04T23:30:00Z' ) };
	const _capacity = new Capacity( { dailyMinutes: 60, timeZone: 'Europe/Berlin' }, () => _clock.now );
	_capacity.take( 20 );
	assert.deepEqual( [ ..._capacity.used ], [ [ '2026-11-05', 20 ] ] );
} );

attacks( CAP, [
	{ name: 'zone: an unknown time zone stops the start', zone: 'Europe/Atlantis' },
	{ name: 'zone: a list is no time zone', zone: [ 'UTC' ] },
	{ name: 'zone: an empty text is no time zone', zone: '' },
], ( { zone } ) => {
	assert.throws( () => new Capacity( { timeZone: zone } ), /is no time zone/ );
} );

attack( CAP, 'zone: the base setup names UTC unless the user sets their own', () => {
	assert.equal( Capacity.load().timeZone, 'UTC' );
} );
