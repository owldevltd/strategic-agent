// lib/db.js under attack, part 2: what goes in through named parameters. Hostile text is data, never SQL; a value
// that cannot be stored is refused before anything is written; what can be written can be read back; and errors
// never quote the values that caused them.
import assert from 'node:assert/strict';
import { attack, attacks, hostile } from '../hostile.mjs';
import { agency } from './tools.mjs';

const [ Db ] = await agency.use( [ 'Lib.Db' ] );
const S = 'lib/db.js';

const table = () => {
	const _db = new Db( ':memory:' );
	_db.exec( 'CREATE TABLE v ( id INTEGER PRIMARY KEY, x ); CREATE TABLE guard ( g TEXT ); INSERT INTO guard VALUES ( \'intact\' )' );
	return _db;
};
const rows = db => db.get( 'SELECT COUNT(*) AS n FROM v' ).n;

attack( S, 'an unknown named parameter is refused, not ignored (a typo cannot write NULL silently)', () => {
	const _db = table();
	assert.throws( () => _db.run( 'INSERT INTO v ( x ) VALUES ( :x )', { x: 1, y: 2 } ), /Unknown named parameter/ );
	assert.equal( rows( _db ), 0 );
} );

attack( S, 'the prefixes :name, $name and @name all bind by name', () => {
	const _db = table();
	assert.deepEqual( { ..._db.get( 'SELECT :a AS a, $b AS b, @c AS c', { a: 1, b: 2, c: 3 } ) }, { a: 1, b: 2, c: 3 } );
} );

attack( S, 'positional parameters as an array are refused (Db binds by name only)', () => {
	const _db = table();
	assert.throws( () => _db.run( 'INSERT INTO v ( x ) VALUES ( ? )', [ 1 ] ), Error );
	assert.equal( rows( _db ), 0 );
} );

attack( S, 'params that are null or a string are refused with an error, nothing written', () => {
	const _db = table();
	assert.throws( () => _db.run( 'INSERT INTO v ( x ) VALUES ( :x )', null ), Error );
	assert.throws( () => _db.run( 'INSERT INTO v ( x ) VALUES ( :x )', 'x' ), Error );
	assert.equal( rows( _db ), 0 );
} );

attack( S, 'a parsed "__proto__" key in params is refused as unknown and pollutes nothing', () => {
	const _db = table();
	assert.throws( () => _db.run( 'INSERT INTO v ( x ) VALUES ( :x )', JSON.parse( '{"x":1,"__proto__":{"polluted":1}}' ) ), /Unknown named parameter/ );
	assert.equal( {}.polluted, undefined );
	assert.equal( rows( _db ), 0 );
} );

attack( S, 'inherited properties of params are not bound', () => {
	const _db = table();
	const _params = Object.create( { x: 'inherited' } );
	assert.equal( _db.get( 'SELECT :x AS x', _params ).x, null );
} );

attack( S, 'a column named __proto__ or constructor comes back as an own field and pollutes nothing', () => {
	const _db = table();
	const _row = _db.get( 'SELECT 1 AS "__proto__", 2 AS "constructor", \'{"polluted":1}\' AS "prototype"' );
	assert.deepEqual( Object.getOwnPropertyNames( _row ), [ '__proto__', 'constructor', 'prototype' ] );
	assert.equal( {}.polluted, undefined );
	assert.equal( Object.prototype.constructor, Object );
} );

attack( S, 'a syntax error does not quote the bound values', () => {
	const _db = table();
	assert.throws( () => _db.get( 'SELEC :secret', { secret: 'sk-live-0123456789' } ), ( error ) => {
		assert.ok( !error.message.includes( 'sk-live' ) );
		return true;
	} );
} );

attack( S, 'a UNIQUE violation names the column, never the value', () => {
	const _db = new Db( ':memory:' );
	_db.exec( 'CREATE TABLE k ( token TEXT UNIQUE )' );
	_db.run( 'INSERT INTO k VALUES ( :t )', { t: 'tok-secret-42' } );
	assert.throws( () => _db.run( 'INSERT INTO k VALUES ( :t )', { t: 'tok-secret-42' } ), ( error ) => {
		assert.match( error.message, /UNIQUE constraint failed: k\.token/ );
		assert.ok( !error.message.includes( 'tok-secret-42' ) );
		return true;
	} );
} );

attack( S, 'a CHECK or NOT NULL violation never quotes the value either', () => {
	const _db = new Db( ':memory:' );
	_db.exec( 'CREATE TABLE c ( iban TEXT NOT NULL CHECK ( length( iban ) < 5 ) )' );
	assert.throws( () => _db.run( 'INSERT INTO c VALUES ( :iban )', { iban: 'DE89370400440532013000' } ), ( error ) => {
		assert.ok( !error.message.includes( 'DE8937' ) );
		return true;
	} );
	assert.throws( () => _db.run( 'INSERT INTO c VALUES ( :iban )', { iban: null } ), /NOT NULL/ );
} );

attack( S, 'a missing named parameter binds NULL (documented: names are checked one way only)', () => {
	const _db = table();
	assert.equal( _db.get( 'SELECT :absent AS a', {} ).a, null );
} );

attack( S, 'BigInt beyond 64 bits is refused before anything is written', () => {
	const _db = table();
	assert.throws( () => _db.run( 'INSERT INTO v ( x ) VALUES ( :x )', { x: 2n ** 70n } ), Error );
	assert.equal( rows( _db ), 0 );
} );

