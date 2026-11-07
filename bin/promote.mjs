// Writes a kind of task as a mission folder, after people approved its parts piece by piece:
//   node bin/promote.mjs <kind> --to <folder>          from the running core (CORE_URL, CORE_BOARD_PIN when the board has one)
//   node bin/promote.mjs --bundle <file> --to <folder>  from a bundle the control room saved
// The folder <folder>/<kind> must not exist yet; nothing is ever written over. Afterwards bin/check-mission.mjs checks it.
// The operator then reviews and commits it, adds <folder> to AGENCY_MISSIONS for core and gate, and restarts both: from
// then on it is a mission like any other, and its actions and master data are the operator's files.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { boot, ROOT } from '../lib/node.mjs';

const app = boot();
const [ Config, Missions ] = await app.use( [ 'Lib.Config', 'Lib.Missions' ] );
Config.readEnv( path.join( ROOT, '.env' ) );

function args( argv ) {
	const _out = { kind: null, to: null, bundle: null };
	for ( let i = 0; i < argv.length; i++ ) {
		if ( argv[ i ] === '--to' ) { _out.to = argv[ ++i ]; } else if ( argv[ i ] === '--bundle' ) { _out.bundle = argv[ ++i ]; } else { _out.kind = argv[ i ]; }
	}
	return _out;
}

async function fetched( kind ) {
	const _base = ( process.env.CORE_URL || `http://127.0.0.1:${process.env.CORE_PORT || 8090}` ).replace( /\/$/, '' );
	const _pin = process.env.CORE_BOARD_PIN ? { 'x-board-pin': process.env.CORE_BOARD_PIN } : {};
	const _response = await fetch( `${_base}/api/tasks/${encodeURIComponent( kind )}/mission`, { headers: _pin, redirect: 'error' } );
	const _body = await _response.json().catch( () => null );
	if ( !_response.ok ) { throw new Error( `the core answered ${_response.status}: ${_body?.error || 'no reason'}` ); }
	return _body;
}

const fail = ( message ) => {
	console.error( message );
	process.exit( 1 );
};

const _given = args( process.argv.slice( 2 ) );
if ( !_given.to || ( !_given.kind && !_given.bundle ) ) { fail( 'usage: node bin/promote.mjs <kind> --to <folder>  |  node bin/promote.mjs --bundle <file> --to <folder>' ); }
const _bundle = _given.bundle ? JSON.parse( fs.readFileSync( _given.bundle, 'utf8' ) ) : await fetched( _given.kind ).catch( error => fail( error.message ) );
if ( !_bundle || typeof _bundle.kind !== 'string' || !Missions.ID.test( _bundle.kind ) || !_bundle.files || typeof _bundle.files !== 'object' ) {
	fail( 'no mission bundle: it needs a kind (a plain name) and its files' );
}
if ( _given.kind && _given.kind !== _bundle.kind ) { fail( `the bundle is of the kind ${_bundle.kind}, not ${_given.kind}` ); }
const _names = Object.keys( _bundle.files );
const _allowed = /^(mission|contract|strategies|moves|gates|actions|master)\.json$/;
if ( !_names.includes( 'mission.json' ) || !_names.every( name => _allowed.test( name ) ) ) { fail( `a bundle holds mission.json and known files only, not ${_names.join( ', ' )}` ); }
const _folder = path.resolve( _given.to, _bundle.kind );
if ( fs.existsSync( _folder ) ) { fail( `${_folder} exists already; nothing is written over` ); }
fs.mkdirSync( _folder, { recursive: true } );
for ( const name of _names ) { fs.writeFileSync( path.join( _folder, name ), `${JSON.stringify( _bundle.files[ name ], null, 2 )}\n` ); }
console.log( `written: ${_folder} (${_names.sort().join( ', ' )})` );
const _check = spawnSync( process.execPath, [ '--disable-warning=ExperimentalWarning', path.join( ROOT, 'bin', 'check-mission.mjs' ), _bundle.kind ], {
	encoding: 'utf8', env: { ...process.env, AGENCY_MISSIONS: path.resolve( _given.to ) },
} );
process.stdout.write( _check.stdout || '' );
process.stderr.write( _check.stderr || '' );
console.log( _check.status === 0
	? `next: review and commit ${_folder}, add ${path.resolve( _given.to )} to AGENCY_MISSIONS of core and gate, restart both`
	: 'the check found problems; fix them in the folder before it runs as a mission' );
process.exit( _check.status === 0 ? 0 : 1 );
