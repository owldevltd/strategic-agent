// lib/limits.js under attack: the request limits of the public demo (per caller and in total, in a sliding window)
// and how the caller is read from a request. Clock injected; no real waiting.
import assert from 'node:assert/strict';
import http from 'node:http';
import { attack, attacks, hostile, random } from '../hostile.mjs';
import { agency, distinct, server, raw } from './tools.mjs';

const [ Limits, Http ] = await agency.use( [ 'Lib.Limits', 'Lib.Http' ] );
const S = 'lib/limits.js';

const clocked = ( options = {} ) => {
	const _clock = { now: 0 };
	return { clock: _clock, limits: new Limits( { now: () => _clock.now, ...options } ) };
};
const takes = ( limits, caller, n ) => Array.from( { length: n }, () => limits.take( caller ) );

attack( S, 'per caller: exactly perCaller calls pass, the next one is refused', () => {
	const { limits } = clocked( { perCaller: 5, total: 100, windowMs: 1000 } );
	assert.deepEqual( takes( limits, 'a', 6 ), [ true, true, true, true, true, false ] );
} );

attack( S, 'in total: exactly total calls pass across callers, the next caller is refused', () => {
	const { limits } = clocked( { perCaller: 100, total: 3, windowMs: 1000 } );
	assert.deepEqual( [ 'a', 'b', 'c', 'd' ].map( caller => limits.take( caller ) ), [ true, true, true, false ] );
} );

attack( S, 'a refused call is not counted: the window frees exactly what passed', () => {
	const { clock, limits } = clocked( { perCaller: 2, total: 100, windowMs: 1000 } );
	takes( limits, 'a', 2 );
	clock.now = 500;
	assert.deepEqual( takes( limits, 'a', 50 ), Array( 50 ).fill( false ) );
	clock.now = 1000;
	assert.deepEqual( takes( limits, 'a', 3 ), [ true, true, false ] );
} );

attack( S, 'the window boundary: a call at t is still counted at t + window - 1 and gone at t + window', () => {
	const { clock, limits } = clocked( { perCaller: 1, total: 100, windowMs: 1000 } );
	clock.now = 10000;
	assert.equal( limits.take( 'a' ), true );
	clock.now = 10999;
	assert.equal( limits.take( 'a' ), false );
	clock.now = 11000;
	assert.equal( limits.take( 'a' ), true );
} );

attack( S, 'the window slides: the oldest call frees its slot first', () => {
	const { clock, limits } = clocked( { perCaller: 3, total: 100, windowMs: 1000 } );
	for ( const t of [ 0, 300, 600 ] ) {
		clock.now = t;
		limits.take( 'a' );
	}
	clock.now = 1000;
	assert.deepEqual( takes( limits, 'a', 2 ), [ true, false ] );
	clock.now = 1300;
	assert.deepEqual( takes( limits, 'a', 2 ), [ true, false ] );
} );

attack( S, 'a clock that jumps backwards grants no extra calls', () => {
	const { clock, limits } = clocked( { perCaller: 2, total: 100, windowMs: 1000 } );
	clock.now = 5000;
	takes( limits, 'a', 2 );
	clock.now = 0;
	assert.equal( limits.take( 'a' ), false );
	clock.now = -100000;
	assert.equal( limits.take( 'a' ), false );
} );

attack( S, 'a clock that jumps far forward frees everything at once', () => {
	const { clock, limits } = clocked( { perCaller: 2, total: 3, windowMs: 1000 } );
	takes( limits, 'a', 2 );
	limits.take( 'b' );
	clock.now = 1e12;
	assert.deepEqual( [ ...takes( limits, 'a', 2 ), limits.take( 'b' ) ], [ true, true, true ] );
} );

attack( S, 'callers are independent until the total is reached', () => {
	const { limits } = clocked( { perCaller: 2, total: 100, windowMs: 1000 } );
	takes( limits, 'a', 5 );
	assert.deepEqual( takes( limits, 'b', 3 ), [ true, true, false ] );
} );

attack( S, 'a caller over its own limit does not use up the total for others', () => {
	const { limits } = clocked( { perCaller: 1, total: 3, windowMs: 1000 } );
	takes( limits, 'a', 100 );
	assert.deepEqual( [ limits.take( 'b' ), limits.take( 'c' ), limits.take( 'd' ) ], [ true, true, false ] );
} );

attack( S, 'the defaults: 30 per caller and 300 in total within 10 minutes', () => {
	const _clock = { now: 0 };
	const _limits = new Limits( { now: () => _clock.now } );
	assert.equal( takes( _limits, 'a', 31 ).filter( Boolean ).length, 30 );
	for ( let i = 0; i < 20; i++ ) { takes( _limits, `c${i}`, 30 ); }
	assert.equal( _limits.all.length, 300 );
	_clock.now = 599999;
	assert.equal( _limits.take( 'fresh' ), false );
	_clock.now = 600000;
	assert.equal( _limits.take( 'fresh' ), true );
} );

attack( S, 'with no clock given it uses real time and still limits', () => {
	const _limits = new Limits( { perCaller: 2, total: 10 } );
	assert.deepEqual( takes( _limits, 'a', 3 ), [ true, true, false ] );
} );

