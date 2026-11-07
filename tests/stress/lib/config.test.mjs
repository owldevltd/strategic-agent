// lib/config.js under attack: the .env reader and Config.load. Every test works on its own temporary folder and
// its own variable names (STRESS_CFG_*), and restores the environment; the project's own .env is never read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attack, attacks, hostile } from '../hostile.mjs';
import { agency, tempDir, withEnv } from './tools.mjs';

const [ Config ] = await agency.use( [ 'Lib.Config' ] );
const S = 'lib/config.js';

const KEYS = [ 'STORAGE_DIR', 'GATE_PORT', 'CORE_HOST', 'CORE_PORT', 'GATE_HOST', 'GATE_URL', 'BUFFER_MINUTES', 'LLM_BASE_URL', 'LLM_API_KEY',
	'LLM_MODEL', 'LLM_TIMEOUT', 'SANDBOX_RUNTIME', 'SANDBOX_IMAGE', 'SANDBOX_TIMEOUT', 'MAX_DEPTH', 'WORLD_SPEED', 'LEASE_BEAT_MS', 'GATE_UI_ORIGIN',
	'AGENCY_DEMO', 'VAULT_RETENTION_DAYS', 'GATE_LEDGER_SCOPE', 'LLM_MODELS', 'LLM_EFFORT' ];
let counter = 0;

// A .env with these lines in a fresh folder; the variables it names are removed before and after fn( file, root ).
async function envFile( lines, fn, names = [] ) {
	const _root = tempDir( 'config' );
	const _file = path.join( _root, '.env' );
	fs.writeFileSync( _file, Array.isArray( lines ) ? lines.join( '\n' ) : lines );
	const _clean = Object.fromEntries( names.map( name => [ name, undefined ] ) );
	return withEnv( _clean, () => fn( _file, _root ) );
}
const fresh = () => `STRESS_CFG_${process.pid}_${counter++}`;
// Config.load on a root with this .env text, with every variable Config reads cleared first (and env set on top).
const load = ( text, env = {} ) => {
	const _root = tempDir( 'config' );
	if ( text !== null ) { fs.writeFileSync( path.join( _root, '.env' ), text ); }
	const _clean = Object.fromEntries( KEYS.map( key => [ key, undefined ] ) );
	return withEnv( { ..._clean, ...env }, () => ( { config: Config.load( _root ), root: _root } ) );
};

attack( S, 'readEnv: a plain KEY=value line sets the variable', async () => {
	const _key = fresh();
	await envFile( [ `${_key}=value` ], ( file ) => {
		Config.readEnv( file );
		assert.equal( process.env[ _key ], 'value' );
	}, [ _key ] );
} );

attack( S, 'readEnv: blanks around key, equals sign and value are dropped', async () => {
	const _key = fresh();
	await envFile( [ `   ${_key}   =   spaced value   ` ], ( file ) => {
		Config.readEnv( file );
		assert.equal( process.env[ _key ], 'spaced value' );
	}, [ _key ] );
} );

attack( S, 'readEnv: one pair of double or single quotes is removed, blanks inside them stay', async () => {
	const [ _a, _b, _c ] = [ fresh(), fresh(), fresh() ];
	await envFile( [ `${_a}="double"`, `${_b}='single'`, `${_c}="  inside  "` ], ( file ) => {
		Config.readEnv( file );
		assert.deepEqual( [ process.env[ _a ], process.env[ _b ], process.env[ _c ] ], [ 'double', 'single', '  inside  ' ] );
	}, [ _a, _b, _c ] );
} );

attack( S, 'readEnv: quotes that do not match are kept as written', async () => {
	const [ _a, _b ] = [ fresh(), fresh() ];
	await envFile( [ `${_a}="open'`, `${_b}="only-left` ], ( file ) => {
		Config.readEnv( file );
		assert.deepEqual( [ process.env[ _a ], process.env[ _b ] ], [ '"open\'', '"only-left' ] );
	}, [ _a, _b ] );
} );

