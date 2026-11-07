// lib/http.js under attack, part 2: static files (the core serves ui/ and lib/ to the browser). Only files below
// the folder may ever leave, whatever the path looks like; a file that cannot be read must not take the server down.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attack, attacks } from '../hostile.mjs';
import { agency, server, raw, get, tempDir, child, lastJson, ROOT } from './tools.mjs';

const [ Http ] = await agency.use( [ 'Lib.Http' ] );
const S = 'lib/http.js';

// A tree: base/pub (served), base/pub-secret and base/outside.txt (never served).
function tree() {
	const _base = tempDir( 'static' );
	const _pub = path.join( _base, 'pub' );
	fs.mkdirSync( path.join( _pub, 'sub' ), { recursive: true } );
	fs.mkdirSync( path.join( _base, 'pub-secret' ) );
	fs.writeFileSync( path.join( _pub, 'index.html' ), '<h1>index</h1>' );
	fs.writeFileSync( path.join( _pub, 'app.js' ), 'console.log(1)' );
	fs.writeFileSync( path.join( _pub, 'style.css' ), 'a{}' );
	fs.writeFileSync( path.join( _pub, 'data.json' ), '{"a":1}' );
	fs.writeFileSync( path.join( _pub, 'logo.svg' ), '<svg/>' );
	fs.writeFileSync( path.join( _pub, 'blob.bin' ), Buffer.from( [ 0, 1, 2 ] ) );
	fs.writeFileSync( path.join( _pub, 'a b.txt' ), 'with a blank' );
	fs.writeFileSync( path.join( _pub, 'sub', 'index.html' ), '<h1>sub</h1>' );
	fs.writeFileSync( path.join( _base, 'pub-secret', 'key.txt' ), 'SECRET-SIBLING' );
	fs.writeFileSync( path.join( _base, 'outside.txt' ), 'SECRET-OUTSIDE' );
	return { base: _base, pub: _pub };
}

async function serving( fn, setup = () => {} ) {
	const _tree = tree();
	const _srv = await server( Http, ( http ) => {
		setup( http );
		http.serve( '/static/', _tree.pub );
	} );
	try {
		return await fn( _srv, _tree );
	} finally {
		await _srv.stop();
	}
}
const leaked = response => /SECRET|root:|PRIVATE/.test( response.body );

attack( S, 'a file is served with its content type', () => serving( async ( srv ) => {
	const _cases = { 'app.js': 'text/javascript', 'style.css': 'text/css', 'data.json': 'application/json', 'logo.svg': 'image/svg+xml' };
	for ( const [ name, type ] of Object.entries( _cases ) ) {
		const _r = await get( srv.port, `/static/${name}` );
		assert.equal( _r.status, 200, name );
		assert.match( _r.head, new RegExp( `Content-Type: ${type.replace( '+', '\\+' )}` ), name );
	}
} ) );

attack( S, 'an unknown extension is served as application/octet-stream, never guessed as html', () => serving( async ( srv ) => {
	assert.match( ( await get( srv.port, '/static/blob.bin' ) ).head, /Content-Type: application\/octet-stream/ );
} ) );

attack( S, 'a folder with a trailing slash serves its index.html; the prefix alone serves the root index', () => serving( async ( srv ) => {
	assert.equal( ( await get( srv.port, '/static/sub/' ) ).body, '<h1>sub</h1>' );
	assert.equal( ( await get( srv.port, '/static/' ) ).body, '<h1>index</h1>' );
} ) );

attack( S, 'a folder without a trailing slash is not found (no directory listing)', () => serving( async ( srv ) => {
	const _r = await get( srv.port, '/static/sub' );
	assert.equal( _r.status, 404 );
	assert.doesNotMatch( _r.body, /index\.html/ );
} ) );

attack( S, 'a missing file is a JSON 404', () => serving( async ( srv ) => {
	const _r = await get( srv.port, '/static/nope.js' );
	assert.equal( _r.status, 404 );
	assert.deepEqual( JSON.parse( _r.body ), { error: 'not found' } );
} ) );

attack( S, 'only GET serves files: POST and PUT to a file are not found', () => serving( async ( srv ) => {
	for ( const method of [ 'POST', 'PUT', 'DELETE' ] ) {
		const _r = await raw( srv.port, `${method} /static/app.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 0\r\n\r\n` );
		assert.equal( _r.status, 404, method );
	}
} ) );

attack( S, 'a route on the same path wins over a file', () => serving( async ( srv ) => {
	assert.equal( ( await get( srv.port, '/static/app.js' ) ).body, '{"route":true}' );
}, http => http.route( 'GET', '/static/app.js', ( { res } ) => Http.json( res, 200, { route: true } ) ) ) );

attack( S, 'a prefix without its trailing slash is not served', () => serving( async ( srv ) => {
	assert.equal( ( await get( srv.port, '/static' ) ).status, 404 );
	assert.equal( ( await get( srv.port, '/staticapp.js' ) ).status, 404 );
} ) );