attack( S, 'perCaller 0 and total 0 refuse everything', () => {
	assert.equal( clocked( { perCaller: 0 } ).limits.take( 'a' ), false );
	assert.equal( clocked( { total: 0 } ).limits.take( 'a' ), false );
} );

attack( S, 'a limit that is NaN refuses instead of letting everything through', () => {
	const { limits } = clocked( { perCaller: NaN, total: 5 } );
	assert.equal( takes( limits, 'a', 10 ).filter( Boolean ).length, 0 );
} );

attack( S, 'a clock that returns NaN does not lift the limits', () => {
	const _limits = new Limits( { perCaller: 2, total: 5, now: () => NaN } );
	assert.ok( takes( _limits, 'a', 10 ).filter( Boolean ).length <= 2 );
} );

attack( S, 'refused callers are not remembered (memory stays bounded under a flood of new addresses)', () => {
	const { limits } = clocked( { perCaller: 1, total: 10, windowMs: 1000 } );
	for ( let i = 0; i < 20000; i++ ) { limits.take( `198.51.${i >> 8}.${i & 255}` ); }
	assert.ok( limits.calls.size <= 10, `${limits.calls.size} callers kept for 10 accepted calls` );
} );

attack( S, 'callers whose calls have expired are forgotten', () => {
	const { clock, limits } = clocked( { perCaller: 1, total: 1e9, windowMs: 1000 } );
	for ( let i = 0; i < 5000; i++ ) { limits.take( `caller-${i}` ); }
	clock.now = 10000;
	limits.take( 'now' );
	assert.ok( limits.calls.size <= 1, `${limits.calls.size} idle callers still kept` );
} );

attack( S, 'the work of a call stays bounded: the lists it scans never outgrow the limits (20000 calls)', () => {
	const { clock, limits } = clocked( { perCaller: 40, total: 600, windowMs: 600000 } );
	const _start = performance.now();
	for ( let i = 0; i < 20000; i++ ) {
		clock.now = i;
		const _caller = `c${i % 1000}`;
		limits.take( _caller );
		assert.ok( limits.all.length <= 600 );
		assert.ok( ( limits.calls.get( _caller ) || [] ).length <= 40 );
	}
	assert.ok( performance.now() - _start < 10000, 'a hang guard, not a benchmark' );
} );

attack( S, 'spoofed forwarding headers never get past the total limit', () => {
	const { limits } = clocked( { perCaller: 1, total: 30, windowMs: 1000 } );
	const _rnd = random( 21 );
	let _passed = 0;
	for ( let i = 0; i < 2000; i++ ) {
		const _caller = Limits.caller( { headers: { 'x-forwarded-for': `${_rnd.int( 0, 255 )}.${_rnd.int( 0, 255 )}.0.1` }, socket: { remoteAddress: '127.0.0.1' } } );
		if ( limits.take( _caller ) ) { _passed += 1; }
	}
	assert.equal( _passed, 30 );
} );

attack( S, 'a random sequence of calls never exceeds either limit in any window (seeded model check)', () => {
	const _rnd = random( 22 );
	const { clock, limits } = clocked( { perCaller: 3, total: 7, windowMs: 100 } );
	const _accepted = [];
	for ( let i = 0; i < 5000; i++ ) {
		clock.now += _rnd.int( 0, 9 );
		const _caller = `c${_rnd.int( 0, 4 )}`;
		if ( limits.take( _caller ) ) { _accepted.push( { t: clock.now, caller: _caller } ); }
		const _recent = _accepted.filter( item => item.t > clock.now - 100 );
		assert.ok( _recent.length <= 7 );
		assert.ok( _recent.filter( item => item.caller === _caller ).length <= 3 );
	}
	assert.ok( _accepted.length > 100, 'the limits still let calls through' );
} );

attack( S, 'caller(): the last address of x-forwarded-for (the one the proxy saw), trimmed, when the proxy on this machine sends it', () => {
	assert.equal( Limits.caller( { headers: { 'x-forwarded-for': '  203.0.113.7 ,10.0.0.1, 10.0.0.2 ' }, socket: { remoteAddress: '127.0.0.1' } } ), '10.0.0.2' );
	assert.equal( Limits.caller( { headers: { 'x-forwarded-for': '203.0.113.7' }, socket: { remoteAddress: '::ffff:127.0.0.1' } } ), '203.0.113.7' );
} );

attack( S, 'caller(): x-forwarded-for from anyone but the proxy on this machine is ignored', () => {
	assert.equal( Limits.caller( { headers: { 'x-forwarded-for': '203.0.113.7' }, socket: { remoteAddress: '198.51.100.2' } } ), '198.51.100.2' );
	assert.equal( Limits.caller( { headers: { 'x-forwarded-for': '203.0.113.7' } } ), 'unknown' );
} );