attack( S, 'readEnv: quotes inside a quoted value stay', async () => {
	const _key = fresh();
	await envFile( [ `${_key}="say "hi" now"` ], ( file ) => {
		Config.readEnv( file );
		assert.equal( process.env[ _key ], 'say "hi" now' );
	}, [ _key ] );
} );

attack( S, 'readEnv: an empty value and an empty quoted value both set an empty string', async () => {
	const [ _a, _b ] = [ fresh(), fresh() ];
	await envFile( [ `${_a}=`, `${_b}=""` ], ( file ) => {
		Config.readEnv( file );
		assert.deepEqual( [ process.env[ _a ], process.env[ _b ] ], [ '', '' ] );
	}, [ _a, _b ] );
} );

attack( S, 'readEnv: everything after the first equals sign is the value', async () => {
	const _key = fresh();
	await envFile( [ `${_key}=a=b==c` ], ( file ) => {
		Config.readEnv( file );
		assert.equal( process.env[ _key ], 'a=b==c' );
	}, [ _key ] );
} );

attack( S, 'readEnv: comment lines and blank lines set nothing', async () => {
	const _key = fresh();
	await envFile( [ `# ${_key}=commented`, '', '   ', `#${_key}=also` ], ( file ) => {
		Config.readEnv( file );
		assert.equal( process.env[ _key ], undefined );
	}, [ _key ] );
} );

attack( S, 'readEnv: lower-case names, names starting with a digit and lines without = are ignored', async () => {
	const _key = fresh();
	await envFile( [ `${_key.toLowerCase()}=x`, `1${_key}=x`, _key, `${_key}-X=x`, `${_key}.X=x` ], ( file ) => {
		Config.readEnv( file );
		assert.equal( process.env[ _key ], undefined );
		assert.equal( process.env[ _key.toLowerCase() ], undefined );
		assert.equal( process.env[ `1${_key}` ], undefined );
	}, [ _key, _key.toLowerCase(), `1${_key}` ] );
} );

attack( S, 'readEnv: "export NAME=value" sets NAME and creates no variable with a blank in its name', async () => {
	const _key = fresh();
	await envFile( [ `export ${_key}=x` ], ( file ) => {
		const _before = new Set( Object.keys( process.env ) );
		Config.readEnv( file );
		assert.deepEqual( Object.keys( process.env ).filter( key => !_before.has( key ) ), [ _key ] );
		assert.equal( process.env[ _key ], 'x' );
	}, [ _key ] );
} );

attack( S, 'readEnv: a comment after a blank ends an unquoted value; a # without a blank or inside quotes is part of it', async () => {
	const [ _a, _b, _c, _d ] = [ fresh(), fresh(), fresh(), fresh() ];
	await envFile( [ `${_a}=value # comment`, `${_b}=pass#word`, `${_c}="a # b" # comment`, `${_d}= # only a comment` ], ( file ) => {
		Config.readEnv( file );
		assert.deepEqual( [ process.env[ _a ], process.env[ _b ], process.env[ _c ], process.env[ _d ] ], [ 'value', 'pass#word', 'a # b', '' ] );
	}, [ _a, _b, _c, _d ] );
} );

attack( S, 'readEnv: a variable already in the environment wins over the file', async () => {
	const _key = fresh();
	await envFile( [ `${_key}=from-file` ], file => withEnv( { [ _key ]: 'from-env' }, () => {
		Config.readEnv( file );
		assert.equal( process.env[ _key ], 'from-env' );
	} ), [ _key ] );
} );

attack( S, 'readEnv: a variable set to an empty string in the environment still wins', async () => {
	const _key = fresh();
	await envFile( [ `${_key}=from-file` ], file => withEnv( { [ _key ]: '' }, () => {
		Config.readEnv( file );
		assert.equal( process.env[ _key ], '' );
	} ), [ _key ] );
} );

attack( S, 'readEnv: of two lines for the same name the first one counts', async () => {
	const _key = fresh();
	await envFile( [ `${_key}=first`, `${_key}=second` ], ( file ) => {
		Config.readEnv( file );
		assert.equal( process.env[ _key ], 'first' );
	}, [ _key ] );
} );

