// lib/http.js under attack, part 1: the router of the core and the gate. Real servers on 127.0.0.1:0 and raw
// requests, so nothing in between normalizes what an attacker can send. A bad request is the client's fault (4xx),
// a server that hangs or dies is a defect.
import assert from 'node:assert/strict';
import { attack, attacks, within } from '../hostile.mjs';
import { agency, server, raw, get, post, quiet } from './tools.mjs';

const [ Http ] = await agency.use( [ 'Lib.Http' ] );
const S = 'lib/http.js';

// A server with an echo route for each method and the given extra routes; fn( srv ) runs the attack.
async function serve( fn, { routes = () => {}, cors = false } = {} ) {
	const _quiet = quiet();
	const _srv = await server( Http, ( http ) => {
		routes( http );
		http.route( 'GET', '/echo/:id/:part', ( { res, params, query } ) => Http.json( res, 200, { params, query: Object.fromEntries( query ) } ) );
		http.route( 'POST', '/echo', ( { res, body } ) => Http.json( res, 200, { body } ) );
		http.route( 'PUT', '/echo', ( { res, body } ) => Http.json( res, 200, { body } ) );
		http.route( 'GET', '/body', ( { res, body } ) => Http.json( res, 200, { body } ) );
	}, { cors } );
	try {
		return await fn( _srv, _quiet.errors );
	} finally {
		_quiet.restore();
		await _srv.stop();
	}
}
const json = response => JSON.parse( response.body );

attack( S, 'params are decoded and the query is available', () => serve( async ( srv ) => {
	const _r = await get( srv.port, '/echo/a%20b/%F0%9F%98%80?x=1&y=%C3%BC' );
	assert.equal( _r.status, 200 );
	assert.deepEqual( json( _r ), { params: { id: 'a b', part: '😀' }, query: { x: '1', y: 'ü' } } );
} ) );

attack( S, 'a route answers only its own method; others get 404 JSON', () => serve( async ( srv ) => {
	assert.equal( ( await raw( srv.port, 'DELETE /echo HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n' ) ).status, 404 );
	const _r = await get( srv.port, '/echo' );
	assert.equal( _r.status, 404 );
	assert.deepEqual( json( _r ), { error: 'not found' } );
	assert.match( _r.head, /Cache-Control: no-store/i );
} ) );

attack( S, 'the first matching route wins', () => serve( async ( srv ) => {
	assert.equal( json( await get( srv.port, '/first/x' ) ).route, 'specific' );
	assert.equal( json( await get( srv.port, '/first/y' ) ).route, 'general' );
}, {
	routes: ( http ) => {
		http.route( 'GET', '/first/x', ( { res } ) => Http.json( res, 200, { route: 'specific' } ) );
		http.route( 'GET', '/first/:any', ( { res } ) => Http.json( res, 200, { route: 'general' } ) );
	},
} ) );

attack( S, 'paths match exactly: trailing slash, other case or extra segments are not found', () => serve( async ( srv ) => {
	for ( const target of [ '/echo/a/b/', '/ECHO/a/b', '/echo/a/b/c', '/echo/a', '/echo//b' ] ) {
		assert.equal( ( await get( srv.port, target ) ).status, 404, target );
	}
} ) );

attack( S, 'a literal dot in a route pattern matches only a dot', () => serve( async ( srv ) => {
	assert.equal( ( await get( srv.port, '/file.json' ) ).status, 200 );
	assert.equal( ( await get( srv.port, '/fileXjson' ) ).status, 404 );
}, { routes: http => http.route( 'GET', '/file.json', ( { res } ) => Http.json( res, 200, {} ) ) } ) );

attack( S, 'a request target starting with // is a path, not a host to drop', () => serve( async ( srv ) => {
	const _r = await get( srv.port, '//evil.example/echo/a/b' );
	assert.equal( _r.status, 404, 'answered as /echo/a/b' );
} ) );

