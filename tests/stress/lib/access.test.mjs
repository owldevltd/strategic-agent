// lib/access.js under attack: the one guard of every secret (the gate's operator pin, the core token, the board pin,
// the inbound token). Wrong types, near misses, header against body, guessing with a fake clock, and the rule that
// without a secret nothing is guarded (development only).
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { agency } from './tools.mjs';

const S = 'lib/access.js';
const [ Access ] = await agency.use( [ 'Lib.Access' ] );
const SECRET = 'river-4711-lake';

// An access with a clock the test moves and a log that records what it says.
function guard( secret = SECRET, extra = {} ) {
	const _clock = { now: Date.parse( '2026-11-05T09:00:00Z' ) };
	const _log = [];
	const _access = new Access( {
		secret, name: 'TEST_PIN', header: 'x-test-pin', log: { append: ( kind, data ) => _log.push( { kind, data } ) }, now: () => _clock.now, ...extra,
	} );
	return { access: _access, clock: _clock, log: _log };
}
const req = ( headers = {} ) => ( { headers } );

attacks( S, [
	{ name: 'same: the same text is the same', given: SECRET, want: true },
	{ name: 'same: a trailing space is another text', given: `${SECRET} `, want: false },
	{ name: 'same: a leading space is another text', given: ` ${SECRET}`, want: false },
	{ name: 'same: upper case is another text', given: SECRET.toUpperCase(), want: false },
	{ name: 'same: the first half is another text', given: SECRET.slice( 0, 7 ), want: false },
	{ name: 'same: the text with one more character is another text', given: `${SECRET}x`, want: false },
	{ name: 'same: the empty text is another text', given: '', want: false },
	{ name: 'same: the composed and the decomposed accent are different texts', given: 'café', secret: 'café', want: false },
	{ name: 'same: a text of a megabyte is compared without throwing', given: 'x'.repeat( 1024 * 1024 ), want: false },
	{ name: 'same: unicode is compared as written', given: 'Zürich-🔑', secret: 'Zürich-🔑', want: true },
], ( { given, secret = SECRET, want } ) => {
	assert.equal( Access.same( given, secret ), want );
} );

attacks( S, [
	{ name: 'check: without a header or field the answer is missing', given: '', want: 'missing' },
	{ name: 'check: null is missing', given: null, want: 'missing' },
	{ name: 'check: undefined is missing', given: undefined, want: 'missing' },
	{ name: 'check: a number is missing, never compared', given: 4711, want: 'missing' },
	{ name: 'check: a list holding the secret is missing', given: [ SECRET ], want: 'missing' },
	{ name: 'check: an object printing the secret is missing', given: { toString: () => SECRET }, want: 'missing' },
	{ name: 'check: true is missing', given: true, want: 'missing' },
	{ name: 'check: a query operator object is missing', given: { $ne: '' }, want: 'missing' },
	{ name: 'check: the right text is ok', given: SECRET, want: 'ok' },
	{ name: 'check: a near miss is wrong', given: `${SECRET}!`, want: 'wrong' },
], ( { given, want } ) => {
	assert.equal( guard().access.check( given ), want );
} );

attacks( S, [
	{ name: 'given: the header carries the secret', headers: { 'x-test-pin': SECRET }, body: null, field: null, want: SECRET },
	{ name: 'given: the header wins over the body field', headers: { 'x-test-pin': SECRET }, body: { pin: 'other' }, field: 'pin', want: SECRET },
	{ name: 'given: without the header, the body field named counts', headers: {}, body: { pin: SECRET }, field: 'pin', want: SECRET },
	{ name: 'given: a body field counts only when the route names one', headers: {}, body: { pin: SECRET }, field: null, want: '' },
	{ name: 'given: another header does not count', headers: { 'x-pin': SECRET, authorization: SECRET }, body: null, field: 'pin', want: '' },
	{ name: 'given: an empty header falls back to the body field', headers: { 'x-test-pin': '' }, body: { pin: SECRET }, field: 'pin', want: SECRET },
	{ name: 'given: a body that is a list carries nothing', headers: {}, body: [ SECRET ], field: 'pin', want: '' },
	{ name: 'given: a field that is no text carries nothing', headers: {}, body: { pin: [ SECRET ] }, field: 'pin', want: '' },
	{ name: 'given: a field nested deeper carries nothing', headers: {}, body: { by: { pin: SECRET } }, field: 'pin', want: '' },
	{ name: 'given: a field only on the prototype carries nothing', headers: {}, body: Object.create( { pin: SECRET } ), field: 'pin', want: '' },
	{ name: 'given: a request without headers carries nothing', headers: undefined, body: null, field: null, want: '' },
	{ name: 'given: a header given twice (a list) carries nothing', headers: { 'x-test-pin': [ SECRET, SECRET ] }, body: null, field: null, want: '' },
], ( { headers, body, field, want } ) => {
	assert.equal( guard().access.given( { headers }, body, field ), want );
} );

attack( S, 'given: a JSON body cannot put the secret on the prototype: "__proto__" is a field of its own', () => {
	const _body = JSON.parse( `{ "__proto__": { "pin": "${SECRET}" } }` );
	assert.equal( guard().access.given( req(), _body, 'pin' ), '' );
} );

attacks( S, [
	{ name: 'secret: shorter than the minimum stops the start', secret: '12345', min: 6, throws: /TEST_PIN needs at least 6 characters/ },
	{ name: 'secret: one character stops the start', secret: 'x', min: 6, throws: /at least 6/ },
	{ name: 'secret: a token below its own minimum stops the start', secret: 'short-token', min: 24, throws: /at least 24/ },
	{ name: 'secret: exactly the minimum is taken', secret: '123456', min: 6, throws: null },
	{ name: 'secret: none is taken, and guards nothing', secret: '', min: 6, throws: null },
	{ name: 'secret: undefined is none', secret: undefined, min: 6, throws: null },
	{ name: 'secret: a number is none, never a secret', secret: 123456789, min: 6, throws: null },
], ( { secret, min, throws } ) => {
	const _make = () => new Access( { secret, name: 'TEST_PIN', header: 'x-test-pin', min } );
	if ( throws ) { assert.throws( _make, throws ); } else { assert.doesNotThrow( _make ); }
} );

