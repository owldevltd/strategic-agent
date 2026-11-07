// Shared tools of the lib/ stress tests: temporary folders that vanish with the process, a scoped environment, a
// real HTTP server on port 0 with a raw client, a quiet app.fail, and a child Node process for what must not run
// inside the test process (a second boot, a crash, an unhandled rejection).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { boot, ROOT } from '../../../lib/node.mjs';

export const agency = boot( { overrides: '' } );
export { ROOT };

const folders = [];
process.on( 'exit', () => folders.forEach( dir => fs.rmSync( dir, { recursive: true, force: true } ) ) );

export function tempDir( name = 'lib' ) {
	const _dir = fs.mkdtempSync( path.join( os.tmpdir(), `stress-${name}-` ) );
	folders.push( _dir );
	return _dir;
}

// Runs fn with these environment variables (undefined removes one); everything is restored afterwards.
export async function withEnv( vars, fn ) {
	const _saved = Object.fromEntries( Object.keys( vars ).map( key => [ key, process.env[ key ] ] ) );
	const _apply = ( values ) => {
		for ( const [ key, value ] of Object.entries( values ) ) {
			if ( value === undefined ) {
				delete process.env[ key ];
			} else {
				process.env[ key ] = value;
			}
		}
	};
	_apply( vars );
	try {
		return await fn();
	} finally {
		_apply( _saved );
	}
}

// app.fail collects instead of printing; restore() puts the real one back.
export function quiet() {
	const _original = agency.fail;
	const _errors = [];
	agency.fail = error => _errors.push( error );
	return { errors: _errors, restore: () => { agency.fail = _original; } };
}

// The hostile values of these groups, each value once (the groups overlap).
export function distinct( items ) {
	const _seen = [];
	return items.filter( ( item ) => {
		if ( _seen.some( value => Object.is( value, item.value ) ) ) { return false; }
		_seen.push( item.value );
		return true;
	} );
}

// A Lib.Http server on 127.0.0.1:0; setup( http, Http ) adds routes. stop() drops every connection first.
export async function server( Http, setup, options = {} ) {
	const _http = new Http( options );
	setup( _http, Http );
	const _port = await _http.listen( 0, '127.0.0.1' );
	return {
		http: _http, port: _port, url: `http://127.0.0.1:${_port}`,
		stop: () => {
			_http.server.closeAllConnections();
			return _http.close();
		},
	};
}

// The body of a chunked answer, as far as it came.
function dechunk( text ) {
	let _rest = text;
	let _body = '';
	for ( ;; ) {
		const _line = _rest.indexOf( '\r\n' );
		if ( _line < 0 ) { return _body; }
		const _size = parseInt( _rest.slice( 0, _line ), 16 );
		if ( !( _size > 0 ) ) { return _body; }
		const _bytes = Buffer.from( _rest.slice( _line + 2 ) );
		_body += _bytes.subarray( 0, _size ).toString( 'utf8' );
		_rest = _bytes.subarray( _size + 2 ).toString( 'utf8' );
	}
}

// A raw request line and headers as written, so nothing normalizes the target. Resolves with what came back when
// the server closes the connection or after wait ms.
// A list of parts is written one part per turn of the event loop (bytes dripping in).
export function raw( port, text, { wait = 1500 } = {} ) {
	return new Promise( ( resolve ) => {
		const _socket = net.connect( port, '127.0.0.1', async () => {
			for ( const part of Array.isArray( text ) ? text : [ text ] ) {
				_socket.write( part );
				await new Promise( done => setImmediate( done ) );
			}
		} );
		const _chunks = [];
		let _ended = false;
		const _done = () => {
			clearTimeout( _timer );
			const _text = Buffer.concat( _chunks ).toString( 'utf8' );
			const [ _head, ..._rest ] = _text.split( '\r\n\r\n' );
			const _status = Number( ( _head.match( /^HTTP\/1\.1 (\d+)/ ) || [] )[ 1 ] || 0 );
			const _raw = _rest.join( '\r\n\r\n' );
			const _body = /^transfer-encoding: chunked/im.test( _head ) ? dechunk( _raw ) : _raw;
			_socket.destroy();
			resolve( { status: _status, head: _head, body: _body, text: _text, ended: _ended } );
		};
		const _timer = setTimeout( _done, wait );
		_socket.on( 'data', chunk => _chunks.push( chunk ) );
		_socket.on( 'error', () => {} );
		_socket.on( 'close', () => {
			_ended = true;
			_done();
		} );
	} );
}

