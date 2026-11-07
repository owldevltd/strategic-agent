// lib/app.js under attack, part 2: class files (loading, broken files, files that define the wrong thing) and
// overrides, both app.override() and the AGENCY_OVERRIDES folder read by lib/node.mjs at boot. Boots with overrides
// run in a child process, because a process boots its app once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attack, within } from '../hostile.mjs';
import { agency, tempDir, child, lastJson } from './tools.mjs';

const S = 'lib/app.js';
const ROOT_DIR = tempDir( 'appfiles' );
agency.namespace( 'Files', `${ROOT_DIR}/` );
let counter = 0;

// Writes a class file for Files.Tn.<Name> and returns the class name.
const file = ( name, source ) => {
	const _dir = `t${counter++}`;
	fs.mkdirSync( path.join( ROOT_DIR, _dir ), { recursive: true } );
	fs.writeFileSync( path.join( ROOT_DIR, _dir, `${name.toLowerCase()}.js` ), source );
	return `Files.T${_dir.slice( 1 )}.${name}`;
};
const settle = ( promise, ms = 1000 ) => within( promise.then( value => ( { value } ), error => ( { error } ) ), ms, 'app.use' );

attack( S, 'a class file is found by its lower-case path and loaded with its dependencies', async () => {
	const _n = counter;
	const _name = file( 'Widget', `app.define( 'Files.T${_n}.Widget', [ 'Lib.Hash' ], Hash => class Widget {
		static id() { return Hash.sha256( 'w' ).length; }
	} );` );
	const [ _Widget ] = await agency.use( [ _name ] );
	assert.equal( _Widget.id(), 64 );
} );

attack( S, 'a file that defines another name than the one asked for is refused', async () => {
	const _name = file( 'Wrong', 'app.define( \'Files.Elsewhere.Other\', [], () => 1 );' );
	const { error } = await settle( agency.use( [ _name ] ) );
	assert.match( error.message, new RegExp( `does not define ${_name.replace( /\./g, '\\.' )}` ) );
} );

attack( S, 'an empty file is refused (it defines nothing)', async () => {
	const { error } = await settle( agency.use( [ file( 'Empty', '' ) ] ) );
	assert.match( error.message, /does not define/ );
} );

attack( S, 'a file that throws while loading passes that error on', async () => {
	const { error } = await settle( agency.use( [ file( 'Throws', 'throw new RangeError( "broken at load" );' ) ] ) );
	assert.ok( error instanceof Error );
	assert.match( error.message, /broken at load/ );
} );

attack( S, 'a file that throws a non-error at load is still a rejection', async () => {
	const _result = await settle( agency.use( [ file( 'ThrowsText', 'throw "just text";' ) ] ) );
	assert.ok( 'error' in _result );
	assert.equal( _result.error, 'just text' );
} );

attack( S, 'a file with a syntax error is refused with a SyntaxError', async () => {
	const { error } = await settle( agency.use( [ file( 'Syntax', 'app.define( "x", [], () => { ' ) ] ) );
	assert.equal( error.name, 'SyntaxError' );
} );

attack( S, 'a missing file is refused with its path', async () => {
	const { error } = await settle( agency.use( [ 'Files.Nothing.Here' ] ) );
	assert.match( error.message, /File not found: .*nothing\/here\.js/ );
} );

attack( S, 'a class file that is a folder is refused with an error', async () => {
	fs.mkdirSync( path.join( ROOT_DIR, 'folder', 'isdir.js' ), { recursive: true } );
	const { error } = await settle( agency.use( [ 'Files.Folder.IsDir' ] ) );
	assert.ok( error instanceof Error );
} );

attack( S, 'a file that defines a class already defined is refused', async () => {
	agency.define( 'Files.Taken.Name', [], () => 'first' );
	const _name = file( 'Again', 'app.define( "Files.Taken.Name", [], () => "second" );' );
	const { error } = await settle( agency.use( [ _name ] ) );
	assert.match( error.message, /Class defined twice: Files\.Taken\.Name/ );
	assert.deepEqual( await agency.use( [ 'Files.Taken.Name' ] ), [ 'first' ] );
} );

attack( S, 'a file that defines two classes: the second is used without reading any file again', async () => {
	const _n = counter;
	const _name = file( 'Pair', `app.define( 'Files.T${_n}.Pair', [], () => 'pair' ); app.define( 'Files.T${_n}.Extra', [], () => 'extra' );` );
	await agency.use( [ _name ] );
	assert.deepEqual( await agency.use( [ `Files.T${_n}.Extra` ] ), [ 'extra' ] );
	assert.ok( !fs.existsSync( path.join( ROOT_DIR, `t${_n}`, 'extra.js' ) ) );
} );