attack( S, 'caller(): an IPv6 caller counts by its /64, so one machine cannot rotate through its addresses', () => {
	const _proxied = address => Limits.caller( { headers: { 'x-forwarded-for': address }, socket: { remoteAddress: '127.0.0.1' } } );
	assert.equal( _proxied( '2001:db8::1' ), '2001:db8:0:0::/64' );
	assert.equal( _proxied( '2001:db8:0:0:ffff:1:2:3' ), '2001:db8:0:0::/64' );
	assert.equal( _proxied( '2001:0db8:0000:0001:0000:0000:0000:0001' ), '2001:db8:0:1::/64' );
	assert.equal( Limits.caller( { headers: {}, socket: { remoteAddress: 'fe80::1%eth0' } } ), 'fe80:0:0:0::/64' );
	assert.equal( Limits.caller( { headers: {}, socket: { remoteAddress: '::ffff:192.0.2.4' } } ), '192.0.2.4' );
} );

attack( S, 'caller(): without x-forwarded-for the socket address counts', () => {
	assert.equal( Limits.caller( { headers: {}, socket: { remoteAddress: '192.0.2.4' } } ), '192.0.2.4' );
	assert.equal( Limits.caller( { headers: { 'x-forwarded-for': '' }, socket: { remoteAddress: '192.0.2.4' } } ), '192.0.2.4' );
} );

attack( S, 'caller(): no header and no socket gives "unknown", never a throw', () => {
	assert.equal( Limits.caller( { headers: {} } ), 'unknown' );
	assert.equal( Limits.caller( { headers: {}, socket: {} } ), 'unknown' );
	assert.equal( Limits.caller( { headers: {}, socket: null } ), 'unknown' );
} );

attack( S, 'caller(): blanks around the addresses count for nothing; a header of only commas is one "unknown" caller for everyone', () => {
	const _a = Limits.caller( { headers: { 'x-forwarded-for': ' , 1.2.3.4' }, socket: { remoteAddress: '127.0.0.1' } } );
	const _b = Limits.caller( { headers: { 'x-forwarded-for': ',,,' }, socket: { remoteAddress: '127.0.0.1' } } );
	assert.equal( _a, '1.2.3.4' );
	assert.equal( _b, 'unknown' );
} );

// Over a real socket: what node:http makes of the header (case, duplicates) before caller() reads it.
const seen = async ( headers ) => {
	let _caller;
	const _srv = await server( Http, ( srv ) => {
		srv.route( 'GET', '/who', ( { req, res } ) => {
			_caller = Limits.caller( req );
			Http.json( res, 200, {} );
		} );
	} );
	try {
		await raw( _srv.port, `GET /who HTTP/1.1\r\nHost: x\r\nConnection: close\r\n${headers}\r\n` );
	} finally {
		await _srv.stop();
	}
	return _caller;
};

attack( S, 'over HTTP: the header name is case-insensitive', async () => {
	assert.equal( await seen( 'X-FORWARDED-FOR: 198.51.100.9\r\n' ), '198.51.100.9' );
} );

attack( S, 'over HTTP: two x-forwarded-for headers are joined and the last address (the proxy\'s own) counts', async () => {
	assert.equal( await seen( 'X-Forwarded-For: 198.51.100.1\r\nX-Forwarded-For: 198.51.100.2\r\n' ), '198.51.100.2' );
} );

attack( S, 'over HTTP: without the header the loopback address of the socket counts', async () => {
	assert.equal( await seen( '' ), '127.0.0.1' );
} );

attack( S, 'over HTTP: a request through node:http with an agent gives the same caller as a raw one', async () => {
	let _caller;
	const _srv = await server( Http, ( srv ) => {
		srv.route( 'GET', '/who', ( { req, res } ) => {
			_caller = Limits.caller( req );
			Http.json( res, 200, {} );
		} );
	} );
	try {
		await new Promise( ( resolve, reject ) => {
			http.get( `${_srv.url}/who`, { agent: false, headers: { 'x-forwarded-for': '203.0.113.50' } }, ( res ) => {
				res.resume();
				res.on( 'end', resolve );
			} ).on( 'error', reject );
		} );
	} finally {
		await _srv.stop();
	}
	assert.equal( _caller, '203.0.113.50' );
} );

// Hostile forwarding headers: caller() never throws, yields a clean string, and take() handles it.
const HEADERS = distinct( hostile( 'strings', 'keys' ) ).filter( item => typeof item.value === 'string' );
attacks( S, HEADERS.map( item => ( { ...item, name: `x-forwarded-for ${item.label} gives a clean caller that take() counts` } ) ), ( { value } ) => {
	const _before = Object.getOwnPropertyNames( Object.prototype ).join();
	const _caller = Limits.caller( { headers: { 'x-forwarded-for': value }, socket: { remoteAddress: '192.0.2.1' } } );
	assert.equal( typeof _caller, 'string' );
	assert.equal( _caller, _caller.trim() );
	assert.ok( !_caller.includes( ',' ) );
	const { limits } = clocked( { perCaller: 2, total: 100, windowMs: 1000 } );
	assert.deepEqual( takes( limits, _caller, 3 ), [ true, true, false ] );
	assert.deepEqual( takes( limits, `${_caller}#other`, 1 ), [ true ] );
	assert.equal( Object.getOwnPropertyNames( Object.prototype ).join(), _before );
} );
