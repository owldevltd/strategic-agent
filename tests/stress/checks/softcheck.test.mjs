// Soft gates (7.3, 21): key/value of the user's base setup plus learned preferences, below the user's own values.
// Writers get them as instructions; an outgoing text that still breaks one is reworked once, then goes on only marked.
// check() is that rework trigger: it must find what breaks a rule, find nothing else, and never hang or crash.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { SoftCheck, Actions } from './fixtures.mjs';

const SUBJECT = 'core/check/softcheck.js';
const DAYS = [ 'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat' ];
// Local noon on Sunday 8 November 2026 plus n days: getDay() reads local time, so build dates in local time too.
const day = n => new Date( 2026, 10, 8 + n, 12 );
const MONDAY = day( 1 );
const strict = new SoftCheck( { namePrices: false, exclamations: false, noContactOn: [ 'sun' ] } );
const flags = ( soft, params, action = 'reply', now = MONDAY ) => soft.check( action, params, now ).map( item => item.id );
// A setting the code cannot read must be refused with an error that names it, or be understood; never a TypeError.
const refusedOrUnderstood = ( base, key, understood ) => {
	let _soft;
	try {
		_soft = new SoftCheck( base );
	} catch ( error ) {
		assert.ok( !( error instanceof TypeError ), `a clean refusal, not ${error.message}` );
		assert.match( error.message, new RegExp( key ) );
		return;
	}
	understood( _soft );
};

attack( SUBJECT, 'the base setup of the catalog gives the four known rules, all of the user', () => {
	const _soft = SoftCheck.load();
	assert.deepEqual( _soft.rules.map( rule => [ rule.id, rule.origin ] ).sort(),
		[ [ 'address', 'user' ], [ 'exclamations', 'user' ], [ 'namePrices', 'user' ], [ 'noContactOn', 'user' ] ] );
} );

attack( SUBJECT, 'keys the code does not know are kept as values but make no rule', () => {
	const _soft = new SoftCheck( { dailyCapacityMin: 60, colour: 'blue', namePrices: false } );
	assert.equal( _soft.values.colour, 'blue' );
	assert.deepEqual( _soft.rules.map( rule => rule.id ), [ 'namePrices' ] );
} );

attack( SUBJECT, 'a learned preference never overrides the user\'s own value', () => {
	const _soft = new SoftCheck( { namePrices: false, learned: { namePrices: true } } );
	assert.deepEqual( _soft.rules.map( rule => [ rule.id, rule.value, rule.origin ] ), [ [ 'namePrices', false, 'user' ] ] );
	assert.deepEqual( flags( _soft, { body: 'It costs 300 EUR.' } ), [ 'namePrices' ] );
} );

attack( SUBJECT, 'a learned preference counts where the user said nothing, marked as learned', () => {
	const _soft = new SoftCheck( { learned: { exclamations: false } } );
	assert.deepEqual( _soft.rules.map( rule => [ rule.id, rule.origin ] ), [ [ 'exclamations', 'learned' ] ] );
	assert.deepEqual( flags( _soft, { body: 'Thanks!' } ), [ 'exclamations' ] );
} );

attack( SUBJECT, 'learned set to null is no learned preference at all', () => {
	assert.deepEqual( new SoftCheck( { namePrices: false, learned: null } ).rules.map( rule => rule.origin ), [ 'user' ] );
} );

attack( SUBJECT, 'an empty base setup has no rules and no instructions', () => {
	const _soft = new SoftCheck( {} );
	assert.deepEqual( [ _soft.rules, _soft.instructions(), flags( _soft, { body: '300 EUR! on a Sunday' }, 'reply', day( 0 ) ) ], [ [], '', [] ] );
} );

attacks( SUBJECT, [ 'constructor', 'toString', 'hasOwnProperty', 'valueOf' ].map( key => ( {
	name: `a base key named ${key} is an unknown key, not a crash`, key,
} ) ), ( item ) => {
	const _soft = new SoftCheck( { [ item.key ]: true, namePrices: false } );
	assert.deepEqual( _soft.rules.map( rule => rule.id ), [ 'namePrices' ] );
} );

attack( SUBJECT, 'a base key __proto__ from the JSON file is an unknown key, not a crash', () => {
	const _soft = new SoftCheck( JSON.parse( '{"__proto__": {"says": 1}, "namePrices": false}' ) );
	assert.deepEqual( _soft.rules.map( rule => rule.id ), [ 'namePrices' ] );
} );