attack( S, 'an absolute-form target (proxy style) is routed by its path', () => serve( async ( srv ) => {
	const _r = await get( srv.port, 'http://localhost/echo/a/b' );
	assert.equal( _r.status, 200 );
	assert.deepEqual( json( _r ).params, { id: 'a', part: 'b' } );
} ) );

attack( S, 'malformed percent-encoding in a param is a 400, not a 500', () => serve( async ( srv, errors ) => {
	const _r = await get( srv.port, '/echo/%E0%A4%A/b' );
	assert.equal( _r.status, 400 );
	assert.equal( errors.length, 0, 'a bad request is not a server fault' );
} ) );

attack( S, 'an encoded slash or dot-dot in a param reaches the handler decoded (handlers must check ids)', () => serve( async ( srv ) => {
	const _r = await get( srv.port, '/echo/..%2F..%2Fetc%2Fpasswd/b' );
	assert.equal( _r.status, 200 );
	assert.equal( json( _r ).params.id, '../../etc/passwd' );
} ) );

attack( S, 'POST and PUT bodies are parsed as JSON', () => serve( async ( srv ) => {
	assert.deepEqual( json( await post( srv.port, '/echo', '{"a":[1,{"b":"ü"}]}' ) ), { body: { a: [ 1, { b: 'ü' } ] } } );
	const _put = await raw( srv.port, 'PUT /echo HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 7\r\n\r\n{"p":1}' );
	assert.deepEqual( json( _put ), { body: { p: 1 } } );
} ) );

attack( S, 'an empty POST body is {}', () => serve( async ( srv ) => {
	assert.deepEqual( json( await post( srv.port, '/echo', '' ) ), { body: {} } );
} ) );

attack( S, 'a GET with a body ignores it', () => serve( async ( srv ) => {
	const _r = await raw( srv.port, 'GET /body HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 7\r\n\r\n{"a":1}' );
	assert.deepEqual( json( _r ), { body: {} } );
} ) );

attack( S, 'a multi-byte character split across TCP packets is decoded correctly', () => serve( async ( srv ) => {
	const _body = Buffer.from( '{"s":"😀ü€"}' );
	const _head = `POST /echo HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: ${_body.length}\r\n\r\n`;
	const _r = await raw( srv.port, [ _head, ...[ ..._body ].map( byte => Buffer.from( [ byte ] ) ) ] );
	assert.deepEqual( json( _r ), { body: { s: '😀ü€' } } );
} ) );

attack( S, 'a body that is not JSON is a 400 for the client, not a 500', () => serve( async ( srv, errors ) => {
	const _r = await post( srv.port, '/echo', '{"a":' );
	assert.equal( _r.status, 400 );
	assert.equal( errors.length, 0 );
} ) );

attack( S, 'a JSON body that is not an object (null, 5, "s", [], true) never reaches a handler as such', () => serve( async ( srv ) => {
	for ( const body of [ 'null', '5', '"s"', '[]', 'true' ] ) {
		const _r = await post( srv.port, '/echo', body );
		const _ok = _r.status === 400 || ( _r.status === 200 && JSON.stringify( json( _r ).body ) === '{}' );
		assert.ok( _ok, `${body} reached the handler as ${_r.body}` );
	}
} ) );

attack( S, 'a body far larger than any request needs is refused with 413', () => serve( async ( srv ) => {
	const _big = `{"a":"${'x'.repeat( 8 * 1024 * 1024 )}"}`;
	const _r = await within( post( srv.port, '/echo', _big ), 5000, 'an 8 MB body' );
	assert.equal( _r.status, 413 );
} ) );

attack( S, 'a body that is not UTF-8 is a 400, never text with replacement characters', () => serve( async ( srv, errors ) => {
	const _head = 'POST /echo HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 9\r\n\r\n';
	const _body = Buffer.from( [ 0x7B, 0x22, 0x61, 0x22, 0x3A, 0x22, 0xFF, 0x22, 0x7D ] );
	const _r = await raw( srv.port, Buffer.concat( [ Buffer.from( _head ), _body ] ) );
	assert.equal( _r.status, 400 );
	assert.equal( errors.length, 0 );
} ) );

