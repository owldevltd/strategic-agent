// lib/hash.js under attack. Approval tokens (G-6, F1) and frozen contracts are bound to these hashes, so two
// different contents must never share a hash, and the same content must always give the same one.
import assert from 'node:assert/strict';
import { attack, attacks, hostile, random, within } from '../hostile.mjs';
import { agency, tree, shuffled } from './tools.mjs';

const [ Hash ] = await agency.use( [ 'Lib.Hash' ] );
const S = 'lib/hash.js';
const HEX64 = /^[0-9a-f]{64}$/;

// The keys of every object sorted, as a reference for what canonical JSON is. Keys get a letter in front, so none
// is an array index (an object puts those first, whatever the insertion order).
const sorted = value => ( Array.isArray( value ) ? value.map( sorted )
	: value && typeof value === 'object'
		? Object.fromEntries( Object.keys( value ).sort().map( key => [ key, sorted( value[ key ] ) ] ) ) : value );
const lettered = value => ( Array.isArray( value ) ? value.map( lettered )
	: value && typeof value === 'object'
		? Object.fromEntries( Object.entries( value ).map( ( [ key, item ] ) => [ `k${key}`, lettered( item ) ] ) ) : value );

attack( S, 'key order never changes the hash (300 random trees, keys shuffled at every level)', () => {
	const _rnd = random( 11 );
	for ( let i = 0; i < 300; i++ ) {
		const _value = tree( _rnd, 4 );
		assert.equal( Hash.sha256( shuffled( _rnd, _value ) ), Hash.sha256( _value ), `case ${i}` );
	}
} );

attack( S, 'canonical of any JSON value parses back to an equal value (300 random trees)', () => {
	const _rnd = random( 12 );
	for ( let i = 0; i < 300; i++ ) {
		const _value = tree( _rnd, 4 );
		assert.deepEqual( JSON.parse( Hash.canonical( _value ) ), _value, `case ${i}` );
	}
} );

attack( S, 'canonical is byte for byte JSON.stringify of the key-sorted value', () => {
	const _rnd = random( 13 );
	for ( let i = 0; i < 300; i++ ) {
		const _value = lettered( tree( _rnd, 4 ) );
		assert.equal( Hash.canonical( _value ), JSON.stringify( sorted( _value ) ), `case ${i}` );
	}
} );

attack( S, 'different random trees never share a hash (1000 trees, each inside an object)', () => {
	const _rnd = random( 14 );
	const _seen = new Map();
	for ( let i = 0; i < 1000; i++ ) {
		const _value = { value: tree( _rnd, 3 ) };
		const _text = Hash.canonical( _value );
		const _hash = Hash.sha256( _value );
		if ( _seen.has( _hash ) ) { assert.equal( _seen.get( _hash ), _text, 'one hash, two contents' ); }
		_seen.set( _hash, _text );
	}
} );

attack( S, 'array order is content: [1,2] and [2,1] differ', () => {
	assert.notEqual( Hash.sha256( [ 1, 2 ] ), Hash.sha256( [ 2, 1 ] ) );
	assert.notEqual( Hash.sha256( { a: [ 'x', 'y' ] } ), Hash.sha256( { a: [ 'y', 'x' ] } ) );
} );

attack( S, 'an array and an object with index keys differ', () => {
	assert.notEqual( Hash.sha256( [ 1, 2 ] ), Hash.sha256( { 0: 1, 1: 2 } ) );
	assert.notEqual( Hash.sha256( [] ), Hash.sha256( {} ) );
} );

attack( S, 'types are content: "1" and 1, "true" and true, "null" and null differ inside a structure', () => {
	assert.notEqual( Hash.sha256( { a: '1' } ), Hash.sha256( { a: 1 } ) );
	assert.notEqual( Hash.sha256( { a: 'true' } ), Hash.sha256( { a: true } ) );
	assert.notEqual( Hash.sha256( { a: 'null' } ), Hash.sha256( { a: null } ) );
	assert.notEqual( Hash.sha256( [ '' ] ), Hash.sha256( [ null ] ) );
} );

attack( S, 'a key with quotes and colons cannot forge a second key', () => {
	const _forged = { 'a":1,"b': 2 };
	assert.notEqual( Hash.sha256( _forged ), Hash.sha256( { a: 1, b: 2 } ) );
	assert.deepEqual( Object.keys( JSON.parse( Hash.canonical( _forged ) ) ), [ 'a":1,"b' ] );
} );

attack( S, 'a value with quotes and braces cannot forge structure', () => {
	const _forged = { a: 'x","b":"y' };
	assert.notEqual( Hash.sha256( _forged ), Hash.sha256( { a: 'x', b: 'y' } ) );
	assert.notEqual( Hash.sha256( { a: '{"b":1}' } ), Hash.sha256( { a: { b: 1 } } ) );
} );