attack( SUBJECT, 'a learned key named constructor cannot take the whole soft check down', () => {
	const _soft = new SoftCheck( { namePrices: false, learned: { constructor: 'x' } } );
	assert.deepEqual( flags( _soft, { body: '300 EUR' } ), [ 'namePrices' ] );
} );

attacks( SUBJECT, [
	{ name: 'quiet days written as one text instead of a list', value: 'sun' },
	{ name: 'quiet days set to null', value: null },
	{ name: 'quiet days given as a number', value: 7 },
].map( item => ( { ...item, name: `${item.name} are refused cleanly or understood` } ) ), ( item ) => {
	refusedOrUnderstood( { noContactOn: item.value }, 'noContactOn', soft => assert.ok( Array.isArray( soft.check( 'reply', { body: 'ok' }, day( 0 ) ) ) ) );
} );

attacks( SUBJECT, [
	{ name: 'quiet days written with a capital (Sun)', value: [ 'Sun' ] },
	{ name: 'quiet days written in full (sunday)', value: [ 'sunday' ] },
	{ name: 'quiet days in the paper\'s own spelling (so, 21)', value: [ 'so' ] },
].map( item => ( { ...item, name: `${item.name} protect the Sunday or are refused, never silently ignored` } ) ), ( item ) => {
	refusedOrUnderstood( { noContactOn: item.value }, 'noContactOn', soft => assert.deepEqual( flags( soft, { body: 'ok' }, 'reply', day( 0 ) ), [ 'noContactOn' ] ) );
} );

attack( SUBJECT, 'the paper\'s own address value (sie) never turns into the opposite instruction', () => {
	assert.doesNotMatch( new SoftCheck( { address: 'sie' } ).instructions( 'reply' ), /informally/ );
} );

attacks( SUBJECT, DAYS.map( ( name, n ) => ( { name: `a contact on a quiet ${name} is found, the day after is free`, n, code: name } ) ), ( item ) => {
	const _soft = new SoftCheck( { noContactOn: [ item.code ] } );
	assert.deepEqual( _soft.check( 'reply', { body: 'ok' }, day( item.n ) ), [ { id: 'noContactOn', says: _soft.rules[ 0 ].says, found: item.code } ] );
	assert.deepEqual( flags( _soft, { body: 'ok' }, 'reply', day( item.n + 1 ) ), [] );
} );

attack( SUBJECT, 'quiet days never stop a message inside the company (a report) or a payment', () => {
	assert.deepEqual( flags( strict, { body: 'ok' }, 'report', day( 0 ) ), [] );
	assert.deepEqual( flags( strict, { amount: 300 }, 'payment', day( 0 ) ), [] );
} );

attacks( SUBJECT, [
	{ text: 'We will not pay the 3,150.00 EUR again.', found: '3,150.00 EUR' },
	{ text: 'Total: € 3.150', found: '€ 3.150' },
	{ text: 'only 3150€', found: '3150€' },
	{ text: 'a fee of $99 applies', found: '$99' },
	{ text: 'USD 10 per seat', found: 'USD 10' },
	{ text: 'it was 10 usd', found: '10 usd' },
	{ text: '3.150,00 Euro brutto', found: '3.150,00 Eur' },
	{ text: 'two lines:\n300\nEUR', found: '300\nEUR' },
].map( item => ( { ...item, name: `the amount in ${JSON.stringify( item.text )} is found` } ) ), ( item ) => {
	const [ _flag ] = strict.check( 'reply', { body: item.text }, MONDAY );
	assert.deepEqual( [ _flag?.id, _flag?.found ], [ 'namePrices', item.found ] );
} );

attack( SUBJECT, 'an amount split over two fields is still found', () => {
	assert.deepEqual( flags( strict, { subject: 'Invoice 300', body: 'EUR as agreed' } ), [ 'namePrices' ] );
} );

attacks( SUBJECT, [
	{ name: 'a customer id at the end of one field and a currency in the next are no amount (C102, EUR)', params: { customer: 'C102', currency: 'EUR' } },
	{ name: 'a customer id and a currency on two lines are no amount', params: { body: 'Customer C102\nEUR account' } },
	{ name: 'an id glued to letters in any script is no amount', params: { body: 'Customer Ä102 EUR-account' } },
	{ name: 'an invoice number with letters before its digits is no amount', params: { body: 'Invoice AR2026 EUR statement' } },
], ( { params } ) => {
	assert.deepEqual( flags( strict, params ), [] );
} );

attack( SUBJECT, 'the real amount next to a customer id is still found, and it is what the mark quotes', () => {
	const [ _flag ] = strict.check( 'reply', { customer: 'C102', body: 'Invoice 2026-0391 over 14,800.00 EUR is open.' }, MONDAY );
	assert.deepEqual( [ _flag?.id, _flag?.found ], [ 'namePrices', '14,800.00 EUR' ] );
} );

