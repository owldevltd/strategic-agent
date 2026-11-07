// core/criteria/criterion.js, part 1: the parameter checks every type relies on (validate, CHECKS, K2 windows,
// '@actions'), attacked with missing, mistyped and hostile values.
import { Actions, Criterion, assert, attack, attacks, corpus, registry } from './kit.mjs';

const S = 'core/criteria/criterion.js';
const check = ( value, param ) => Criterion.checkParam( value, param );
const A = '2026-11-09T08:00:00.000Z';
const B = '2026-11-13T17:00:00.000Z';

attacks( S, [
	{ name: 'a required value that is undefined is missing', value: undefined, param: { type: 'string' }, want: 'is missing' },
	{ name: 'a required value that is null is missing', value: null, param: { type: 'number' }, want: 'is missing' },
	{ name: 'a required value that is the empty string is missing', value: '', param: { type: 'string' }, want: 'is missing' },
	{ name: 'an optional value that is absent is no problem', value: undefined, param: { type: 'string', optional: true }, want: null },
	{ name: 'zero is a value, not a missing one (a tolerance of 0)', value: 0, param: { type: 'number', min: 0 }, want: null },
	{ name: 'false is a value, not a missing one', value: false, param: { type: 'boolean' }, want: null },
	{ name: 'a whitespace-only string is text, not missing', value: ' \t', param: { type: 'string' }, want: null },
], ( { value, param, want } ) => {
	assert.equal( check( value, param ), want );
} );

attacks( S, [
	{ name: 'integer: 2 with min 2 passes', value: 2, ok: true },
	{ name: 'integer: 1 below min 2 is refused and the message names the bound', value: 1, ok: false, says: />= 2/ },
	{ name: 'integer: 2.5 is no integer', value: 2.5, ok: false },
	{ name: 'integer: the text "2" is no integer', value: '2', ok: false },
	{ name: 'integer: NaN is no integer', value: NaN, ok: false },
	{ name: 'integer: Infinity is no integer', value: Infinity, ok: false },
	{ name: 'integer: the BigInt 10n is refused', value: 10n, ok: false },
	{ name: 'integer: true is refused', value: true, ok: false },
	{ name: 'integer: 2 inside an array is refused', value: [ 2 ], ok: false },
], ( { value, ok, says } ) => {
	const _problem = check( value, { type: 'integer', min: 2 } );
	assert.equal( _problem === null, ok );
	if ( says ) { assert.match( _problem, says ); }
} );

attacks( S, [
	{ name: 'number: -1 below min 0 is refused (K6)', value: -1, ok: false },
	{ name: 'number: -0 with min 0 passes', value: -0, ok: true },
	{ name: 'number: the smallest denormal 5e-324 passes', value: 5e-324, ok: true },
	{ name: 'number: the text "5" is refused', value: '5', ok: false },
	{ name: 'number: the BigInt 5n is refused', value: 5n, ok: false },
	{ name: 'number: NaN is not a number a range or tolerance can mean', value: NaN, ok: false },
	{ name: 'number: a Number object is refused', value: Object( 5 ), ok: false },
], ( { value, ok } ) => {
	assert.equal( check( value, { type: 'number', min: 0 } ) === null, ok );
} );

attack( S, 'a number parameter without a minimum explains itself without printing "undefined"', () => {
	const _problem = check( 'five', { type: 'number' } );
	assert.ok( _problem );
	assert.doesNotMatch( _problem, /undefined/ );
} );

attacks( S, [
	{ name: 'list: an empty list is refused', value: [], ok: false },
	{ name: 'list: a single string is no list', value: 'payment', ok: false },
	{ name: 'list: an array-like object is no list', value: { length: 1, 0: 'payment' }, ok: false },
	{ name: 'list @actions: an action, a class and "outward" pass', value: [ 'payment', 'carries:money', 'outward' ], ok: true },
	{ name: 'list @actions: an unknown action is refused', value: [ 'wire' ], ok: false },
	{ name: 'list @actions: one unknown among known ones spoils the list', value: [ 'payment', 'wire' ], ok: false },
	{ name: 'list @actions: a prototype key is no action', value: [ '__proto__' ], ok: false },
	{ name: 'list @actions: a class with trailing space is no class', value: [ 'carries:money ' ], ok: false },
], ( { value, ok } ) => {
	assert.equal( check( value, { type: 'list', values: '@actions' } ) === null, ok );
} );

attacks( S, [
	{ name: 'string @actions: a known class passes', value: 'carries:data', ok: true },
	{ name: 'string @actions: an empty class "carries:" is refused', value: 'carries:', ok: false },
	{ name: 'string @actions: a different case is another action', value: 'Payment', ok: false },
	{ name: 'string: a Symbol is refused as text, not a crash', value: Symbol( 'payment' ), ok: false },
	{ name: 'string: a String object is refused', value: Object( 'payment' ), ok: false },
], ( { value, ok } ) => {
	assert.equal( check( value, { type: 'string', values: '@actions' } ) === null, ok );
} );