attack( S, 'a 64-bit integer that can be written can also be read back', () => {
	const _db = table();
	_db.run( 'INSERT INTO v ( x ) VALUES ( :x )', { x: 9007199254740993n } );
	let _row;
	assert.doesNotThrow( () => { _row = _db.get( 'SELECT x FROM v' ); } );
	assert.equal( BigInt( _row.x ), 9007199254740993n );
} );

attack( S, 'a 10 MB text survives the round trip', () => {
	const _db = table();
	const _big = `${'ä'.repeat( 5 * 1024 * 1024 )}end`;
	_db.run( 'INSERT INTO v ( x ) VALUES ( :x )', { x: _big } );
	assert.equal( _db.get( 'SELECT x FROM v' ).x, _big );
} );

attack( S, 'a Buffer is stored as a blob and comes back with the same bytes', () => {
	const _db = table();
	const _bytes = Buffer.from( Array.from( { length: 256 }, ( _, i ) => i ) );
	_db.run( 'INSERT INTO v ( x ) VALUES ( :x )', { x: _bytes } );
	assert.deepEqual( Buffer.from( _db.get( 'SELECT x FROM v' ).x ), _bytes );
} );

attack( S, 'a lone surrogate is not changed into another character silently', () => {
	const _db = table();
	_db.run( 'INSERT INTO v ( x ) VALUES ( :x )', { x: 'a\uD800b' } );
	assert.equal( _db.get( 'SELECT x FROM v' ).x, 'a\uD800b' );
} );

attack( S, 'get() of no row gives undefined and all() gives an empty list', () => {
	const _db = table();
	assert.equal( _db.get( 'SELECT * FROM v WHERE id = :id', { id: 1 } ), undefined );
	assert.deepEqual( _db.all( 'SELECT * FROM v' ), [] );
} );

attack( S, 'all() returns 50000 rows in insert order', () => {
	const _db = table();
	_db.transaction( () => { for ( let i = 0; i < 50000; i++ ) { _db.run( 'INSERT INTO v ( x ) VALUES ( :i )', { i } ); } } );
	const _all = _db.all( 'SELECT x FROM v ORDER BY id' );
	assert.equal( _all.length, 50000 );
	assert.ok( _all.every( ( row, i ) => row.x === i ) );
} );

const injected = ( db ) => {
	assert.equal( db.get( 'SELECT g FROM guard' ).g, 'intact', 'injected SQL ran' );
	assert.equal( db.get( 'SELECT COUNT(*) AS n FROM sqlite_master WHERE type = \'table\'' ).n, 2 );
};

// Hostile text: stored and read back exactly, in a value and in a WHERE, and never executed.
attacks( S, hostile( 'strings' ).map( item => ( { ...item, name: `text ${item.label} is data: stored, found and read back exactly` } ) ), ( { value } ) => {
	const _db = table();
	_db.run( 'INSERT INTO v ( x ) VALUES ( :x )', { x: value } );
	assert.equal( _db.get( 'SELECT x FROM v' ).x, value );
	assert.equal( _db.get( 'SELECT COUNT(*) AS n FROM v WHERE x = :x', { x: value } ).n, 1 );
	assert.equal( _db.get( 'SELECT COUNT(*) AS n FROM v WHERE x = :x', { x: `${value}'` } ).n, 0 );
	injected( _db );
} );

// Numbers: what SQLite can hold comes back equal (-0 as 0); NaN must not turn into NULL without a word.
attacks( S, hostile( 'numbers' ).map( item => ( {
	...item, name: `number ${Object.is( item.value, -0 ) ? '-0' : String( item.value )} is stored exactly or refused`,
} ) ), ( { value } ) => {
	const _db = table();
	try {
		_db.run( 'INSERT INTO v ( x ) VALUES ( :x )', { x: value } );
	} catch ( error ) {
		assert.ok( error instanceof Error );
		assert.equal( rows( _db ), 0 );
		return;
	}
	const _back = _db.get( 'SELECT x FROM v' ).x;
	assert.ok( Object.is( _back, value ) || ( value === 0 && _back === 0 ), `${value} came back as ${_back}` );
} );

// Other types: stored as an equivalent value, or refused with a TypeError before anything is written.
const EQUIVALENT = new Map( [ [ true, 1 ], [ false, 0 ], [ 10n, 10 ], [ null, null ] ] );
attacks( S, hostile( 'types' ).map( item => ( { ...item, name: `value ${item.label} is stored as its equivalent or refused cleanly` } ) ), ( { value } ) => {
	const _db = table();
	try {
		_db.run( 'INSERT INTO v ( x ) VALUES ( :x )', { x: value } );
	} catch ( error ) {
		assert.ok( error instanceof TypeError, `unexpected ${error}` );
		assert.equal( rows( _db ), 0 );
		return;
	}
	assert.ok( EQUIVALENT.has( value ), `${String( value )} was stored although it has no SQLite form` );
	assert.equal( _db.get( 'SELECT x FROM v' ).x, EQUIVALENT.get( value ) );
} );

// Hostile names inside SQL identifiers are the caller's business; as values for parameters named like prototype
// members they must bind like any other name.
attacks( S, [ 'constructor', 'toString', 'valueOf', 'hasOwnProperty' ].map( name => ( { name: `a parameter named :${name} binds its own value`, param: name } ) ),
	( { param } ) => {
		const _db = table();
		assert.equal( _db.get( `SELECT :${param} AS v`, { [ param ]: 'own' } ).v, 'own' );
		assert.equal( _db.get( `SELECT :${param} AS v`, {} ).v, null );
	} );