attacks( SUBJECT, [
	{ text: 'We pay £300 next week.' },
	{ text: 'The fee is CHF 300.' },
	{ text: 'It costs 300 GBP.' },
].map( item => ( { ...item, name: `the amount in ${JSON.stringify( item.text )} is found as well` } ) ), ( item ) => {
	assert.deepEqual( flags( strict, { body: item.text } ), [ 'namePrices' ] );
} );

attacks( SUBJECT, [
	{ text: 'We meet on 3.11. at 10 in room 4.' },
	{ text: 'Invoice R-1186 is settled.' },
	{ text: 'Release 2.5 of the survey tool.' },
	{ text: 'EURO 2028 tickets are not our topic.' },
].map( item => ( { ...item, name: `${JSON.stringify( item.text )} names no amount and is not flagged` } ) ), ( item ) => {
	assert.deepEqual( flags( strict, { body: item.text } ), [] );
} );

attack( SUBJECT, 'with namePrices true amounts may be named', () => {
	assert.deepEqual( flags( new SoftCheck( { namePrices: true } ), { body: 'It costs 300 EUR.' } ), [] );
} );

attack( SUBJECT, 'prices are no rule for internal reports, but exclamation marks are', () => {
	assert.deepEqual( flags( strict, { body: 'Budget 300 EUR!' }, 'report' ), [ 'exclamations' ] );
} );

attack( SUBJECT, 'a payment is no message: its amount is never a soft-rule problem', () => {
	assert.deepEqual( flags( strict, { amount: 3150, iban: 'DE02', note: '3150 EUR!' }, 'payment' ), [] );
} );

attacks( SUBJECT, [ 'payment', 'mail', 'unknown', '', null, undefined, '__proto__', 'constructor' ].map( action => ( {
	name: `the action ${JSON.stringify( action ) ?? 'undefined'} carries no message: no soft rule`, action,
} ) ), ( item ) => {
	assert.deepEqual( strict.check( item.action, { body: '300 EUR!' }, day( 0 ) ), [] );
} );

attack( SUBJECT, '7.3: an invitation to a team stays inside the company: the written rules hold, not the outside ones', () => {
	assert.deepEqual( strict.check( 'invite', { body: '300 EUR!' }, day( 0 ) ).map( item => item.id ), [ 'exclamations' ] );
} );

// A mission's own actions (actions.json): the table says what they carry and whether they stay inside, not their name.
const OWN = new Actions( {
	reminder: { criticality: 'outward', carries: [ 'message' ] },
	memo: { criticality: 'outward', carries: [ 'message' ], inside: true },
	deploy: { criticality: 'outward', carries: [] },
	transfer: { criticality: 'money_or_law', carries: [ 'money' ] },
	sloppy: { criticality: 'outward', carries: 'message' },
	insideText: { criticality: 'outward', carries: [ 'message' ], inside: 'true' },
} );
const own = new SoftCheck( { namePrices: false, exclamations: false, noContactOn: [ 'sun' ] }, OWN );

attacks( SUBJECT, [
	{ name: '7.3: a mission\'s own message to a customer gets every rule of the base setup', action: 'reminder', want: [ 'namePrices', 'exclamations', 'noContactOn' ] },
	{ name: '7.3: a mission\'s own message marked inside gets only the written rules', action: 'memo', want: [ 'exclamations' ] },
	{ name: '7.3: an action that carries no message (a deploy) gets no soft rule', action: 'deploy', want: [] },
	{ name: '7.3: an action that carries only money gets no soft rule', action: 'transfer', want: [] },
	{ name: '7.3: "carries" given as text is no list: nothing is read into it', action: 'sloppy', want: [] },
	{ name: '7.3: "inside" given as the text "true" is not true: the stricter outside rules hold', action: 'insideText', want: [ 'namePrices', 'exclamations', 'noContactOn' ] },
	{ name: '7.3: the name "reply" means nothing to a table that does not have it', action: 'reply', want: [] },
], ( { action, want } ) => {
	assert.deepEqual( own.check( action, { body: 'Please pay 300 EUR now!' }, day( 0 ) ).map( item => item.id ), want );
} );

attack( SUBJECT, '7.3: the writer of a mission\'s own message to a customer is told every rule', () => {
	assert.match( own.instructions( 'reminder' ), /Never mention prices/ );
	assert.doesNotMatch( own.instructions( 'memo' ), /Never mention prices/ );
	assert.match( own.instructions( 'memo' ), /without exclamation marks/ );
	assert.equal( own.instructions( 'deploy' ), '' );
} );

