// lib/http.js under attack, part 3: the client the core uses to call the gate (Http.request: A2 timeouts, O3 no
// silent repetitions) and the server-sent events of the live log (Http.events). Fake timers for the 15 s ping.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';
import { attack, attacks, within } from '../hostile.mjs';
import { agency, plain, server, raw } from './tools.mjs';

const [ Http ] = await agency.use( [ 'Lib.Http' ] );
const S = 'lib/http.js';

// A plain server that answers every request with handler( req, res, body ); fn( srv ) runs the attack.
async function remote( handler, fn ) {
	const _srv = await plain( ( req, res, hits ) => {
		const _chunks = [];
		req.on( 'data', chunk => _chunks.push( chunk ) );
		req.on( 'end', () => handler( req, res, Buffer.concat( _chunks ).toString( 'utf8' ), hits ) );
	} );
	try {
		return await fn( _srv );
	} finally {
		await _srv.stop();
	}
}
const answer = ( res, status, text, type = 'application/json' ) => {
	res.writeHead( status, { 'Content-Type': type } );
	res.end( text );
};

attack( S, 'request(): status and parsed JSON come back; the body goes out as JSON', () => remote( ( req, res, body ) => {
	answer( res, 201, JSON.stringify( { method: req.method, type: req.headers[ 'content-type' ], got: JSON.parse( body ) } ) );
}, async ( srv ) => {
	const { status, data } = await Http.request( 'POST', `${srv.url}/x`, { a: [ 1, 'ü' ] } );
	assert.equal( status, 201 );
	assert.deepEqual( data, { method: 'POST', type: 'application/json', got: { a: [ 1, 'ü' ] } } );
} ) );

attack( S, 'request(): no body argument sends no body; null sends the JSON null', () => remote( ( req, res, body ) => {
	answer( res, 200, JSON.stringify( { body } ) );
}, async ( srv ) => {
	assert.equal( ( await Http.request( 'POST', srv.url ) ).data.body, '' );
	assert.equal( ( await Http.request( 'POST', srv.url, null ) ).data.body, 'null' );
} ) );

attack( S, 'request(): error statuses come back as values, not as throws', () => remote( ( req, res ) => {
	answer( res, Number( req.url.slice( 1 ) ), JSON.stringify( { error: 'nope' } ) );
}, async ( srv ) => {
	for ( const status of [ 400, 403, 404, 409, 422, 429, 500, 503 ] ) {
		assert.deepEqual( await Http.request( 'GET', `${srv.url}/${status}` ), { status, data: { error: 'nope' } } );
	}
} ) );

attack( S, 'request(): an answer that is not JSON gives {} with the real status (documented)', () => remote( ( req, res ) => {
	answer( res, 502, '<html>Bad Gateway</html>', 'text/html' );
}, async ( srv ) => {
	assert.deepEqual( await Http.request( 'GET', srv.url ), { status: 502, data: {} } );
} ) );

attack( S, 'request(): an empty 204 answer gives {}', () => remote( ( req, res ) => {
	res.writeHead( 204 );
	res.end();
}, async ( srv ) => {
	assert.deepEqual( await Http.request( 'POST', srv.url, {} ), { status: 204, data: {} } );
} ) );

attack( S, 'request(): a __proto__ key in the answer stays an own key and pollutes nothing', () => remote( ( req, res ) => {
	answer( res, 200, '{"__proto__":{"polluted":true},"ok":1}' );
}, async ( srv ) => {
	const { data } = await Http.request( 'GET', srv.url );
	assert.equal( data.ok, 1 );
	assert.equal( {}.polluted, undefined );
} ) );

attack( S, 'request(): a 5 MB JSON answer is read whole', () => remote( ( req, res ) => {
	answer( res, 200, JSON.stringify( { text: 'x'.repeat( 5 * 1024 * 1024 ) } ) );
}, async ( srv ) => {
	assert.equal( ( await Http.request( 'GET', srv.url ) ).data.text.length, 5 * 1024 * 1024 );
} ) );