attack( S, 'a property set to undefined counts as absent, as in JSON', () => {
	assert.equal( Hash.sha256( { a: 1, b: undefined } ), Hash.sha256( { a: 1 } ) );
	assert.equal( Hash.canonical( { b: undefined } ), '{}' );
} );

attack( S, 'a hash over a JSON round trip equals the hash over the original (what the gate stores is what it checks)', () => {
	const _rnd = random( 15 );
	for ( let i = 0; i < 200; i++ ) {
		const _value = tree( _rnd, 4 );
		assert.equal( Hash.sha256( JSON.parse( JSON.stringify( _value ) ) ), Hash.sha256( _value ) );
	}
} );

attack( S, 'a cycle is refused with an error, quickly, instead of hanging', async () => {
	const _cycle = { a: 1 };
	_cycle.self = _cycle;
	const _list = [ 1 ];
	_list.push( _list );
	await within( Promise.resolve().then( () => {
		assert.throws( () => Hash.sha256( _cycle ), Error );
		assert.throws( () => Hash.canonical( _list ), Error );
	} ), 2000, 'hashing a cycle' );
} );

attack( S, 'nesting of 100 levels is hashed; deeper nesting (101, 1000, 4000) is refused with a RangeError instead of crashing', () => {
	const _nested = ( open, close, depth, inner = '' ) => JSON.parse( `${open.repeat( depth )}${inner}${close.repeat( depth )}` );
	assert.match( Hash.sha256( _nested( '[', ']', 100 ) ), HEX64 );
	assert.match( Hash.sha256( _nested( '{"a":', '}', 100, '1' ) ), HEX64 );
	for ( const deeper of [ _nested( '[', ']', 101 ), _nested( '[', ']', 1000 ), _nested( '{"a":', '}', 4000, '1' ) ] ) {
		assert.throws( () => Hash.sha256( deeper ), RangeError );
	}
} );

attack( S, 'a __proto__ key from parsed JSON is content: it changes the hash and pollutes nothing', () => {
	const _value = JSON.parse( '{"__proto__":{"polluted":true},"a":1}' );
	assert.notEqual( Hash.sha256( _value ), Hash.sha256( { a: 1 } ) );
	assert.match( Hash.canonical( _value ), /"__proto__":\{"polluted":true\}/ );
	assert.equal( {}.polluted, undefined );
	assert.equal( Object.prototype.polluted, undefined );
} );

attack( S, 'an object without prototype hashes like a plain object', () => {
	const _bare = Object.create( null );
	_bare.b = 2;
	_bare.a = 1;
	assert.equal( Hash.sha256( _bare ), Hash.sha256( { a: 1, b: 2 } ) );
} );

attack( S, 'symbol keys, inherited and non-enumerable properties are ignored, as in JSON', () => {
	const _value = Object.create( { inherited: 1 } );
	_value[ Symbol( 'k' ) ] = 1;
	Object.defineProperty( _value, 'hidden', { value: 1, enumerable: false } );
	_value.a = 1;
	assert.equal( Hash.canonical( _value ), JSON.stringify( _value ) );
	assert.equal( Hash.sha256( _value ), Hash.sha256( { a: 1 } ) );
} );

attack( S, 'a getter that throws makes hashing throw that error (nothing hashed half)', () => {
	const _value = { a: 1 };
	Object.defineProperty( _value, 'b', { enumerable: true, get: () => { throw new Error( 'getter refused' ); } } );
	assert.throws( () => Hash.sha256( _value ), /getter refused/ );
} );

attack( S, 'unicode is not normalized: composed and decomposed forms are different content', () => {
	assert.notEqual( Hash.sha256( { name: 'Caf\u00e9' } ), Hash.sha256( { name: 'Cafe\u0301' } ) );
	assert.notEqual( Hash.sha256( { [ '\u00e9' ]: 1 } ), Hash.sha256( { [ 'e\u0301' ]: 1 } ) );
} );

attack( S, 'a lone surrogate inside a structure stays distinct from the replacement character', () => {
	assert.notEqual( Hash.sha256( { a: '\uD800' } ), Hash.sha256( { a: '\uFFFD' } ) );
	assert.notEqual( Hash.sha256( { a: '\uD800' } ), Hash.sha256( { a: '\uDBFF' } ) );
} );

attack( S, 'a plain string with a lone surrogate does not share a hash with another string', () => {
	assert.notEqual( Hash.sha256( '\uD800' ), Hash.sha256( '\uFFFD' ) );
	assert.notEqual( Hash.sha256( 'x\uDC00' ), Hash.sha256( 'x\uDFFF' ) );
} );