attack( S, 'readEnv: Windows line ends (CRLF) leave no carriage return in values', async () => {
	const [ _a, _b ] = [ fresh(), fresh() ];
	await envFile( `${_a}=one\r\n${_b}="two"\r\n`, ( file ) => {
		Config.readEnv( file );
		assert.deepEqual( [ process.env[ _a ], process.env[ _b ] ], [ 'one', 'two' ] );
	}, [ _a, _b ] );
} );

attack( S, 'readEnv: a byte order mark before the first line does not hide the first variable', async () => {
	const _key = fresh();
	await envFile( `\uFEFF${_key}=bom`, ( file ) => {
		Config.readEnv( file );
		assert.equal( process.env[ _key ], 'bom' );
	}, [ _key ] );
} );

attack( S, 'readEnv: no shell, no expansion: $(...), ${...}, backticks and \\n stay literal', async () => {
	const [ _a, _b, _c, _d ] = [ fresh(), fresh(), fresh(), fresh() ];
	await envFile( [ `${_a}=$(touch /tmp/pwned)`, `${_b}=\${HOME}`, `${_c}=\`id\``, `${_d}="a\\nb"` ], ( file ) => {
		Config.readEnv( file );
		assert.deepEqual( [ process.env[ _a ], process.env[ _b ], process.env[ _c ], process.env[ _d ] ],
			[ '$(touch /tmp/pwned)', '${HOME}', '`id`', 'a\\nb' ] );
	}, [ _a, _b, _c, _d ] );
} );

attack( S, 'readEnv: a missing file is no error and sets nothing', () => {
	const _before = JSON.stringify( process.env );
	assert.doesNotThrow( () => Config.readEnv( path.join( tempDir( 'config' ), 'nothing', '.env' ) ) );
	assert.equal( JSON.stringify( process.env ), _before );
} );

attack( S, 'readEnv: a .env that is a folder is refused with an error, not read', () => {
	const _root = tempDir( 'config' );
	fs.mkdirSync( path.join( _root, '.env' ) );
	assert.throws( () => Config.readEnv( path.join( _root, '.env' ) ), /EISDIR|directory/ );
} );

attack( S, 'readEnv: binary garbage sets no variable with an invalid name and does not throw', async () => {
	const _bytes = Buffer.from( Array.from( { length: 4096 }, ( _, i ) => ( i * 131 ) % 256 ) );
	await envFile( _bytes.toString( 'latin1' ), ( file ) => {
		fs.writeFileSync( file, _bytes );
		const _before = new Set( Object.keys( process.env ) );
		assert.doesNotThrow( () => Config.readEnv( file ) );
		const _added = Object.keys( process.env ).filter( key => !_before.has( key ) );
		_added.forEach( key => delete process.env[ key ] );
		assert.ok( _added.every( key => /^[A-Z_][A-Z0-9_]*$/.test( key ) ), _added.join() );
	} );
} );

attack( S, 'readEnv: 5000 lines are read quickly and completely', async () => {
	const _prefix = fresh();
	const _names = Array.from( { length: 5000 }, ( _, i ) => `${_prefix}_${i}` );
	await envFile( _names.map( ( name, i ) => `${name}=v${i}` ), ( file ) => {
		const _start = performance.now();
		Config.readEnv( file );
		assert.ok( performance.now() - _start < 6000 );
		assert.equal( process.env[ _names[ 4999 ] ], 'v4999' );
		assert.equal( _names.filter( ( name, i ) => process.env[ name ] === `v${i}` ).length, 5000 );
	}, _names );
} );

attack( S, 'readEnv: a 1 MB value is kept whole', async () => {
	const _key = fresh();
	const _value = 'v'.repeat( 1024 * 1024 );
	await envFile( [ `${_key}=${_value}` ], ( file ) => {
		Config.readEnv( file );
		assert.equal( process.env[ _key ].length, _value.length );
	}, [ _key ] );
} );

