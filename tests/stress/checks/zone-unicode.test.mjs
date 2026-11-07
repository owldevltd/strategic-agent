// The base setup's time zone and texts in any script: quiet days are the days of the user's zone, not of the server;
// prices are found in any currency sign Unicode knows; the contract check reads clauses and goals in any script.
import assert from 'node:assert/strict';
import { attacks } from '../hostile.mjs';
import { SoftCheck, ContractCheck } from './fixtures.mjs';

const SOFT = 'core/check/softcheck.js';
const CHECK = 'core/check/contractcheck.js';
// 2026-11-08 is a Sunday; 23:30 UTC on the Saturday is already Sunday in Berlin, and still Saturday in New York.
const SATURDAY_LATE = new Date( '2026-11-07T23:30:00Z' );

attacks( SOFT, [
	{ name: 'zone: a quiet Sunday holds in Berlin at 00:30 local time, though UTC still says Saturday', zone: 'Europe/Berlin', want: 'sun' },
	{ name: 'zone: in New York the same moment is Saturday evening', zone: 'America/New_York', want: null },
	{ name: 'zone: without a time zone the day is the UTC day', zone: undefined, want: null },
	{ name: 'zone: Tokyo is already Sunday morning', zone: 'Asia/Tokyo', want: 'sun' },
], ( { zone, want } ) => {
	const _soft = new SoftCheck( { noContactOn: [ 'sunday' ], ...( zone ? { timeZone: zone } : {} ) } );
	const _found = _soft.check( 'reply', { body: 'Hello' }, SATURDAY_LATE );
	assert.deepEqual( _found.map( item => item.found ), want ? [ want ] : [] );
} );

attacks( SOFT, [
	{ name: 'zone: a time zone the runtime does not know stops the start', zone: 'Mars/Olympus' },
	{ name: 'zone: a number is no time zone', zone: 2 },
	{ name: 'zone: an offset in words is no time zone', zone: 'GMT plus two' },
], ( { zone } ) => {
	assert.throws( () => new SoftCheck( { timeZone: zone } ), /timeZone: .* is no time zone/ );
} );

attacks( SOFT, [
	{ name: 'weekday: Sunday in Berlin', at: '2026-11-07T23:30:00Z', zone: 'Europe/Berlin', want: 'sun' },
	{ name: 'weekday: Saturday in UTC', at: '2026-11-07T23:30:00Z', zone: 'UTC', want: 'sat' },
	{ name: 'weekday: Friday in Honolulu', at: '2026-11-07T08:00:00Z', zone: 'Pacific/Honolulu', want: 'fri' },
], ( { at, zone, want } ) => {
	assert.equal( SoftCheck.weekday( new Date( at ), zone ), want );
} );

attacks( SOFT, [
	{ name: 'price: the rupee sign is a price', text: 'It costs ₹ 4,500 per seat', want: '₹ 4,500' },
	{ name: 'price: the rouble sign is a price', text: 'Total 3000₽', want: '3000₽' },
	{ name: 'price: the won sign is a price', text: 'Only ₩12000 today', want: '₩12000' },
	{ name: 'price: the euro sign is still a price', text: 'Pay 12,40 €', want: '12,40 €' },
	{ name: 'price: a code of a currency is a price', text: 'Invoice over 500 SEK', want: '500 SEK' },
	{ name: 'price: a number without a currency is none', text: 'We are 12 people in room 4', want: null },
], ( { text, want } ) => {
	const _found = new SoftCheck( { namePrices: false } ).check( 'reply', { body: text }, new Date( '2026-11-04T10:00:00Z' ) );
	assert.deepEqual( _found.map( item => item.found ), want ? [ want ] : [] );
} );

attacks( CHECK, [
	{ name: 'norm: umlauts and ß are letters, not removed', text: 'Größe der Bürofläche', want: 'größe der bürofläche' },
	{ name: 'norm: Cyrillic is kept, punctuation goes', text: 'Оплатить счета, срочно!', want: 'оплатить счета срочно' },
	{ name: 'norm: Japanese is kept', text: '請求書を支払う。', want: '請求書を支払う' },
	{ name: 'norm: a decomposed accent is the composed letter', text: 'Café bill', want: 'café bill' },
	{ name: 'norm: blanks of any width are one blank', text: 'pay  the\tbill', want: 'pay the bill' },
], ( { text, want } ) => {
	assert.equal( ContractCheck.norm( text ), want );
} );

attacks( CHECK, [
	{ name: 'part: a German clause with umlauts is found in its sentence', part: 'nur an Konten aus den Stammdaten zahlen',
		sentence: 'Bitte die Rechnungen prüfen und nur an Konten aus den Stammdaten zahlen.', want: true },
	{ name: 'part: a Cyrillic clause is found in its sentence', part: 'платить только на счета из справочника',
		sentence: 'Проверить счета и платить только на счета из справочника.', want: true },
	{ name: 'part: a clause of three words is too short, in any script', part: 'платить только сегодня', sentence: 'платить только сегодня', want: false },
	{ name: 'part: a clause that is not in the sentence is not found', part: 'nur an neue Konten zahlen bitte', sentence: 'Bitte nur an alte Konten zahlen.', want: false },
], ( { part, sentence, want } ) => {
	assert.equal( ContractCheck.part( part, sentence ), want );
} );