attack( SUBJECT, 'an exclamation mark is found once, whatever field it is in', () => {
	assert.deepEqual( strict.check( 'reply', { subject: 'Hi!', body: 'Thanks!!' }, MONDAY ).map( item => [ item.id, item.found ] ), [ [ 'exclamations', '!' ] ] );
} );

attack( SUBJECT, 'a text without exclamation marks passes; exclamations: true allows them', () => {
	assert.deepEqual( flags( strict, { body: 'Thank you.' } ), [] );
	assert.deepEqual( flags( new SoftCheck( { exclamations: true } ), { body: 'Thank you!' } ), [] );
} );

attack( SUBJECT, 'every broken rule is reported at once, in the order of the rules', () => {
	assert.deepEqual( flags( strict, { body: 'Pay 300 EUR now!' }, 'reply', day( 0 ) ), [ 'namePrices', 'exclamations', 'noContactOn' ] );
} );

attack( SUBJECT, 'numbers are no text: an amount as a number in the params is not a mention', () => {
	assert.deepEqual( flags( strict, { body: 'See attachment.', amount: 3150, total: '3150' } ), [] );
} );

attacks( SUBJECT, [
	{ name: 'text inside a list of lines is checked too', params: { lines: [ 'Dear supplier,', 'we pay 300 EUR.' ] } },
	{ name: 'text inside a nested object is checked too', params: { body: { text: 'we pay 300 EUR.' } } },
], ( item ) => {
	assert.deepEqual( flags( strict, item.params ), [ 'namePrices' ] );
} );

attacks( SUBJECT, [ { name: 'params null', params: null }, { name: 'params undefined', params: undefined }, { name: 'params empty', params: {} } ]
	.map( item => ( { ...item, name: `${item.name} give no flags on a working day` } ) ), ( item ) => {
	assert.deepEqual( flags( strict, item.params ), [] );
} );

attack( SUBJECT, 'the check never changes the text it looks at', () => {
	const _params = { body: 'Pay 300 EUR now!' };
	strict.check( 'reply', _params, day( 0 ) );
	assert.deepEqual( _params, { body: 'Pay 300 EUR now!' } );
} );

attack( SUBJECT, 'a long text of plain words is checked quickly', () => {
	const _start = Date.now();
	assert.deepEqual( flags( strict, { body: 'word '.repeat( 200000 ) } ), [] );
	assert.ok( Date.now() - _start < 1000 );
} );

attack( SUBJECT, 'a long run of digits without a currency does not stall the check (no catastrophic backtracking)', () => {
	const _start = Date.now();
	assert.deepEqual( flags( strict, { body: `${'1'.repeat( 30000 )}x` } ), [] );
	assert.ok( Date.now() - _start < 200, `${Date.now() - _start} ms for 30000 digits` );
} );

attack( SUBJECT, 'instructions name exactly the rules for the action, with the user\'s words', () => {
	const _soft = new SoftCheck( { address: 'formal', namePrices: false, exclamations: false, noContactOn: [ 'sat', 'sun' ] } );
	assert.equal( _soft.instructions( 'report' ), 'Rules of the user\'s base setup: Address people formally. Write politely and factually, without exclamation marks.' );
	assert.match( _soft.instructions( 'reply' ), /Never mention prices.*Never contact anyone outside the company on sat, sun\./ );
} );

attack( SUBJECT, 'a rule that allows something gives no instruction', () => {
	const _soft = new SoftCheck( { namePrices: true, exclamations: true, noContactOn: [] } );
	assert.equal( _soft.instructions( 'reply' ), '' );
} );

attack( SUBJECT, 'without an action the instructions cover every rule', () => {
	assert.match( strict.instructions(), /Never mention prices.*exclamation marks.*on sun/ );
} );

attack( SUBJECT, 'no instructions for a payment', () => {
	assert.equal( strict.instructions( 'payment' ), '' );
} );

attack( SUBJECT, 'informal address is said as such, formal as formal', () => {
	assert.equal( new SoftCheck( { address: 'informal' } ).instructions(), 'Rules of the user\'s base setup: Address people informally.' );
	assert.equal( new SoftCheck( { address: 'formal' } ).instructions(), 'Rules of the user\'s base setup: Address people formally.' );
} );

attack( SUBJECT, 'the address rule only instructs the writer; it never flags a text', () => {
	assert.deepEqual( flags( new SoftCheck( { address: 'formal' } ), { body: 'Hey buddy, what\'s up' } ), [] );
} );