export function get( port, target, headers = '' ) {
	return raw( port, `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${headers}\r\n` );
}

export function post( port, target, body, headers = '' ) {
	const _body = Buffer.from( body );
	const _head = `POST ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: application/json\r\n`
		+ `Content-Length: ${_body.length}\r\n${headers}\r\n`;
	return raw( port, Buffer.concat( [ Buffer.from( _head ), _body ] ) );
}

// A plain node:http server for the client side (Http.request); handler( req, res, hits ).
export async function plain( handler ) {
	let _hits = 0;
	const _server = http.createServer( ( req, res ) => {
		_hits += 1;
		handler( req, res, _hits );
	} );
	await new Promise( resolve => _server.listen( 0, '127.0.0.1', resolve ) );
	return {
		url: `http://127.0.0.1:${_server.address().port}`,
		hits: () => _hits,
		stop: () => new Promise( ( resolve ) => {
			_server.closeAllConnections();
			_server.close( () => resolve() );
		} ),
	};
}

const childArgs = code => [ '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code ];

// Runs an ES module in a fresh Node process (its own app); env adds to a copy of this environment.
export function child( code, { env = {}, cwd = ROOT, timeout = 10000 } = {} ) {
	const _result = spawnSync( process.execPath, childArgs( code ), {
		cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout,
	} );
	return { status: _result.status, signal: _result.signal, stdout: _result.stdout || '', stderr: _result.stderr || '' };
}

// The same, without blocking, so several children can run at once.
export function childAsync( code, { env = {}, cwd = ROOT, timeout = 10000 } = {} ) {
	return new Promise( ( resolve ) => {
		const _child = spawn( process.execPath, childArgs( code ), { cwd, env: { ...process.env, ...env }, timeout } );
		let _out = '';
		let _err = '';
		_child.stdout.on( 'data', ( chunk ) => { _out += chunk; } );
		_child.stderr.on( 'data', ( chunk ) => { _err += chunk; } );
		_child.on( 'close', status => resolve( { status, stdout: _out, stderr: _err } ) );
	} );
}

// A random JSON value (only what JSON can carry), from a seeded source.
export function tree( rnd, depth = 3 ) {
	const _kind = depth <= 0 ? rnd.int( 0, 3 ) : rnd.int( 0, 5 );
	if ( _kind === 0 ) { return rnd.string( rnd.int( 0, 8 ), 'aäz€😀"\\\n:,{}[] ' ); }
	if ( _kind === 1 ) { return rnd.pick( [ rnd.int( -1e6, 1e6 ), rnd() * 1e3, 0, -1.5 ] ); }
	if ( _kind === 2 ) { return rnd.pick( [ true, false ] ); }
	if ( _kind === 3 ) { return null; }
	if ( _kind === 4 ) { return Array.from( { length: rnd.int( 0, 4 ) }, () => tree( rnd, depth - 1 ) ); }
	return Object.fromEntries( Array.from( { length: rnd.int( 0, 4 ) }, () => [ rnd.string( rnd.int( 0, 5 ) ), tree( rnd, depth - 1 ) ] ) );
}

// The same value with every object's keys inserted in another (random) order.
export function shuffled( rnd, value ) {
	if ( Array.isArray( value ) ) { return value.map( item => shuffled( rnd, item ) ); }
	if ( value && typeof value === 'object' ) {
		const _keys = Object.keys( value ).sort( () => rnd() - 0.5 );
		return Object.fromEntries( _keys.map( key => [ key, shuffled( rnd, value[ key ] ) ] ) );
	}
	return value;
}

// The line a child printed last, parsed as JSON.
export function lastJson( text ) {
	const _lines = text.trim().split( '\n' );
	return JSON.parse( _lines[ _lines.length - 1 ] );
}