attack( S, 'request(): A2, a server that never answers is cut off after timeoutMs', () => remote( () => {}, async ( srv ) => {
	const _start = performance.now();
	await assert.rejects( within( Http.request( 'GET', srv.url, undefined, { timeoutMs: 100 } ), 2000, 'a request with a 100 ms timeout' ),
		error => error.name === 'TimeoutError' );
	assert.ok( performance.now() - _start < 3000 );
} ) );

attack( S, 'request(): A2, an answer whose body stalls is a failure, not a success with empty data', () => remote( ( req, res ) => {
	res.writeHead( 200, { 'Content-Type': 'application/json' } );
	res.write( '{"status":"exe' );
}, async ( srv ) => {
	await assert.rejects( within( Http.request( 'POST', srv.url, {}, { timeoutMs: 100 } ), 2000 ), 'a cut answer must not read as 200 {}' );
} ) );

attack( S, 'request(): A2, the default timeout is shorter than the shortest lease (2 minutes)', async () => {
	const _original = AbortSignal.timeout;
	let _ms;
	AbortSignal.timeout = ( ms ) => {
		_ms = ms;
		return _original.call( AbortSignal, ms );
	};
	try {
		await Http.request( 'GET', 'http://127.0.0.1:9/' ).catch( () => null );
	} finally {
		AbortSignal.timeout = _original;
	}
	assert.ok( _ms > 0 && _ms < 120000, `default ${_ms} ms` );
} );

attack( S, 'request(): O3, a 500 is not repeated', () => remote( ( req, res ) => {
	answer( res, 500, '{"error":"down"}' );
}, async ( srv ) => {
	assert.equal( ( await Http.request( 'POST', srv.url, { pay: 1 } ) ).status, 500 );
	await new Promise( resolve => setTimeout( resolve, 50 ) );
	assert.equal( srv.hits(), 1 );
} ) );

attack( S, 'request(): O3, a connection the server drops is not repeated', () => remote( ( req ) => {
	req.socket.destroy();
}, async ( srv ) => {
	await assert.rejects( Http.request( 'POST', srv.url, { pay: 1 } ) );
	await new Promise( resolve => setTimeout( resolve, 50 ) );
	assert.equal( srv.hits(), 1 );
} ) );

attack( S, 'request(): O3, a request cut by its timeout is not repeated', () => remote( () => {}, async ( srv ) => {
	await assert.rejects( Http.request( 'POST', srv.url, { pay: 1 }, { timeoutMs: 50 } ) );
	await new Promise( resolve => setTimeout( resolve, 100 ) );
	assert.equal( srv.hits(), 1 );
} ) );

attack( S, 'request(): a refused connection fails at once instead of hanging', async () => {
	const _srv = await plain( () => {} );
	const _url = _srv.url;
	await _srv.stop();
	await assert.rejects( within( Http.request( 'GET', _url, undefined, { timeoutMs: 5000 } ), 2000 ), TypeError );
} );

attack( S, 'request(): a body that cannot be serialized fails before anything is sent', () => remote( ( req, res ) => {
	answer( res, 200, '{}' );
}, async ( srv ) => {
	const _cycle = {};
	_cycle.self = _cycle;
	await assert.rejects( Http.request( 'POST', srv.url, { amount: 10n } ), TypeError );
	await assert.rejects( Http.request( 'POST', srv.url, _cycle ), TypeError );
	assert.equal( srv.hits(), 0 );
} ) );

attack( S, 'request(): a nonsense timeout (NaN, -1, Infinity) fails before anything is sent', () => remote( ( req, res ) => {
	answer( res, 200, '{}' );
}, async ( srv ) => {
	for ( const timeoutMs of [ NaN, -1, Infinity, 2 ** 64 ] ) {
		await assert.rejects( Http.request( 'POST', srv.url, {}, { timeoutMs } ), String( timeoutMs ) );
	}
	assert.equal( srv.hits(), 0 );
} ) );