attack( S, 'readEnv: names that are Object.prototype members in upper case are plain variables; nothing is polluted', async () => {
	const _names = [ '__PROTO__', 'CONSTRUCTOR', 'TOSTRING', 'HASOWNPROPERTY' ];
	await envFile( [ ..._names.map( name => `${name}=x` ), '__proto__=polluted' ], ( file ) => {
		Config.readEnv( file );
		_names.forEach( name => assert.equal( process.env[ name ], 'x' ) );
		assert.equal( {}.polluted, undefined );
		assert.equal( typeof process.env.hasOwnProperty, 'function' );
	}, _names );
} );

attack( S, 'readEnv: unicode values survive', async () => {
	const _key = fresh();
	await envFile( [ `${_key}=Ünïcödé ß 😀👨‍👩‍👧 €` ], ( file ) => {
		Config.readEnv( file );
		assert.equal( process.env[ _key ], 'Ünïcödé ß 😀👨‍👩‍👧 €' );
	}, [ _key ] );
} );

attack( S, 'readEnv: a # inside quotes is part of the value', async () => {
	const _key = fresh();
	await envFile( [ `${_key}="pass#word"` ], ( file ) => {
		Config.readEnv( file );
		assert.equal( process.env[ _key ], 'pass#word' );
	}, [ _key ] );
} );

attack( S, 'readEnv: only the names in the file change; the rest of the environment stays as it was', async () => {
	const _key = fresh();
	await envFile( [ `${_key}=x` ], ( file ) => {
		const _before = { ...process.env };
		Config.readEnv( file );
		const _after = { ...process.env };
		delete _after[ _key ];
		assert.deepEqual( _after, _before );
	}, [ _key ] );
} );

attack( S, 'load: an empty root gives the documented defaults', async () => {
	const { config, root } = await load( null );
	assert.equal( config.root, root );
	assert.equal( config.storageDir, path.join( root, 'storage' ) );
	assert.deepEqual( config.core, { host: '127.0.0.1', port: 8090 } );
	assert.deepEqual( config.gate, {
		host: '127.0.0.1', port: 8091, url: 'http://127.0.0.1:8091', bufferMinutes: 5, ledger: 'gate',
		origins: [ 'http://127.0.0.1:8090', 'http://localhost:8090' ],
	} );
	assert.equal( config.llm.apiKey, '' );
	assert.deepEqual( [ config.sandbox.runtime, config.sandbox.image, config.maxDepth, config.worldSpeed, config.beatMs ],
		[ 'process', 'python:3.12-slim', 5, 1, 15000 ] );
	assert.deepEqual( [ config.demo, config.vaultRetentionDays ], [ false, 30 ] );
} );

attack( S, 'load: values from the .env of that root reach every section', async () => {
	const { config } = await load( [ 'CORE_PORT=9100', 'GATE_PORT=9101', 'CORE_HOST=0.0.0.0', 'LLM_MODEL=m-1', 'SANDBOX_RUNTIME=docker',
		'MAX_DEPTH=3', 'BUFFER_MINUTES=2.5', 'LEASE_BEAT_MS=50', 'WORLD_SPEED=100', 'STORAGE_DIR=/var/tmp/x' ].join( '\n' ) );
	assert.deepEqual( config.core, { host: '0.0.0.0', port: 9100 } );
	assert.equal( config.gate.port, 9101 );
	assert.equal( config.gate.url, 'http://127.0.0.1:9101' );
	assert.deepEqual( [ config.llm.model, config.sandbox.runtime, config.maxDepth, config.gate.bufferMinutes ], [ 'm-1', 'docker', 3, 2.5 ] );
	assert.deepEqual( [ config.beatMs, config.worldSpeed, config.storageDir ], [ 50, 100, '/var/tmp/x' ] );
} );

attack( S, 'load: the environment wins over the .env of the root', async () => {
	const { config } = await load( 'CORE_PORT=9100\nLLM_MODEL=from-file', { CORE_PORT: '9200', LLM_MODEL: 'from-env' } );
	assert.equal( config.core.port, 9200 );
	assert.equal( config.llm.model, 'from-env' );
} );

attack( S, 'load: GATE_URL wins over the URL made from GATE_PORT', async () => {
	const { config } = await load( 'GATE_PORT=9101\nGATE_URL=http://gate.internal:1' );
	assert.equal( config.gate.url, 'http://gate.internal:1' );
	assert.equal( config.gate.port, 9101 );
} );