attack( S, 'a handler that throws Http.refusal answers its 4xx status and reason, and is no server fault', () => serve( async ( srv, errors ) => {
	const _r = await get( srv.port, '/refuse' );
	assert.equal( _r.status, 409 );
	assert.deepEqual( json( _r ), { error: 'already running' } );
	assert.equal( errors.length, 0 );
}, { routes: http => http.route( 'GET', '/refuse', () => { throw Http.refusal( 409, 'already running' ); } ) } ) );

attack( S, 'the body limit is an option: a server may take less, a single route more (the gate takes 7 MiB)', async () => {
	const _body = JSON.stringify( { a: 'x'.repeat( 2 * 1024 * 1024 ) } );
	const _small = await server( Http, http => http.route( 'POST', '/echo', ( { res } ) => Http.json( res, 200, {} ) ), { maxBody: 100 } );
	const _large = await server( Http, http => http.route( 'POST', '/big', ( { res, body } ) => Http.json( res, 200, { size: body.a.length } ), { maxBody: 7 * 1024 * 1024 } ) );
	try {
		assert.equal( ( await post( _small.port, '/echo', JSON.stringify( { a: 'x'.repeat( 200 ) } ) ) ).status, 413 );
		assert.equal( ( await post( _small.port, '/echo', '{"a":1}' ) ).status, 200 );
		assert.deepEqual( json( await within( post( _large.port, '/big', _body ), 5000, 'a 2 MiB body' ) ), { size: 2 * 1024 * 1024 } );
	} finally {
		await _small.stop();
		await _large.stop();
	}
	assert.throws( () => new Http( { maxBody: -1 } ), RangeError );
} );

attack( S, 'a __proto__ key in a body pollutes nothing and stays an own key', () => serve( async ( srv ) => {
	const _r = await post( srv.port, '/echo', '{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}' );
	assert.equal( _r.status, 200 );
	assert.equal( {}.polluted, undefined );
	assert.equal( {}.x, undefined );
	assert.deepEqual( json( _r ).body.__proto__, { polluted: true } );
} ) );

attack( S, 'a client that aborts in the middle of a body does not hurt the server', () => serve( async ( srv ) => {
	const { default: net } = await import( 'node:net' );
	await new Promise( ( resolve ) => {
		const _socket = net.connect( srv.port, '127.0.0.1', () => {
			_socket.write( 'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n{"a":' );
			setTimeout( () => {
				_socket.destroy();
				resolve();
			}, 20 );
		} );
	} );
	assert.equal( ( await get( srv.port, '/echo/a/b' ) ).status, 200 );
} ) );

attack( S, 'a handler that throws gives a 500 with a generic message, never its message or the stack', () => serve( async ( srv, errors ) => {
	const _r = await get( srv.port, '/boom' );
	assert.equal( _r.status, 500 );
	assert.deepEqual( json( _r ), { error: 'internal error' } );
	assert.ok( !_r.body.includes( 'at ' ) && !_r.body.includes( '.js:' ) );
	assert.equal( errors.length, 1 );
}, { routes: http => http.route( 'GET', '/boom', () => { throw new Error( 'handler failed' ); } ) } ) );

attack( S, 'an async handler that rejects gives a 500 as well', () => serve( async ( srv ) => {
	const _r = await get( srv.port, '/later' );
	assert.equal( _r.status, 500 );
	assert.deepEqual( json( _r ), { error: 'internal error' } );
}, { routes: http => http.route( 'GET', '/later', async () => { await null; throw new Error( 'later failed' ); } ) } ) );

attack( S, 'a handler that throws a non-error still gets an answer', () => serve( async ( srv ) => {
	const _r = await get( srv.port, '/odd' );
	assert.equal( _r.status, 500 );
	assert.ok( _r.ended );
}, { routes: http => http.route( 'GET', '/odd', () => { throw 'just text'; } ) } ) );