attack( S, '20 parallel use() of a class file run the file once', async () => {
	const _n = counter;
	const _name = file( 'Once', `globalThis.stressOnce = ( globalThis.stressOnce || 0 ) + 1; app.define( 'Files.T${_n}.Once', [], () => 'once' );` );
	const _all = await Promise.all( Array.from( { length: 20 }, () => settle( agency.use( [ _name ] ) ) ) );
	assert.ok( _all.every( result => result.value?.[ 0 ] === 'once' ) );
	assert.equal( globalThis.stressOnce, 1 );
} );

attack( S, 'a class file starting with a byte order mark loads', async () => {
	const _n = counter;
	const _name = file( 'Bom', `\uFEFFapp.define( 'Files.T${_n}.Bom', [], () => 'bom' );` );
	assert.deepEqual( await agency.use( [ _name ] ), [ 'bom' ] );
} );

attack( S, 'app.override(): a name pointed at an absolute file loads from there', async () => {
	const _file = path.join( tempDir( 'override' ), 'replacement.js' );
	fs.writeFileSync( _file, 'app.define( "Files.Over.Abs", [], () => "replaced" );' );
	agency.override( 'Files.Over.Abs', _file );
	assert.deepEqual( await agency.use( [ 'Files.Over.Abs' ] ), [ 'replaced' ] );
} );

attack( S, 'app.override(): a missing override file is refused, the original is not used instead', async () => {
	fs.mkdirSync( path.join( ROOT_DIR, 'over' ), { recursive: true } );
	fs.writeFileSync( path.join( ROOT_DIR, 'over', 'gone.js' ), 'app.define( "Files.Over.Gone", [], () => "original" );' );
	agency.override( 'Files.Over.Gone', path.join( ROOT_DIR, 'nowhere.js' ) );
	const { error } = await settle( agency.use( [ 'Files.Over.Gone' ] ) );
	assert.match( error.message, /File not found/ );
} );

attack( S, 'app.override(): an override file that defines another name is refused', async () => {
	const _file = path.join( tempDir( 'override' ), 'other.js' );
	fs.writeFileSync( _file, 'app.define( "Files.Over.Unrelated", [], () => 1 );' );
	agency.override( 'Files.Over.Wanted', _file );
	const { error } = await settle( agency.use( [ 'Files.Over.Wanted' ] ) );
	assert.match( error.message, /does not define Files\.Over\.Wanted/ );
} );

attack( S, 'app.override(): a name in a namespace nobody registered can be provided by an override', async () => {
	const _file = path.join( tempDir( 'override' ), 'plugin.js' );
	fs.writeFileSync( _file, 'app.define( "Plugin.Thing", [], () => "plugged" );' );
	agency.override( 'Plugin.Thing', _file );
	assert.deepEqual( await agency.use( [ 'Plugin.Thing' ] ), [ 'plugged' ] );
} );

attack( S, 'app.override(): a relative override path is read below the project root, not the working folder', async () => {
	agency.override( 'Files.Over.Relative', 'lib/hash.js' );
	const { error } = await settle( agency.use( [ 'Files.Over.Relative' ] ) );
	assert.match( error.message, /does not define Files\.Over\.Relative|Class defined twice: Lib\.Hash/ );
} );

// AGENCY_OVERRIDES: a fresh process boots with the folder and prints what it got.
const overrides = ( map, files = {} ) => {
	const _dir = tempDir( 'overrides' );
	if ( map !== null ) { fs.writeFileSync( path.join( _dir, 'overrides.json' ), typeof map === 'string' ? map : JSON.stringify( map ) ); }
	for ( const [ name, source ] of Object.entries( files ) ) { fs.writeFileSync( path.join( _dir, name ), source ); }
	return _dir;
};
const BUS = 'app.define( "Lib.Bus", [], () => class Bus { constructor() { this.replaced = true; } on() { return () => {}; } emit() {} } );';
const bootWith = ( dir, code, options = {} ) => child( `
	import { boot } from ${JSON.stringify( path.join( agency.root, 'lib/node.mjs' ) )};
	let app;
	try {
		app = boot();
	} catch ( error ) {
		console.log( JSON.stringify( { bootError: error.name, message: error.message, code: error.code } ) );
		process.exit( 0 );
	}
	${code}
`, { env: { AGENCY_OVERRIDES: dir }, ...options } );