attacks( S, [
	{ name: 'datetime: an ISO time in UTC passes', value: '2026-11-06T12:00:00Z', ok: true },
	{ name: 'datetime: an ISO time with an offset passes', value: '2026-11-06T12:00:00+14:00', ok: true },
	{ name: 'datetime: "tomorrow" is no time', value: 'tomorrow', ok: false },
	{ name: 'datetime: hour 25 is no time', value: '2026-11-04T25:00:00Z', ok: false },
	{ name: 'datetime: an epoch number is refused', value: 1793836800000, ok: false },
	{ name: 'datetime: the last representable instant passes', value: '+275760-09-13T00:00:00.000Z', ok: true },
	{ name: 'datetime: one ms after the last representable instant is refused', value: '+275760-09-13T00:00:00.001Z', ok: false },
	{ name: 'datetime: 30 February does not exist and must not roll over to 2 March', value: '2026-02-30T00:00:00Z', ok: false },
	{ name: 'datetime: the text "1" is no date and time', value: '1', ok: false },
	{ name: 'datetime: a list holding a date is no date', value: [ '2026-11-06T12:00:00Z' ], ok: false },
	{ name: 'datetime: a Symbol is refused, not a TypeError', value: Symbol( 'x' ), ok: false },
], ( { value, ok } ) => {
	assert.equal( check( value, { type: 'datetime' } ) === null, ok );
} );

attacks( S, [
	{ name: 'window: start before end passes', value: [ A, B ], want: null },
	{ name: 'window K2: start after end is refused', value: [ B, A ], want: /K2/ },
	{ name: 'window K2: an empty window (start equals end) is refused', value: [ A, A ], want: /K2/ },
	{ name: 'window: one time alone is no window', value: [ A ], want: /must be a window/ },
	{ name: 'window: three times are no window', value: [ A, B, B ], want: /must be a window/ },
	{ name: 'window: a string with both times is no window', value: `${A}/${B}`, want: /must be a window/ },
	{ name: 'window: null as start is no window', value: [ null, B ], want: /must be a window/ },
	{ name: 'window: an unreadable end is no window', value: [ A, 'next friday' ], want: /must be a window/ },
	{ name: 'window: the same instant in two offsets is still empty (K2)', value: [ '2026-11-09T09:00:00+01:00', '2026-11-09T08:00:00Z' ], want: /K2/ },
	{ name: 'window: nested lists are no window', value: [ [ A ], [ B ] ], want: /must be a window/ },
	{ name: 'window: a Symbol inside is refused, not a TypeError', value: [ Symbol( 'a' ), B ], want: /must be a window/ },
], ( { value, want } ) => {
	const _problem = check( value, { type: 'window' } );
	if ( want === null ) {
		assert.equal( _problem, null );
	} else {
		assert.match( String( _problem ), want );
	}
} );

attacks( S, [
	{ name: 'boolean: the text "true" is refused', value: 'true', ok: false },
	{ name: 'boolean: 1 is refused', value: 1, ok: false },
	{ name: 'boolean: true passes', value: true, ok: true },
	{ name: 'object: a list is no object', value: [ 1 ], ok: false, type: 'object' },
	{ name: 'object: text is no object', value: '{"caught":9}', ok: false, type: 'object' },
	{ name: 'object: a function is no object', value: () => 1, ok: false, type: 'object' },
	{ name: 'object: a plain object passes', value: { caught: 9, of: 10 }, ok: true, type: 'object' },
], ( { value, ok, type = 'boolean' } ) => {
	assert.equal( check( value, { type } ) === null, ok );
} );

attacks( S, corpus( 'types', 'numbers' ).map( item => ( { ...item, name: `a required text parameter refuses ${item.label} cleanly` } ) ), ( { value } ) => {
	const _problem = check( value, { type: 'string' } );
	assert.equal( _problem, value === null || value === undefined ? 'is missing' : 'must be text' );
} );

attack( S, 'every parameter type any registered criterion declares has a check, so no parameter goes unchecked', () => {
	const _types = Object.values( registry.types ).flatMap( Type => Object.values( Type.PARAMS ).map( param => param.type ) );
	assert.ok( _types.length > 20 );
	assert.deepEqual( _types.filter( type => !Criterion.CHECKS[ type ] ), [] );
} );

attack( S, '"@actions" stands for every action, every class and "outward", each once, and never for "*"', () => {
	const _values = Criterion.values( { values: '@actions' } );
	const _table = Actions.load().table;
	assert.ok( Object.keys( _table ).every( action => _values.includes( action ) ) );
	assert.ok( [ 'carries:money', 'carries:data', 'carries:message', 'outward' ].every( item => _values.includes( item ) ) );
	assert.equal( new Set( _values ).size, _values.length );
	assert.ok( !_values.includes( '*' ) );
} );

attack( S, 'an explicit list of values is used as given; without one any value is allowed', () => {
	assert.deepEqual( Criterion.values( { values: [ 'a', 'b' ] } ), [ 'a', 'b' ] );
	assert.equal( Criterion.values( {} ), null );
	assert.match( check( 'c', { type: 'string', values: [ 'a', 'b' ] } ), /one of a, b/ );
} );

attacks( S, [
	{ name: 'inWindow: the start itself is inside', time: A, inside: true },
	{ name: 'inWindow: the end itself is inside', time: B, inside: true },
	{ name: 'inWindow: 1 ms before the start is outside', time: '2026-11-09T07:59:59.999Z', inside: false },
	{ name: 'inWindow: 1 ms after the end is outside', time: '2026-11-13T17:00:00.001Z', inside: false },
	{ name: 'inWindow: the start written as +14:00 is the same instant', time: '2026-11-09T22:00:00+14:00', inside: true },
	{ name: 'inWindow: an unreadable time is never inside', time: 'Wednesday 10 am', inside: false },
	{ name: 'inWindow: an epoch number is never inside', time: Date.parse( A ) + 1000, inside: false },
	{ name: 'inWindow: no time at all is never inside', time: undefined, inside: false },
], ( { time, inside } ) => {
	assert.equal( Criterion.inWindow( time, [ A, B ] ), inside );
} );

attack( S, 'inWindow without a window lets every time through; types only call it with a validated window', () => {
	assert.equal( Criterion.inWindow( 'garbage', undefined ), true );
	assert.equal( Criterion.inWindow( A, null ), true );
} );
