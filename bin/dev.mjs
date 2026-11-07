import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Development: starts the gate and the core as two separate processes, as in production, and stops both
// together. Output is prefixed with the process name.

const here = path.dirname( fileURLToPath( import.meta.url ) );
const children = [];

function start( name, file ) {
	const _child = spawn( process.execPath, [ '--disable-warning=ExperimentalWarning', path.join( here, file ) ], { stdio: [ 'ignore', 'pipe', 'pipe' ] } );
	const _prefix = data => String( data ).split( '\n' ).filter( Boolean ).map( line => `[${name}] ${line}` ).join( '\n' );
	_child.stdout.on( 'data', data => console.log( _prefix( data ) ) );
	_child.stderr.on( 'data', data => console.error( _prefix( data ) ) );
	_child.on( 'exit', ( code, signal ) => {
		console.log( `[${name}] exited with ${code ?? signal}` );
		// One process ending on its own ends both; a crash is the exit code of the whole.
		stop( stopping ? 0 : code || 1 );
	} );
	children.push( _child );
}

let stopping = false;
function stop( code = 0 ) {
	if ( !stopping ) { process.exitCode = code; }
	stopping = true;
	children.forEach( child => child.exitCode === null && child.kill() );
}

process.on( 'SIGINT', () => stop( 0 ) );
process.on( 'SIGTERM', () => stop( 0 ) );
start( 'gate', 'gate.mjs' );
setTimeout( () => start( 'core', 'core.mjs' ), 400 );