attack( S, 'a handler that fails after the headers went out: the response is ended, not left hanging', () => serve( async ( srv ) => {
	const _r = await get( srv.port, '/half' );
	assert.equal( _r.status, 200 );
	assert.ok( _r.ended, 'the client still waits after 1.5 s' );
}, {
	routes: http => http.route( 'GET', '/half', ( { res } ) => {
		res.writeHead( 200 );
		res.write( 'partial' );
		throw new Error( 'after the head' );
	} ),
} ) );

attack( S, 'Http.json with data that cannot be serialized answers 500 instead of hanging', () => serve( async ( srv ) => {
	const _r = await get( srv.port, '/bigint' );
	assert.ok( _r.ended, 'the client still waits after 1.5 s' );
	assert.equal( _r.status, 500 );
}, { routes: http => http.route( 'GET', '/bigint', ( { res } ) => Http.json( res, 200, { amount: 10n } ) ) } ) );

attack( S, 'a handler that never answers does not block other requests', () => serve( async ( srv ) => {
	const _stuck = raw( srv.port, 'GET /never HTTP/1.1\r\nHost: x\r\n\r\n', { wait: 300 } );
	assert.equal( ( await get( srv.port, '/echo/a/b' ) ).status, 200 );
	await _stuck;
}, { routes: http => http.route( 'GET', '/never', () => new Promise( () => {} ) ) } ) );

attack( S, '200 parallel requests are all answered correctly', () => serve( async ( srv ) => {
	const _all = await within( Promise.all( Array.from( { length: 200 }, ( _, i ) => get( srv.port, `/echo/${i}/p` ) ) ), 8000 );
	assert.ok( _all.every( ( r, i ) => r.status === 200 && json( r ).params.id === String( i ) ) );
} ) );

attack( S, 'garbage instead of HTTP gets a 400 from node:http and the server keeps serving', () => serve( async ( srv ) => {
	const _r = await raw( srv.port, '\u0000\u0001 NOT HTTP AT ALL\r\n\r\n' );
	assert.equal( _r.status, 400 );
	assert.equal( ( await get( srv.port, '/echo/a/b' ) ).status, 200 );
} ) );

attack( S, 'a header line of 64 KB is refused (431) and the server keeps serving', () => serve( async ( srv ) => {
	const _r = await raw( srv.port, `GET /echo/a/b HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat( 65536 )}\r\nConnection: close\r\n\r\n` );
	assert.equal( _r.status, 431 );
	assert.equal( ( await get( srv.port, '/echo/a/b' ) ).status, 200 );
} ) );

// CORS only for the origins named (the operator's page): they may read answers and send the headers that carry a
// secret; any other origin gets no CORS header, and its preflight is refused.
const ORIGIN = 'https://office.example';
const ask = ( srv, method, target, origin ) => raw( srv.port, `${method} ${target} HTTP/1.1\r\nHost: x\r\nOrigin: ${origin}\r\nConnection: close\r\n\r\n` );

attack( S, 'CORS for a named origin: its preflight gets 204 with that origin, the secret headers and no body', () => serve( async ( srv ) => {
	const _r = await ask( srv, 'OPTIONS', '/anything', ORIGIN );
	assert.equal( _r.status, 204 );
	assert.match( _r.head, /Access-Control-Allow-Origin: https:\/\/office\.example/ );
	assert.doesNotMatch( _r.head, /Access-Control-Allow-Origin: \*/ );
	assert.match( _r.head, /Vary: Origin/ );
	assert.match( _r.head, /Access-Control-Allow-Methods: GET, POST, OPTIONS/ );
	assert.match( _r.head, /Access-Control-Allow-Headers: Content-Type, x-operator-pin, x-board-pin, x-core-token/ );
	assert.equal( _r.body, '' );
}, { cors: [ ORIGIN ] } ) );

attack( S, 'CORS for a named origin: its answers and errors (404, 500) carry its allow-origin header', () => serve( async ( srv ) => {
	for ( const target of [ '/echo/a/b', '/missing', '/boom' ] ) {
		assert.match( ( await ask( srv, 'GET', target, ORIGIN ) ).head, /Access-Control-Allow-Origin: https:\/\/office\.example/, target );
	}
}, { cors: [ ORIGIN ], routes: http => http.route( 'GET', '/boom', () => { throw new Error( 'x' ); } ) } ) );