attack( S, 'AGENCY_OVERRIDES: a mapped class is replaced, also inside the classes that depend on it', () => {
	const _dir = overrides( { 'Lib.Bus': 'bus.js' }, { 'bus.js': BUS } );
	const _out = lastJson( bootWith( _dir, `
		const [ Bus, Db, EventLog, Hash ] = await app.use( [ 'Lib.Bus', 'Lib.Db', 'Lib.EventLog', 'Lib.Hash' ] );
		const log = new EventLog( new Db( ':memory:' ), 'x' );
		console.log( JSON.stringify( { bus: new Bus().replaced, inLog: log._bus.replaced, hash: Hash.sha256( 'abc' ).slice( 0, 6 ) } ) );
	` ).stdout );
	assert.deepEqual( _out, { bus: true, inLog: true, hash: 'ba7816' } );
} );

attack( S, 'AGENCY_OVERRIDES: file names resolve against the overrides folder, whatever the working folder', () => {
	const _dir = overrides( { 'Lib.Bus': 'bus.js' }, { 'bus.js': BUS } );
	const _out = lastJson( bootWith( _dir, `
		const [ Bus ] = await app.use( [ 'Lib.Bus' ] );
		console.log( JSON.stringify( { replaced: new Bus().replaced === true } ) );
	`, { cwd: tempDir( 'elsewhere' ) } ).stdout );
	assert.deepEqual( _out, { replaced: true } );
} );

attack( S, 'AGENCY_OVERRIDES: a folder without overrides.json stops the boot with a clear error', () => {
	const _out = lastJson( bootWith( overrides( null ), '' ).stdout );
	assert.equal( _out.code, 'ENOENT' );
	assert.match( _out.message, /overrides\.json/ );
} );

attack( S, 'AGENCY_OVERRIDES: an overrides.json that is not JSON stops the boot with a SyntaxError', () => {
	const _out = lastJson( bootWith( overrides( '{ "Lib.Bus": ' ), '' ).stdout );
	assert.equal( _out.bootError, 'SyntaxError' );
} );

attack( S, 'AGENCY_OVERRIDES: a file name that is not a string stops the boot instead of being guessed', () => {
	const _out = lastJson( bootWith( overrides( { 'Lib.Bus': 42 } ), '' ).stdout );
	assert.equal( _out.bootError, 'TypeError' );
} );

attack( S, 'AGENCY_OVERRIDES: a "__proto__" entry pollutes nothing and the other entries still apply', () => {
	const _dir = overrides( '{ "__proto__": "evil.js", "constructor": "evil.js", "Lib.Bus": "bus.js" }', { 'bus.js': BUS, 'evil.js': 'globalThis.evil = 1;' } );
	const _out = lastJson( bootWith( _dir, `
		const [ Bus ] = await app.use( [ 'Lib.Bus' ] );
		console.log( JSON.stringify( { replaced: new Bus().replaced === true, polluted: typeof {}.evil, proto: Object.getPrototypeOf( app._overrides ) === Object.prototype, evil: globalThis.evil ?? null } ) );
	` ).stdout );
	assert.deepEqual( _out, { replaced: true, polluted: 'undefined', proto: true, evil: null } );
} );

attack( S, 'AGENCY_OVERRIDES: an entry that points outside its folder stops the boot', () => {
	for ( const target of [ '../escape.js', '/etc/hostname', 'sub/../../escape.js' ] ) {
		const _out = lastJson( bootWith( overrides( { 'Lib.Bus': target } ), '' ).stdout );
		assert.match( String( _out.message ), /outside/, target );
	}
} );

attack( S, 'AGENCY_OVERRIDES: a path that is a file, not a folder, stops the boot', () => {
	const _file = path.join( tempDir( 'overrides' ), 'plain.txt' );
	fs.writeFileSync( _file, 'x' );
	const _out = lastJson( bootWith( _file, '' ).stdout );
	assert.match( String( _out.code ), /ENOTDIR|ENOENT/ );
} );

attack( S, 'AGENCY_OVERRIDES empty means no overrides', () => {
	const _out = lastJson( bootWith( '', `
		const [ Bus ] = await app.use( [ 'Lib.Bus' ] );
		console.log( JSON.stringify( { replaced: Boolean( new Bus().replaced ), overrides: Object.keys( app._overrides ).length } ) );
	` ).stdout );
	assert.deepEqual( _out, { replaced: false, overrides: 0 } );
} );

attack( S, 'AGENCY_OVERRIDES: an override file that is broken fails the use of that class only', () => {
	const _dir = overrides( { 'Lib.Bus': 'bus.js' }, { 'bus.js': 'this is not javascript (' } );
	const _out = lastJson( bootWith( _dir, `
		const bus = await app.use( [ 'Lib.Bus' ] ).then( () => 'ok', error => error.name );
		const [ Hash ] = await app.use( [ 'Lib.Hash' ] );
		console.log( JSON.stringify( { bus, hash: typeof Hash.sha256 } ) );
	` ).stdout );
	assert.deepEqual( _out, { bus: 'SyntaxError', hash: 'function' } );
} );