attacks( S, [
	{ name: 'off: without a secret a request without anything passes', given: '' },
	{ name: 'off: without a secret any text passes', given: 'anything' },
	{ name: 'off: without a secret even a list passes', given: [ 'x' ] },
], ( { given } ) => {
	const { access } = guard( '' );
	assert.equal( access.on, false );
	assert.equal( access.check( given ), 'ok' );
} );

attack( S, 'on: a secret set is on', () => {
	assert.equal( guard().access.on, true );
} );

attack( S, 'lock: four wrong answers leave the right one working', () => {
	const { access } = guard();
	for ( let i = 0; i < Access.TRIES - 1; i++ ) { assert.equal( access.check( `guess-${i}` ), 'wrong' ); }
	assert.equal( access.check( SECRET ), 'ok' );
} );

attack( S, 'lock: after TRIES wrong answers even the right one is refused while locked, and logged once', () => {
	const { access, log } = guard();
	for ( let i = 0; i < Access.TRIES; i++ ) { access.check( `guess-${i}` ); }
	assert.equal( access.check( SECRET ), 'locked' );
	assert.equal( access.check( 'guess-x' ), 'locked' );
	assert.deepEqual( log.map( item => [ item.kind, item.data.secret ] ), [ [ 'access_locked', 'TEST_PIN' ] ] );
} );

attack( S, 'lock: it ends after LOCK_MS, and the right answer then works', () => {
	const { access, clock } = guard();
	for ( let i = 0; i < Access.TRIES; i++ ) { access.check( `guess-${i}` ); }
	clock.now += Access.LOCK_MS - 1;
	assert.equal( access.check( SECRET ), 'locked' );
	clock.now += 1;
	assert.equal( access.check( SECRET ), 'ok' );
} );

attack( S, 'lock: every new round of wrong answers locks twice as long', () => {
	const { access, clock } = guard();
	const _round = () => {
		for ( let i = 0; i < Access.TRIES; i++ ) { access.check( `guess-${i}` ); }
	};
	_round();
	clock.now += Access.LOCK_MS;
	_round();
	clock.now += Access.LOCK_MS;
	assert.equal( access.check( SECRET ), 'locked', 'the second lock is longer than the first' );
	clock.now += Access.LOCK_MS;
	assert.equal( access.check( SECRET ), 'ok' );
} );

attack( S, 'lock: never longer than LOCK_MAX_MS, however long the guessing goes on', () => {
	const { access, clock } = guard();
	for ( let round = 0; round < 20; round++ ) {
		for ( let i = 0; i < Access.TRIES; i++ ) { access.check( `guess-${i}` ); }
		clock.now += Access.LOCK_MAX_MS;
	}
	assert.equal( access.check( SECRET ), 'ok' );
} );

attack( S, 'lock: the right answer after a lock ended starts the count from zero', () => {
	const { access, clock } = guard();
	for ( let i = 0; i < Access.TRIES; i++ ) { access.check( `guess-${i}` ); }
	clock.now += Access.LOCK_MS;
	assert.equal( access.check( SECRET ), 'ok' );
	for ( let i = 0; i < Access.TRIES - 1; i++ ) { access.check( `guess-${i}` ); }
	assert.equal( access.check( SECRET ), 'ok' );
} );

attack( S, 'lock: missing answers are no guesses and lock nothing', () => {
	const { access } = guard();
	for ( let i = 0; i < 50; i++ ) { assert.equal( access.check( '' ), 'missing' ); }
	assert.equal( access.check( SECRET ), 'ok' );
} );

attack( S, 'lock: two guards keep their own count: guessing one locks only that one', () => {
	const _one = guard();
	const _two = guard( 'another-secret-99' );
	for ( let i = 0; i < Access.TRIES; i++ ) { _one.access.check( `guess-${i}` ); }
	assert.equal( _one.access.check( SECRET ), 'locked' );
	assert.equal( _two.access.check( 'another-secret-99' ), 'ok' );
} );

attacks( S, [
	{ name: 'refusal: locked is 429 and says to wait', result: 'locked', want: [ 429, /try again later/ ] },
	{ name: 'refusal: wrong is 403 with what is needed', result: 'wrong', want: [ 403, /test pin required/ ] },
	{ name: 'refusal: missing is 403 with what is needed', result: 'missing', want: [ 403, /test pin required/ ] },
], ( { result, want } ) => {
	const { access } = guard( SECRET, { missing: 'test pin required' } );
	const [ _status, _body ] = access.refusal( result );
	assert.equal( _status, want[ 0 ] );
	assert.match( _body.error, want[ 1 ] );
	assert.ok( !_body.error.includes( SECRET ), 'a refusal never names the secret' );
} );

attack( S, 'refusal: without its own text the refusal names the header', () => {
	const [ , _body ] = new Access( { secret: SECRET, name: 'X', header: 'x-own' } ).refusal( 'missing' );
	assert.equal( _body.error, 'x-own required' );
} );

attack( S, 'lock: without a log the lock still holds', () => {
	const _access = new Access( { secret: SECRET, name: 'X', header: 'x-own' } );
	for ( let i = 0; i < Access.TRIES; i++ ) { _access.check( `guess-${i}` ); }
	assert.equal( _access.check( SECRET ), 'locked' );
} );