attack( S, 'CORS for another origin: no allow-origin header, and its preflight is refused (403)', () => serve( async ( srv ) => {
	for ( const origin of [ 'https://evil.example', 'https://office.example.evil.example', 'null', 'https://OFFICE.example' ] ) {
		assert.doesNotMatch( ( await ask( srv, 'GET', '/echo/a/b', origin ) ).head, /Access-Control/i, origin );
		assert.equal( ( await ask( srv, 'OPTIONS', '/echo/a/b', origin ) ).status, 403, origin );
	}
	assert.doesNotMatch( ( await get( srv.port, '/echo/a/b' ) ).head, /Access-Control/i, 'no origin at all' );
}, { cors: [ ORIGIN ] } ) );

attack( S, 'CORS given as anything but a list of origins allows no origin', () => serve( async ( srv ) => {
	assert.doesNotMatch( ( await ask( srv, 'GET', '/echo/a/b', ORIGIN ) ).head, /Access-Control/i );
	assert.equal( ( await ask( srv, 'OPTIONS', '/echo/a/b', ORIGIN ) ).status, 403 );
}, { cors: true } ) );

attack( S, 'CORS off: no allow-origin header, and OPTIONS is just not found', () => serve( async ( srv ) => {
	assert.doesNotMatch( ( await get( srv.port, '/echo/a/b' ) ).head, /Access-Control/i );
	assert.equal( ( await raw( srv.port, 'OPTIONS /echo HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n' ) ).status, 404 );
} ) );

attack( S, 'listen( 0 ) gives a real port; close() resolves; close() before listen() resolves too', async () => {
	const _http = new Http();
	await within( _http.close(), 500, 'close before listen' );
	const _port = await _http.listen( 0, '127.0.0.1' );
	assert.ok( _port > 0 );
	await within( _http.close(), 2000, 'close' );
} );

attack( S, 'close() with an idle keep-alive client still resolves', async () => {
	const _http = new Http();
	_http.route( 'GET', '/x', ( { res } ) => Http.json( res, 200, {} ) );
	const _port = await _http.listen( 0, '127.0.0.1' );
	const _client = raw( _port, 'GET /x HTTP/1.1\r\nHost: x\r\n\r\n', { wait: 2000 } );
	await new Promise( resolve => setTimeout( resolve, 50 ) );
	await within( _http.close(), 1500, 'close with an idle connection' );
	await _client;
} );

attack( S, 'close() resolves although an event stream (SSE) is still open', async () => {
	const _http = new Http();
	_http.route( 'GET', '/events', ( { req, res } ) => { Http.events( req, res ); } );
	const _port = await _http.listen( 0, '127.0.0.1' );
	const _client = raw( _port, 'GET /events HTTP/1.1\r\nHost: x\r\n\r\n', { wait: 1500 } );
	await new Promise( resolve => setTimeout( resolve, 50 ) );
	try {
		await within( _http.close(), 500, 'close with an open stream' );
	} finally {
		_http.server.closeAllConnections();
		await _client;
	}
} );

// Hostile methods: anything that is not a route's method is a clean 404 (or node's own 400), never a crash.
attacks( S, [ 'HEAD', 'PATCH', 'TRACE', 'CONNECT', 'PROPFIND', 'get', 'G-ET' ].map( method => ( { name: `method ${method} is answered cleanly`, method } ) ),
	( { method } ) => serve( async ( srv ) => {
		const _r = await raw( srv.port, `${method} /echo/a/b HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n` );
		assert.ok( _r.ended, `${method} left the connection open` );
		assert.ok( [ 0, 400, 404 ].includes( _r.status ), `${method} → ${_r.status}` );
		assert.equal( ( await get( srv.port, '/echo/a/b' ) ).status, 200 );
	} ) );