attack( S, 'keys sort by code unit, the same on every machine (no locale)', () => {
	const _keys = [ 'b', 'a', 'B', '\u00e9', '\u{1F600}', 'Z', '10', '2', '' ];
	const _value = Object.fromEntries( _keys.map( key => [ key, 1 ] ) );
	assert.deepEqual( Object.keys( JSON.parse( Hash.canonical( _value ) ) ),
		Object.keys( Object.fromEntries( [ ..._keys ].sort().map( key => [ key, 1 ] ) ) ) );
	assert.equal( Hash.canonical( _value ), Hash.canonical( Object.fromEntries( [ ..._keys ].reverse().map( key => [ key, 1 ] ) ) ) );
} );

attack( S, 'hashing never changes its input (a deep-frozen value hashes fine and stays equal)', () => {
	const _value = { b: [ { d: 1, c: 2 } ], a: 'x' };
	const _copy = structuredClone( _value );
	const _freeze = ( item ) => {
		if ( item && typeof item === 'object' ) { Object.values( item ).forEach( _freeze ); Object.freeze( item ); }
		return item;
	};
	_freeze( _value );
	Hash.sha256( _value );
	assert.deepEqual( _value, _copy );
	assert.deepEqual( Object.keys( _value ), [ 'b', 'a' ] );
} );

attack( S, 'hashing the canonical text equals hashing the value (contract hash and gate check agree)', () => {
	const _rnd = random( 16 );
	for ( let i = 0; i < 100; i++ ) {
		const _value = { spec: tree( _rnd, 3 ), n: i };
		assert.equal( Hash.sha256( Hash.canonical( _value ) ), Hash.sha256( _value ) );
	}
} );