attack( S, 'request(): an invalid URL is refused with a TypeError', async () => {
	for ( const url of [ 'not a url', '', 'http://', '//127.0.0.1/x', 'ftp://127.0.0.1/' ] ) {
		await assert.rejects( Http.request( 'GET', url, undefined, { timeoutMs: 1000 } ), TypeError, url );
	}
} );

attack( S, 'request(): a URL with credentials is refused without the password in the message', async () => {
	await assert.rejects( Http.request( 'GET', 'http://operator:hunter2-secret@127.0.0.1:9/' ), ( error ) => {
		assert.ok( !String( error.message ).includes( 'hunter2-secret' ), error.message );
		return true;
	} );
} );

attack( S, 'request(): a redirect is not followed to wherever it points', async () => {
	const _target = await plain( ( req, res ) => answer( res, 200, '{}' ) );
	const _redirect = await plain( ( req, res ) => {
		res.writeHead( 307, { Location: `${_target.url}/elsewhere` } );
		res.end();
	} );
	try {
		await assert.rejects( Http.request( 'POST', _redirect.url, { pay: 1 } ) );
		assert.equal( _target.hits(), 0 );
	} finally {
		await _redirect.stop();
		await _target.stop();
	}
} );

attacks( S, [
	{ name: 'request(): A8, a 200 whose body is not JSON is an error, not {}', status: 200, text: 'OK' },
	{ name: 'request(): A8, a 200 whose body is empty is an error, not {}', status: 200, text: '' },
	{ name: 'request(): A8, a 201 whose JSON is cut off is an error, not {}', status: 201, text: '{"status":"exe' },
], ( { status, text } ) => remote( ( req, res ) => answer( res, status, text ), async ( srv ) => {
	await assert.rejects( Http.request( 'POST', srv.url, {} ), new RegExp( `${status}` ) );
} ) );

attack( S, 'request(): 100 parallel calls all come back with their own answer', () => remote( ( req, res ) => {
	answer( res, 200, JSON.stringify( { path: req.url } ) );
}, async ( srv ) => {
	const _all = await within( Promise.all( Array.from( { length: 100 }, ( _, i ) => Http.request( 'GET', `${srv.url}/${i}` ) ) ), 5000 );
	assert.ok( _all.every( ( result, i ) => result.data.path === `/${i}` ) );
} ) );

// A fake request/response pair for Http.events, so the ping can run on fake timers.
const fakes = () => {
	const _req = new EventEmitter();
	const _res = new EventEmitter();
	_res.head = null;
	_res.writes = [];
	_res.writeHead = ( status, headers ) => { _res.head = { status, headers }; };
	_res.write = ( text ) => { _res.writes.push( text ); return true; };
	return { req: _req, res: _res };
};
const withTimers = async ( fn ) => {
	mock.timers.enable( { apis: [ 'setInterval' ] } );
	try {
		return await fn();
	} finally {
		mock.timers.reset();
	}
};

attack( S, 'events(): event-stream head, no caching, and a comment line first', () => withTimers( () => {
	const { req, res } = fakes();
	Http.events( req, res );
	assert.equal( res.head.status, 200 );
	assert.equal( res.head.headers[ 'Content-Type' ], 'text/event-stream' );
	assert.equal( res.head.headers[ 'Cache-Control' ], 'no-store' );
	assert.deepEqual( res.writes, [ ':\n\n' ] );
	req.emit( 'close' );
} ) );

attack( S, 'events(): send writes one id line and one data line per event', () => withTimers( () => {
	const { req, res } = fakes();
	const _stream = Http.events( req, res );
	_stream.send( { id: 7, kind: 'k', data: { a: 1 } } );
	assert.equal( res.writes[ 1 ], 'id: 7\ndata: {"id":7,"kind":"k","data":{"a":1}}\n\n' );
	req.emit( 'close' );
} ) );

attack( S, 'events(): line breaks inside the data never start a new field', () => withTimers( () => {
	const { req, res } = fakes();
	const _stream = Http.events( req, res );
	_stream.send( { id: 1, text: 'a\nid: 99\ndata: forged\r\n\r\nevent: x\rretry: 1\u2028\u2029' } );
	const _lines = res.writes[ 1 ].split( /\r\n|\r|\n/ ).filter( Boolean );
	assert.equal( _lines.length, 2 );
	assert.ok( _lines[ 0 ].startsWith( 'id: ' ) && _lines[ 1 ].startsWith( 'data: ' ) );
	req.emit( 'close' );
} ) );