attack( S, 'load: an empty value falls back to the default', async () => {
	const { config } = await load( 'LLM_TIMEOUT=\nCORE_PORT=\nSANDBOX_RUNTIME=' );
	assert.equal( config.llm.timeoutSeconds, 150 );
	assert.equal( config.core.port, 8090 );
	assert.equal( config.sandbox.runtime, 'process' );
} );

attack( S, 'load: numbers are numbers, hosts and keys are strings', async () => {
	const { config } = await load( 'CORE_PORT= 9100 \nLLM_API_KEY=12345' );
	assert.equal( config.core.port, 9100 );
	assert.equal( typeof config.llm.apiKey, 'string' );
	const _numbers = [ config.core.port, config.gate.port, config.gate.bufferMinutes, config.llm.timeoutSeconds,
		config.sandbox.timeoutSeconds, config.maxDepth, config.worldSpeed, config.beatMs ];
	for ( const value of _numbers ) {
		assert.equal( typeof value, 'number' );
	}
} );

attack( S, 'load: A2, the default model timeout (150 s) is shorter than the lease of a model move (3 minutes)', async () => {
	const { config } = await load( null );
	assert.ok( config.llm.timeoutSeconds * 1000 < 3 * 60000 );
	assert.ok( config.sandbox.timeoutSeconds * 1000 < 2 * 60000 );
} );

attack( S, 'load: A2, a model timeout longer than the model lease is refused', async () => {
	await assert.rejects( load( 'LLM_TIMEOUT=600' ), /LLM_TIMEOUT|timeout|A2/ );
} );

attack( S, 'load: a relative STORAGE_DIR lies below the root, not below the working folder', async () => {
	const { config, root } = await load( 'STORAGE_DIR=data/store' );
	assert.equal( config.storageDir, path.join( root, 'data', 'store' ) );
} );

attacks( S, [
	{ name: 'load: A2, LLM_TIMEOUT=0 is refused (a timeout must be above 0)', text: 'LLM_TIMEOUT=0', key: 'LLM_TIMEOUT' },
	{ name: 'load: A2, LLM_TIMEOUT=180 is refused (not below the 3-minute model lease)', text: 'LLM_TIMEOUT=180', key: 'LLM_TIMEOUT' },
	{ name: 'load: A2, SANDBOX_TIMEOUT=120 is refused (not below the 2-minute code lease)', text: 'SANDBOX_TIMEOUT=120', key: 'SANDBOX_TIMEOUT' },
	{ name: 'load: SANDBOX_TIMEOUT=-5 is refused', text: 'SANDBOX_TIMEOUT=-5', key: 'SANDBOX_TIMEOUT' },
	{ name: 'load: CORE_PORT=70000 is refused', text: 'CORE_PORT=70000', key: 'CORE_PORT' },
	{ name: 'load: MAX_DEPTH=2.5 is refused', text: 'MAX_DEPTH=2.5', key: 'MAX_DEPTH' },
	{ name: 'load: LEASE_BEAT_MS=0x10 is refused (decimal numbers only)', text: 'LEASE_BEAT_MS=0x10', key: 'LEASE_BEAT_MS' },
], async ( { text, key } ) => {
	await assert.rejects( load( text ), new RegExp( key ) );
} );

attack( S, 'load: an error about a setting never quotes its value', async () => {
	await assert.rejects( load( 'CORE_PORT=sk-secret-port' ), ( error ) => {
		assert.ok( !error.message.includes( 'sk-secret' ) );
		return true;
	} );
} );

attack( S, 'load: a root with blanks and unicode in its path works', async () => {
	const _root = path.join( tempDir( 'config' ), 'with spa ces ü' );
	fs.mkdirSync( _root );
	fs.writeFileSync( path.join( _root, '.env' ), 'LLM_MODEL=unicode-root' );
	const _clean = Object.fromEntries( KEYS.map( key => [ key, undefined ] ) );
	await withEnv( _clean, () => {
		const _config = Config.load( _root );
		assert.equal( _config.llm.model, 'unicode-root' );
		assert.equal( _config.storageDir, path.join( _root, 'storage' ) );
	} );
} );