attack( S, 'an absolute path after the prefix never reaches a sibling folder whose name starts the same', () => serving( async ( srv, dirs ) => {
	const _r = await get( srv.port, `/static/${path.join( dirs.base, 'pub-secret', 'key.txt' )}` );
	assert.equal( leaked( _r ), false, 'the sibling\'s secret was served' );
	assert.equal( _r.status, 404 );
} ) );

attack( S, 'a file name with an encoded blank (%20) is found', () => serving( async ( srv ) => {
	const _r = await get( srv.port, '/static/a%20b.txt' );
	assert.equal( _r.status, 200 );
	assert.equal( _r.body, 'with a blank' );
} ) );

attack( S, 'a file that exists but cannot be read does not crash the process', () => {
	const _dirs = tree();
	fs.writeFileSync( path.join( _dirs.pub, 'locked.txt' ), 'x' );
	fs.chmodSync( path.join( _dirs.pub, 'locked.txt' ), 0 );
	try {
		const _result = child( `
			import { boot } from './lib/node.mjs';
			import net from 'node:net';
			const app = boot( { overrides: '' } );
			const [ Http ] = await app.use( [ 'Lib.Http' ] );
			app.fail = () => {};
			const http = new Http();
			http.serve( '/static/', ${JSON.stringify( _dirs.pub )} );
			const port = await http.listen( 0, '127.0.0.1' );
			const ask = target => new Promise( ( resolve ) => {
				const socket = net.connect( port, '127.0.0.1', () => socket.write( 'GET ' + target + ' HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n' ) );
				let text = '';
				socket.on( 'data', chunk => { text += chunk; } );
				socket.on( 'error', () => {} );
				socket.on( 'close', () => resolve( text.split( '\\r\\n' )[ 0 ] ) );
			} );
			const first = await ask( '/static/locked.txt' );
			await new Promise( resolve => setTimeout( resolve, 50 ) );
			const second = await ask( '/static/app.js' );
			console.log( JSON.stringify( { first, second } ) );
			http.server.closeAllConnections();
			await http.close();
		`, { timeout: 8000 } );
		assert.equal( _result.status, 0, `the server process died: ${_result.stderr.split( '\n' ).find( line => /Error|EACCES/.test( line ) )}` );
		assert.match( lastJson( _result.stdout ).second, /200/ );
	} finally {
		fs.chmodSync( path.join( _dirs.pub, 'locked.txt' ), 0o600 );
	}
} );

attack( S, 'a symlink inside the folder that points outside is followed (operator\'s choice, documented)', () => serving( async ( srv, dirs ) => {
	fs.symlinkSync( path.join( dirs.base, 'outside.txt' ), path.join( dirs.pub, 'link.txt' ) );
	assert.equal( ( await get( srv.port, '/static/link.txt' ) ).body, 'SECRET-OUTSIDE' );
} ) );

attack( S, 'the real ui/ and lib/ folders: index and a class file are served, nothing above them', async () => {
	const _srv = await server( Http, ( http ) => {
		http.serve( '/ui/', path.join( ROOT, 'ui' ) );
		http.serve( '/lib/', path.join( ROOT, 'lib' ) );
	} );
	try {
		assert.equal( ( await get( _srv.port, '/lib/hash.js' ) ).status, 200 );
		const _targets = [ '/lib/../package.json', '/lib/%2e%2e/package.json', '/lib/..%2fpackage.json', '/ui/../package.json',
			`/lib/${ROOT}/package.json`, '/lib//etc/passwd' ];
		for ( const target of _targets ) {
			const _r = await get( _srv.port, target );
			assert.notEqual( _r.status, 200, target );
			assert.doesNotMatch( _r.body, /"name": "strategic-agency"|root:/, target );
		}
	} finally {
		await _srv.stop();
	}
} );

// Ways out of the folder, sent raw so no client normalizes them first.
const ESCAPES = [
	'/static/../outside.txt', '/static/../../outside.txt', '/static/%2e%2e/outside.txt', '/static/%2E%2E/outside.txt',
	'/static/.%2e/outside.txt', '/static/..%2foutside.txt', '/static/..%2Foutside.txt', '/static/..%5coutside.txt',
	'/static/..\\outside.txt', '/static/sub/../../outside.txt', '/static/./../outside.txt', '/static//etc/passwd',
	'/static/%2fetc%2fpasswd', '/static/....//outside.txt', '/static/..;/outside.txt', '/static/%c0%ae%c0%ae/outside.txt',
	'/static/%00../outside.txt', '/static/..%00/outside.txt', '/static/~/outside.txt', '/static/%252e%252e/outside.txt',
	'/static/../pub-secret/key.txt', '/static/%2e%2e%2fpub-secret%2fkey.txt',
];
attacks( S, ESCAPES.map( target => ( { name: `path ${target} never leaves the folder`, target } ) ), ( { target } ) => serving( async ( srv ) => {
	const _r = await get( srv.port, target );
	assert.equal( leaked( _r ), false, `${target} leaked` );
	assert.ok( [ 400, 404 ].includes( _r.status ), `${target} → ${_r.status}` );
	assert.equal( ( await get( srv.port, '/static/app.js' ) ).status, 200, 'the server still serves' );
} ) );
