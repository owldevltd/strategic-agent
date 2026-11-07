// lib/app.js under attack, part 1: the class registry (define, use, get, make), dependency order, cycles and
// names that are not class names. Every test defines classes under its own prefix (Stress.Tn...) in this
// process's app; nothing touches the classes of the engine.
import assert from 'node:assert/strict';
import { attack, attacks, hostile, within } from '../hostile.mjs';
import { agency, quiet, tempDir } from './tools.mjs';

const S = 'lib/app.js';
agency.namespace( 'Stress', `${tempDir( 'app' )}/` );
let counter = 0;
// A fresh name prefix for one test.
const prefix = () => `Stress.T${counter++}`;
// Settles or reports that it hung; a hang must fail, never pass.
const settle = ( promise, ms = 300 ) => within( promise.then( value => ( { value } ), error => ( { error } ) ), ms, 'app.use' );

attack( S, 'use() resolves a class with its dependencies passed in the order they are listed', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [], () => 'a' );
	agency.define( `${_p}.B`, [], () => 'b' );
	agency.define( `${_p}.C`, [ `${_p}.B`, `${_p}.A` ], ( b, a ) => `${a}${b}c` );
	assert.deepEqual( await agency.use( [ `${_p}.C` ] ), [ 'abc' ] );
	assert.equal( agency.get( `${_p}.C` ), 'abc' );
} );

attack( S, 'use() with a single name (no list) works as with a list of one', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [], () => 1 );
	assert.deepEqual( await agency.use( `${_p}.A` ), [ 1 ] );
} );

attack( S, 'use( [] ) resolves to an empty list', async () => {
	assert.deepEqual( await agency.use( [] ), [] );
} );

attack( S, '50 parallel use() of one class run its factory once and give the same class', async () => {
	const _p = prefix();
	let _made = 0;
	agency.define( `${_p}.A`, [], () => {
		_made += 1;
		return class A {};
	} );
	const _all = await Promise.all( Array.from( { length: 50 }, () => agency.use( [ `${_p}.A` ] ) ) );
	assert.equal( _made, 1 );
	assert.ok( _all.every( ( [ cls ] ) => cls === _all[ 0 ][ 0 ] ) );
} );

attack( S, 'a diamond (A needs B and C, both need D) builds D once and hands the same D to both', async () => {
	const _p = prefix();
	let _made = 0;
	agency.define( `${_p}.D`, [], () => ( { n: ++_made } ) );
	agency.define( `${_p}.B`, [ `${_p}.D` ], d => d );
	agency.define( `${_p}.C`, [ `${_p}.D` ], d => d );
	agency.define( `${_p}.A`, [ `${_p}.B`, `${_p}.C` ], ( b, c ) => b === c );
	assert.deepEqual( await agency.use( [ `${_p}.A` ] ), [ true ] );
	assert.equal( _made, 1 );
} );

attack( S, 'defining a name twice is refused, and the first definition stays', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [], () => 'first' );
	assert.throws( () => agency.define( `${_p}.A`, [], () => 'second' ), /Class defined twice/ );
	assert.deepEqual( await agency.use( [ `${_p}.A` ] ), [ 'first' ] );
} );

attack( S, 'a class that needs itself is refused as a cycle', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [ `${_p}.A` ], () => 1 );
	const { error } = await settle( agency.use( [ `${_p}.A` ] ) );
	assert.match( error.message, new RegExp( `Circular dependency: ${_p}.A → ${_p}.A` ) );
} );

attack( S, 'a cycle of two is refused and the message names the chain', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [ `${_p}.B` ], () => 1 );
	agency.define( `${_p}.B`, [ `${_p}.A` ], () => 2 );
	const { error } = await settle( agency.use( [ `${_p}.A` ] ) );
	assert.match( error.message, new RegExp( `${_p}.A → ${_p}.B → ${_p}.A` ) );
} );

attack( S, 'a cycle of three is refused', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [ `${_p}.B` ], () => 1 );
	agency.define( `${_p}.B`, [ `${_p}.C` ], () => 2 );
	agency.define( `${_p}.C`, [ `${_p}.A` ], () => 3 );
	const { error } = await settle( agency.use( [ `${_p}.A` ] ) );
	assert.match( error.message, /Circular dependency/ );
} );

attack( S, 'a cycle reached by two use() calls at once is refused, not left hanging', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [ `${_p}.B` ], () => 1 );
	agency.define( `${_p}.B`, [ `${_p}.A` ], () => 2 );
	const [ _a, _b ] = [ agency.use( [ `${_p}.A` ] ), agency.use( [ `${_p}.B` ] ) ];
	const [ _resultA, _resultB ] = [ await settle( _a ), await settle( _b ) ];
	assert.match( String( _resultA.error?.message ), /Circular dependency/ );
	assert.match( String( _resultB.error?.message ), /Circular dependency/ );
} );