attack( S, 'load: a .env that is a folder makes load fail loudly', async () => {
	const _root = tempDir( 'config' );
	fs.mkdirSync( path.join( _root, '.env' ) );
	assert.throws( () => Config.load( _root ), /EISDIR|directory/ );
} );

attack( S, 'load: a failing .env leaks none of its values in the error', async () => {
	const _root = tempDir( 'config' );
	fs.writeFileSync( path.join( _root, '.env' ), 'LLM_API_KEY=sk-very-secret\n' );
	fs.chmodSync( path.join( _root, '.env' ), 0 );
	const _clean = Object.fromEntries( KEYS.map( key => [ key, undefined ] ) );
	try {
		await withEnv( _clean, () => assert.throws( () => Config.load( _root ), ( error ) => {
			assert.ok( !String( error.message ).includes( 'sk-very-secret' ) );
			assert.ok( !String( error.stack ).includes( 'sk-very-secret' ) );
			return true;
		} ) );
	} finally {
		fs.chmodSync( path.join( _root, '.env' ), 0o600 );
	}
} );

attack( S, 'load: two roots read in one process each give their own values (no stale .env)', async () => {
	const _clean = Object.fromEntries( KEYS.map( key => [ key, undefined ] ) );
	const [ _a, _b ] = [ tempDir( 'config' ), tempDir( 'config' ) ];
	fs.writeFileSync( path.join( _a, '.env' ), 'LLM_MODEL=first' );
	fs.writeFileSync( path.join( _b, '.env' ), 'LLM_MODEL=second' );
	await withEnv( _clean, () => {
		assert.equal( Config.load( _a ).llm.model, 'first' );
		assert.equal( Config.load( _b ).llm.model, 'second' );
	} );
} );

// Numbers that are not numbers must stop the start, not become NaN deep inside (a NaN depth disables R2, a NaN
// beat makes a timer fire every millisecond, a NaN buffer breaks G-1b deadlines).
const NUMERIC = [
	{ key: 'CORE_PORT', read: config => config.core.port },
	{ key: 'GATE_PORT', read: config => config.gate.port },
	{ key: 'BUFFER_MINUTES', read: config => config.gate.bufferMinutes, rule: 'G-1b' },
	{ key: 'LLM_TIMEOUT', read: config => config.llm.timeoutSeconds, rule: 'A2' },
	{ key: 'SANDBOX_TIMEOUT', read: config => config.sandbox.timeoutSeconds, rule: 'A7' },
	{ key: 'MAX_DEPTH', read: config => config.maxDepth, rule: 'R2' },
	{ key: 'WORLD_SPEED', read: config => config.worldSpeed },
	{ key: 'LEASE_BEAT_MS', read: config => config.beatMs, rule: 'A1' },
];
attacks( S, NUMERIC.map( item => ( {
	...item, name: `load: ${item.key}=eight is refused, never a NaN setting`,
} ) ), async ( { key, read } ) => {
	let _config;
	try {
		( { config: _config } = await load( `${key}=eight` ) );
	} catch ( error ) {
		assert.match( error.message, new RegExp( key ) );
		return;
	}
	assert.ok( !Number.isNaN( read( _config ) ), `${key} became NaN` );
} );

// Every hostile single-line string, quoted, comes back byte for byte (passwords and keys are arbitrary text).
const VALUES = hostile( 'strings' ).filter( item => ![ '\r', '\n', '\u0000' ].some( char => item.value.includes( char ) ) );
attacks( S, VALUES.map( item => ( { ...item, name: `readEnv: the quoted value ${item.label} comes back unchanged` } ) ), async ( { value } ) => {
	const _key = fresh();
	await envFile( [ `${_key}="${value}"`, `${_key}_NEXT=still-read` ], ( file ) => {
		Config.readEnv( file );
		assert.equal( process.env[ _key ], value );
		assert.equal( process.env[ `${_key}_NEXT` ], 'still-read' );
		assert.equal( {}.polluted, undefined );
	}, [ _key, `${_key}_NEXT` ] );
} );