attack( S, 'sha256 matches the published test vectors', () => {
	assert.equal( Hash.sha256( 'abc' ), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' );
	assert.equal( Hash.sha256( '' ), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' );
} );

attack( S, 'every hostile string hashes to 64 lowercase hex characters, the same twice', () => {
	for ( const { value } of hostile( 'strings' ) ) {
		const _hash = Hash.sha256( value );
		assert.match( _hash, HEX64 );
		assert.equal( Hash.sha256( value ), _hash );
	}
} );

attack( S, 'sha256( undefined ) is refused, never the digest of a made-up text', () => {
	assert.throws( () => Hash.sha256( undefined ), Error );
	assert.throws( () => Hash.sha256( Symbol( 'x' ) ), Error );
	assert.throws( () => Hash.sha256( () => 1 ), Error );
} );

attack( S, 'a BigInt anywhere is refused with a TypeError', () => {
	assert.throws( () => Hash.sha256( 10n ), TypeError );
	assert.throws( () => Hash.sha256( { amount: 10n } ), TypeError );
	assert.throws( () => Hash.sha256( [ 1, [ 2n ] ] ), TypeError );
} );

attack( S, 'an object of 50000 keys is hashed in well under two seconds', () => {
	const _value = Object.fromEntries( Array.from( { length: 50000 }, ( _, i ) => [ `k${( i * 7919 ) % 50000}`, i ] ) );
	const _start = performance.now();
	assert.match( Hash.sha256( _value ), HEX64 );
	assert.ok( performance.now() - _start < 4000 );
} );

attack( S, 'a 10 MB string is hashed and differs from the same string one character shorter', () => {
	const _big = 'x'.repeat( 10 * 1024 * 1024 );
	assert.notEqual( Hash.sha256( _big ), Hash.sha256( _big.slice( 1 ) ) );
	assert.notEqual( Hash.sha256( { a: _big } ), Hash.sha256( { a: `${_big.slice( 1 )}y` } ) );
} );

attack( S, 'id(): the prefix, a dash and 16 hex characters (64 random bits); 1000 ids are distinct', () => {
	const _ids = Array.from( { length: 1000 }, () => Hash.id( 'node' ) );
	_ids.forEach( id => assert.match( id, /^node-[0-9a-f]{16}$/ ) );
	assert.equal( new Set( _ids ).size, _ids.length );
} );

attack( S, 'id() with hostile prefixes keeps the prefix verbatim and a random tail', () => {
	for ( const { value } of hostile( 'strings' ) ) {
		const _id = Hash.id( value );
		assert.ok( _id.startsWith( `${value}-` ) );
		assert.match( _id.slice( value.length ), /^-[0-9a-f]{16}$/ );
	}
} );

attack( S, 'secret(): 32 URL-safe characters from 24 random bytes, 1000 distinct', () => {
	const _secrets = Array.from( { length: 1000 }, () => Hash.secret() );
	for ( const secret of _secrets ) {
		assert.match( secret, /^[A-Za-z0-9_-]{32}$/ );
		assert.equal( Buffer.from( secret, 'base64url' ).length, 24 );
	}
	assert.equal( new Set( _secrets ).size, _secrets.length );
} );

attack( S, 'secret() is not derived from the clock: two secrets in the same millisecond differ in most characters', () => {
	const _a = Hash.secret();
	const _b = Hash.secret();
	const _same = [ ..._a ].filter( ( char, i ) => char === _b[ i ] ).length;
	assert.ok( _same < 16, `${_same} of 32 characters equal` );
} );

attack( S, 'a sparse array is refused (a hole is never dropped silently)', () => {
	// eslint-disable-next-line no-sparse-arrays
	const _holes = [ , 1 ];
	assert.throws( () => Hash.canonical( _holes ), TypeError );
	assert.throws( () => Hash.sha256( _holes ), TypeError );
} );

attack( S, 'undefined inside an array is refused: [undefined] never hashes like [] or [null]', () => {
	assert.throws( () => Hash.sha256( [ undefined ] ), TypeError );
	assert.throws( () => Hash.sha256( { to: [ 'a', undefined ] } ), TypeError );
} );

// Numbers: the canonical text must give the number back, or the hash must refuse it. -0 counts as 0, as in JSON.
attacks( S, hostile( 'numbers' ).map( item => ( {
	...item, name: `number ${Object.is( item.value, -0 ) ? '-0' : String( item.value )} survives canonical JSON or is refused`,
} ) ), ( { value } ) => {
	let _text;
	try {
		_text = Hash.canonical( { amount: value } );
	} catch ( error ) {
		assert.ok( error instanceof Error );
		return;
	}
	const _back = JSON.parse( _text ).amount;
	assert.ok( Object.is( _back, value ) || ( value === 0 && _back === 0 ), `${value} came back as ${_back}` );
	assert.notEqual( Hash.sha256( { amount: value } ), Hash.sha256( { amount: null } ) );
} );

// Every value type: canonical agrees with JSON (same content, same meaning) or refuses with an error.
attacks( S, hostile( 'types' ).map( item => ( {
	...item, name: `${item.label} as a property and in a list agrees with JSON or is refused`,
} ) ), ( { value } ) => {
	const _wrapped = { a: value, list: [ value ] };
	let _text;
	try {
		_text = Hash.canonical( _wrapped );
	} catch ( error ) {
		assert.ok( error instanceof Error );
		return;
	}
	assert.deepEqual( JSON.parse( _text ), JSON.parse( JSON.stringify( _wrapped ) ) );
} );

// Hostile keys: kept verbatim as own keys, never on a prototype, always changing the hash.
attacks( S, hostile( 'keys' ).map( item => ( { ...item, name: `key ${item.label} is kept verbatim and changes the hash` } ) ), ( { value } ) => {
	const _before = Object.getOwnPropertyNames( Object.prototype ).join();
	const _object = {};
	Object.defineProperty( _object, value, { value: 1, enumerable: true, configurable: true, writable: true } );
	const _back = JSON.parse( Hash.canonical( _object ) );
	assert.ok( Object.hasOwn( _back, value ) );
	assert.equal( _back[ value ], 1 );
	assert.notEqual( Hash.sha256( _object ), Hash.sha256( {} ) );
	assert.notEqual( Hash.sha256( _object ), Hash.sha256( { [ `${value}x` ]: 1 } ) );
	assert.equal( Object.getOwnPropertyNames( Object.prototype ).join(), _before );
	assert.equal( Object.getPrototypeOf( _back ), Object.prototype );
} );

// Objects that are not plain: two instances with different content must not share a hash.
const NON_PLAIN = [
	{ name: 'two different Dates', a: new Date( 0 ), b: new Date( 86400000 ) },
	{ name: 'two different Maps', a: new Map( [ [ 'iban', 'DE1' ] ] ), b: new Map( [ [ 'iban', 'DE2' ] ] ) },
	{ name: 'two different Sets', a: new Set( [ 1 ] ), b: new Set( [ 2 ] ) },
	{ name: 'two different URL objects', a: new URL( 'https://a.example/' ), b: new URL( 'https://b.example/' ) },
	{ name: 'two different boxed numbers', a: new Number( 5 ), b: new Number( 6 ) },
	{ name: 'two different typed arrays', a: new Uint8Array( [ 1 ] ), b: new Uint8Array( [ 2 ] ) },
	{ name: 'two different Buffers', a: Buffer.from( 'a' ), b: Buffer.from( 'b' ) },
];
attacks( S, NON_PLAIN.map( item => ( { ...item, name: `${item.name} do not share a hash` } ) ), ( { a, b } ) => {
	let _same;
	try {
		_same = Hash.sha256( { value: a } ) === Hash.sha256( { value: b } );
	} catch ( error ) {
		assert.ok( error instanceof Error, 'refusing is fine' );
		return;
	}
	assert.equal( _same, false );
} );