attack( S, 'a cycle between two siblings of one class is refused, not left hanging', async () => {
	const _p = prefix();
	agency.define( `${_p}.B`, [ `${_p}.C` ], () => 1 );
	agency.define( `${_p}.C`, [ `${_p}.B` ], () => 2 );
	agency.define( `${_p}.A`, [ `${_p}.B`, `${_p}.C` ], () => 3 );
	const { error } = await settle( agency.use( [ `${_p}.A` ] ) );
	assert.match( error.message, /Circular dependency/ );
} );

attack( S, 'a dependency that fails takes its dependents down with the original error', async () => {
	const _p = prefix();
	agency.define( `${_p}.Bad`, [], () => { throw new Error( 'factory broke' ); } );
	agency.define( `${_p}.A`, [ `${_p}.Bad` ], () => 1 );
	agency.define( `${_p}.B`, [ `${_p}.Bad` ], () => 2 );
	const [ _a, _b ] = await Promise.all( [ settle( agency.use( [ `${_p}.A` ] ) ), settle( agency.use( [ `${_p}.B` ] ) ) ] );
	assert.equal( _a.error.message, 'factory broke' );
	assert.equal( _b.error.message, 'factory broke' );
	assert.throws( () => agency.get( `${_p}.A` ), /Class not loaded/ );
} );

attack( S, 'a missing dependency is reported with its name', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [ `${_p}.Missing` ], () => 1 );
	const { error } = await settle( agency.use( [ `${_p}.A` ] ) );
	assert.match( error.message, /File not found/ );
	assert.match( error.message, /missing\.js/ );
} );

attack( S, 'a dependency in an unknown namespace is refused by name', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [ 'Nowhere.Thing' ], () => 1 );
	const { error } = await settle( agency.use( [ `${_p}.A` ] ) );
	assert.match( error.message, /Unknown class name: Nowhere\.Thing/ );
} );

attack( S, 'a requires list that is not a list is refused instead of hanging', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, `${_p}.B`, () => 1 );
	agency.define( `${_p}.C`, null, () => 1 );
	assert.ok( ( await settle( agency.use( [ `${_p}.A` ] ) ) ).error instanceof Error );
	assert.ok( ( await settle( agency.use( [ `${_p}.C` ] ) ) ).error instanceof Error );
} );

attack( S, 'a requires list with a non-name in it is refused instead of hanging', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [ null ], () => 1 );
	agency.define( `${_p}.B`, [ 42 ], () => 1 );
	assert.ok( ( await settle( agency.use( [ `${_p}.A` ] ) ) ).error instanceof Error );
	assert.ok( ( await settle( agency.use( [ `${_p}.B` ] ) ) ).error instanceof Error );
} );

attack( S, 'a factory that is not a function is refused when the class is used', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [], 'not a factory' );
	const { error } = await settle( agency.use( [ `${_p}.A` ] ) );
	assert.ok( error instanceof TypeError );
} );

attack( S, 'get() before use() says the class is not loaded; make() as well', () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [], () => class A {} );
	assert.throws( () => agency.get( `${_p}.A` ), /Class not loaded: .*call app\.use\(\) first/ );
	assert.throws( () => agency.make( `${_p}.A` ), /Class not loaded/ );
} );

attack( S, 'make() passes every argument to the constructor', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [], () => class A {
		constructor( ...args ) { this.args = args; }
	} );
	await agency.use( [ `${_p}.A` ] );
	assert.deepEqual( agency.make( `${_p}.A`, 1, 'two', { three: 3 } ).args, [ 1, 'two', { three: 3 } ] );
} );

attack( S, 'use() with a callback hands the classes to it', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [], () => 'a' );
	agency.define( `${_p}.B`, [], () => 'b' );
	const _got = await within( new Promise( resolve => agency.use( [ `${_p}.A`, `${_p}.B` ], ( a, b ) => resolve( [ a, b ] ) ) ), 500 );
	assert.deepEqual( _got, [ 'a', 'b' ] );
} );

attack( S, 'use() with a callback: a load failure and a throwing callback both reach app.fail, never an unhandled rejection', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [], () => 'a' );
	const _quiet = quiet();
	try {
		agency.use( [ `${_p}.Missing` ], () => {} );
		agency.use( [ `${_p}.A` ], () => { throw new Error( 'callback broke' ); } );
		await new Promise( resolve => setTimeout( resolve, 20 ) );
	} finally {
		_quiet.restore();
	}
	assert.equal( _quiet.errors.length, 2 );
	assert.ok( _quiet.errors.some( error => /callback broke/.test( error.message ) ) );
	assert.ok( _quiet.errors.some( error => /File not found/.test( error.message ) ) );
} );

attack( S, 'a dependency chain 500 deep resolves without a stack overflow', async () => {
	const _p = prefix();
	agency.define( `${_p}.N0`, [], () => 0 );
	for ( let i = 1; i < 500; i++ ) { agency.define( `${_p}.N${i}`, [ `${_p}.N${i - 1}` ], n => n + 1 ); }
	const { value } = await settle( agency.use( [ `${_p}.N499` ] ), 3000 );
	assert.deepEqual( value, [ 499 ] );
} );