attack( S, 'events(): an id with a line break cannot inject fields or events', () => withTimers( () => {
	const { req, res } = fakes();
	const _stream = Http.events( req, res );
	_stream.send( { id: '1\ndata: {"forged":true}\n\nid: 2', ok: true } );
	const _lines = res.writes[ 1 ].split( /\r\n|\r|\n/ ).filter( Boolean );
	assert.equal( _lines.length, 2, res.writes[ 1 ] );
	req.emit( 'close' );
} ) );

attack( S, 'events(): an event without id writes no id line (an empty one would reset the browser\'s last id)', () => withTimers( () => {
	const { req, res } = fakes();
	Http.events( req, res ).send( { kind: 'k' } );
	assert.equal( res.writes[ 1 ], 'data: {"kind":"k"}\n\n' );
	req.emit( 'close' );
} ) );

attack( S, 'events(): data that cannot be serialized throws before anything is written', () => withTimers( () => {
	const { req, res } = fakes();
	const _stream = Http.events( req, res );
	assert.throws( () => _stream.send( { id: 1, amount: 1n } ), TypeError );
	assert.deepEqual( res.writes, [ ':\n\n' ] );
	req.emit( 'close' );
} ) );

attack( S, 'events(): a ping every 15 s keeps the stream open, and it stops once the client is gone', () => withTimers( async () => {
	const { req, res } = fakes();
	const _stream = Http.events( req, res );
	mock.timers.tick( 15000 );
	mock.timers.tick( 15000 );
	assert.equal( res.writes.length, 3 );
	req.emit( 'close' );
	await _stream.closed;
	await null;
	mock.timers.tick( 60000 );
	assert.equal( res.writes.length, 3 );
} ) );

attack( S, 'events(): a stream opened after the request body was read still notices when the client leaves', () => withTimers( async () => {
	const { req, res } = fakes();
	req.emit( 'end' );
	req.emit( 'close' );
	const _stream = Http.events( req, res );
	res.emit( 'close' );
	await assert.doesNotReject( within( _stream.closed, 200, 'closed' ) );
	mock.timers.tick( 60000 );
	assert.equal( res.writes.length, 1, 'the ping keeps writing to a dead response' );
} ) );

attack( S, 'events() over HTTP: 1000 events arrive in order and closed resolves when the client goes', async () => {
	let _stream;
	const _srv = await server( Http, http => http.route( 'GET', '/events', ( { req, res } ) => {
		_stream = Http.events( req, res );
		for ( let i = 1; i <= 1000; i++ ) { _stream.send( { id: i } ); }
	} ) );
	try {
		const _r = await raw( _srv.port, 'GET /events HTTP/1.1\r\nHost: x\r\n\r\n', { wait: 300 } );
		const _ids = [ ..._r.body.matchAll( /^id: (\d+)$/gm ) ].map( match => Number( match[ 1 ] ) );
		assert.deepEqual( _ids, Array.from( { length: 1000 }, ( _, i ) => i + 1 ) );
		await within( _stream.closed, 1000, 'closed after the client left' );
		assert.doesNotThrow( () => _stream.send( { id: 1001 } ), 'a late event must not throw' );
	} finally {
		await _srv.stop();
	}
} );

// Methods the client may be asked to use: all reach the server as that method.
attacks( S, [ 'GET', 'POST', 'PUT', 'DELETE', 'PATCH' ].map( method => ( { name: `request() with ${method} arrives as ${method}`, method } ) ),
	( { method } ) => remote( ( req, res ) => answer( res, 200, JSON.stringify( { method: req.method } ) ), async ( srv ) => {
		const _body = [ 'GET' ].includes( method ) ? undefined : { a: 1 };
		assert.equal( ( await Http.request( method, srv.url, _body ) ).data.method, method );
	} ) );