attack( S, '2000 independent classes in one use() resolve quickly and in order', async () => {
	const _p = prefix();
	const _names = Array.from( { length: 2000 }, ( _, i ) => `${_p}.C${i}` );
	_names.forEach( ( name, i ) => agency.define( name, [], () => i ) );
	const _start = performance.now();
	const _all = await agency.use( _names );
	assert.ok( performance.now() - _start < 6000 );
	assert.deepEqual( _all, _names.map( ( _, i ) => i ) );
} );

attack( S, 'a factory may return a plain object; get() hands it back unchanged', async () => {
	const _p = prefix();
	const _value = { helper: true };
	agency.define( `${_p}.A`, [], () => _value );
	await agency.use( [ `${_p}.A` ] );
	assert.equal( agency.get( `${_p}.A` ), _value );
} );

attack( S, 'path(): dotted names become lower-case folders below the namespace root', () => {
	assert.equal( agency.path( 'Core.Strategy.TargetCurve' ), `${agency.config.root}core/strategy/targetcurve.js` );
	assert.equal( agency.path( 'Lib.Db' ), `${agency.config.root}lib/db.js` );
} );

attack( S, 'path(): a name without a dot or with an unknown namespace is refused', () => {
	for ( const name of [ 'Lib', 'Nowhere.X', '', '.Db', 'lib.Db' ] ) {
		assert.throws( () => agency.path( name ), /Unknown class name/, name );
	}
} );

attack( S, 'path(): no class name can climb out of its namespace folder', async () => {
	const { default: path } = await import( 'node:path' );
	const _root = path.resolve( agency.root, 'lib' );
	for ( const { value } of hostile( 'strings' ) ) {
		const _file = path.resolve( agency.root, agency.path( `Lib.${value}` ) );
		assert.ok( _file.startsWith( `${_root}${path.sep}` ), `Lib.${value.slice( 0, 30 )} → ${_file}` );
	}
} );

attack( S, 'an override points one name at another file; other names are untouched', () => {
	const _p = prefix();
	agency.override( `${_p}.A`, '/somewhere/else.js' );
	assert.equal( agency.path( `${_p}.A` ), '/somewhere/else.js' );
	assert.equal( agency.path( `${_p}.B` ), `${agency.namespaces.Stress}${_p.split( '.' )[ 1 ].toLowerCase()}/b.js` );
} );

attack( S, 'an override of a class already loaded changes nothing for its users', async () => {
	const _p = prefix();
	agency.define( `${_p}.A`, [], () => 'original' );
	await agency.use( [ `${_p}.A` ] );
	agency.override( `${_p}.A`, '/does/not/exist.js' );
	assert.deepEqual( await agency.use( [ `${_p}.A` ] ), [ 'original' ] );
} );

attack( S, 'app.fail reports to console.error and, when present, to app.event', () => {
	const _events = [];
	const _original = console.error;
	const _logged = [];
	console.error = ( ...args ) => _logged.push( args );
	agency.event = { emit: ( name, error ) => _events.push( [ name, error.message ] ) };
	try {
		agency.fail( new Error( 'reported' ) );
	} finally {
		console.error = _original;
		delete agency.event;
	}
	assert.equal( _logged.length, 1 );
	assert.deepEqual( _events, [ [ 'app:error', 'reported' ] ] );
} );

// Names that are not class names at all: use() must reject (never resolve, never hang, never throw at once) and
// get() must refuse.
attacks( S, hostile( 'keys', 'types' ).filter( item => !( Array.isArray( item.value ) && item.value.length === 0 ) ).map( item => ( {
	...item, name: `name ${item.label} is refused by use() and get()`,
} ) ), async ( { value } ) => {
	let _promise;
	assert.doesNotThrow( () => { _promise = agency.use( value ); }, 'use() must not throw synchronously' );
	const _result = await settle( _promise );
	assert.ok( _result.error instanceof Error, `resolved to ${String( _result.value )}` );
	assert.throws( () => agency.get( value ) );
} );

attacks( S, [ 'toString', 'hasOwnProperty' ].map( name => ( {
	name: `name ${name} (an Object.prototype member) is refused by use() and get()`, value: name,
} ) ), async ( { value } ) => {
	const _result = await settle( agency.use( value ) );
	assert.ok( _result.error instanceof Error, `resolved to ${String( _result.value )}` );
	assert.throws( () => agency.get( value ), /Class not loaded/ );
} );

attack( S, 'define() of a name that is an Object.prototype member is accepted like any other name', async () => {
	assert.doesNotThrow( () => agency.define( 'propertyIsEnumerable', [], () => 'mine' ) );
	assert.deepEqual( await settle( agency.use( 'propertyIsEnumerable' ) ), { value: [ 'mine' ] } );
} );
