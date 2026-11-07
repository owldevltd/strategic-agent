// lib/bus.js under attack: the in-process event bus behind the event log's live subscribers (SSE in the browser).
// A handler must never break the emitter, other handlers or the process.
import assert from 'node:assert/strict';
import { attack, attacks, hostile } from '../hostile.mjs';
import { agency, quiet, distinct, child, lastJson } from './tools.mjs';

const [ Bus ] = await agency.use( [ 'Lib.Bus' ] );
const S = 'lib/bus.js';

attack( S, 'emit hands the very same data object to the handler', () => {
	const _bus = new Bus();
	const _data = { a: 1 };
	let _got;
	_bus.on( 'x', ( data ) => { _got = data; } );
	_bus.emit( 'x', _data );
	assert.equal( _got, _data );
} );

attack( S, 'handlers run in the order they subscribed', () => {
	const _bus = new Bus();
	const _order = [];
	for ( let i = 0; i < 20; i++ ) { _bus.on( 'x', () => _order.push( i ) ); }
	_bus.emit( 'x' );
	assert.deepEqual( _order, Array.from( { length: 20 }, ( _, i ) => i ) );
} );

attack( S, 'the same handler subscribed twice is called once per emit', () => {
	const _bus = new Bus();
	let _calls = 0;
	const _cb = () => { _calls += 1; };
	_bus.on( 'x', _cb );
	_bus.on( 'x', _cb );
	_bus.emit( 'x' );
	assert.equal( _calls, 1 );
} );

attack( S, 'on() returns an unsubscribe function that stops delivery', () => {
	const _bus = new Bus();
	let _calls = 0;
	const _off = _bus.on( 'x', () => { _calls += 1; } );
	_bus.emit( 'x' );
	_off();
	_bus.emit( 'x' );
	assert.equal( _calls, 1 );
} );

attack( S, 'unsubscribing twice, or a handler that was never there, is harmless', () => {
	const _bus = new Bus();
	const _off = _bus.on( 'x', () => {} );
	_off();
	assert.doesNotThrow( () => _off() );
	assert.doesNotThrow( () => _bus.off( 'never', () => {} ) );
	assert.doesNotThrow( () => _bus.off( 'x', () => {} ) );
} );

attack( S, 'emit without any handler does nothing and returns undefined', () => {
	const _bus = new Bus();
	assert.equal( _bus.emit( 'nobody', { a: 1 } ), undefined );
} );

attack( S, 'emit returns undefined even when handlers return values (nothing leaks back to the emitter)', () => {
	const _bus = new Bus();
	_bus.on( 'x', () => 'secret' );
	assert.equal( _bus.emit( 'x' ), undefined );
} );

attack( S, 'a handler of another name is never called', () => {
	const _bus = new Bus();
	let _calls = 0;
	_bus.on( 'a', () => { _calls += 1; } );
	_bus.emit( 'b' );
	_bus.emit( 'A' );
	_bus.emit( 'a ' );
	assert.equal( _calls, 0 );
} );

attack( S, 'a throwing handler: the others still run and app.fail gets that very error once', () => {
	const _bus = new Bus();
	const _quiet = quiet();
	const _error = new Error( 'handler broke' );
	const _seen = [];
	try {
		_bus.on( 'x', () => _seen.push( 1 ) );
		_bus.on( 'x', () => { throw _error; } );
		_bus.on( 'x', () => _seen.push( 3 ) );
		assert.doesNotThrow( () => _bus.emit( 'x' ) );
	} finally {
		_quiet.restore();
	}
	assert.deepEqual( _seen, [ 1, 3 ] );
	assert.deepEqual( _quiet.errors, [ _error ] );
} );

attack( S, 'a handler that throws a string, null or undefined is caught as well', () => {
	const _bus = new Bus();
	const _quiet = quiet();
	try {
		for ( const thrown of [ 'text', null, undefined, 0, { not: 'an error' } ] ) {
			_bus.on( 'x', () => { throw thrown; } );
		}
		let _after = false;
		_bus.on( 'x', () => { _after = true; } );
		assert.doesNotThrow( () => _bus.emit( 'x' ) );
		assert.equal( _after, true );
	} finally {
		_quiet.restore();
	}
	assert.equal( _quiet.errors.length, 5 );
} );

attack( S, 'a handler that throws on every emit does not stop later emits', () => {
	const _bus = new Bus();
	const _quiet = quiet();
	let _good = 0;
	try {
		_bus.on( 'x', () => { throw new Error( 'always' ); } );
		_bus.on( 'x', () => { _good += 1; } );
		for ( let i = 0; i < 1000; i++ ) { _bus.emit( 'x' ); }
	} finally {
		_quiet.restore();
	}
	assert.equal( _good, 1000 );
	assert.equal( _quiet.errors.length, 1000 );
} );

attack( S, 'a handler that is not a function fails at emit without hurting the others', () => {
	const _bus = new Bus();
	const _quiet = quiet();
	let _good = 0;
	try {
		_bus.on( 'x', 5 );
		_bus.on( 'x', () => { _good += 1; } );
		_bus.emit( 'x' );
	} finally {
		_quiet.restore();
	}
	assert.equal( _good, 1 );
	assert.ok( _quiet.errors[ 0 ] instanceof TypeError );
} );

attack( S, 'a handler that unsubscribes itself during emit finishes this emit and gets no later one', () => {
	const _bus = new Bus();
	const _calls = [];
	const _off = _bus.on( 'x', ( n ) => {
		_calls.push( n );
		_off();
	} );
	_bus.on( 'x', n => _calls.push( `b${n}` ) );
	_bus.emit( 'x', 1 );
	_bus.emit( 'x', 2 );
	assert.deepEqual( _calls, [ 1, 'b1', 'b2' ] );
} );

attack( S, 'a handler that re-subscribes itself during emit is called once per emit, not again and again', () => {
	const _bus = new Bus();
	let _calls = 0;
	const _cb = () => {
		_calls += 1;
		if ( _calls < 1000 ) {
			_bus.off( 'x', _cb );
			_bus.on( 'x', _cb );
		}
	};
	_bus.on( 'x', _cb );
	_bus.emit( 'x' );
	assert.equal( _calls, 1, 'without the guard of 1000 this emit never ends' );
} );

attack( S, 'a handler subscribed during an emit does not receive the event that was already being delivered', () => {
	const _bus = new Bus();
	const _late = [];
	_bus.on( 'x', ( n ) => {
		if ( n === 1 ) { _bus.on( 'x', m => _late.push( m ) ); }
	} );
	_bus.emit( 'x', 1 );
	_bus.emit( 'x', 2 );
	assert.deepEqual( _late, [ 2 ], 'it subscribed after event 1 was emitted' );
} );

attack( S, 'a re-entrant emit from a handler is delivered completely before the outer one continues', () => {
	const _bus = new Bus();
	const _seen = [];
	_bus.on( 'x', ( n ) => {
		_seen.push( `a${n}` );
		if ( n === 1 ) { _bus.emit( 'x', 2 ); }
	} );
	_bus.on( 'x', n => _seen.push( `b${n}` ) );
	_bus.emit( 'x', 1 );
	assert.deepEqual( _seen, [ 'a1', 'a2', 'b2', 'b1' ] );
} );

attack( S, 'a re-entrant emit 2000 levels deep ends (a stack overflow in a handler is caught, not fatal)', () => {
	const _bus = new Bus();
	const _quiet = quiet();
	let _depth = 0;
	try {
		_bus.on( 'x', ( n ) => {
			_depth = Math.max( _depth, n );
			if ( n < 2000 ) { _bus.emit( 'x', n + 1 ); }
		} );
		assert.doesNotThrow( () => _bus.emit( 'x', 1 ) );
	} finally {
		_quiet.restore();
	}
	assert.ok( _depth > 100 );
} );

attack( S, 'an async handler that rejects is reported to app.fail, never an unhandled rejection', () => {
	const _result = child( `
		import { boot } from './lib/node.mjs';
		const app = boot( { overrides: '' } );
		const [ Bus ] = await app.use( [ 'Lib.Bus' ] );
		const failed = [];
		app.fail = error => failed.push( String( error?.message ) );
		let unhandled = 0;
		process.on( 'unhandledRejection', () => { unhandled += 1; } );
		const bus = new Bus();
		bus.on( 'x', async () => { throw new Error( 'async handler broke' ); } );
		bus.emit( 'x' );
		await new Promise( resolve => setTimeout( resolve, 20 ) );
		console.log( JSON.stringify( { failed, unhandled } ) );
	` );
	const _out = lastJson( _result.stdout );
	assert.equal( _out.unhandled, 0, 'a rejection nobody handles crashes a Node process by default' );
	assert.deepEqual( _out.failed, [ 'async handler broke' ] );
} );

attack( S, '10000 handlers on one name are each called exactly once, quickly', () => {
	const _bus = new Bus();
	const _counts = new Uint8Array( 10000 );
	for ( let i = 0; i < 10000; i++ ) { _bus.on( 'x', () => { _counts[ i ] += 1; } ); }
	const _start = performance.now();
	_bus.emit( 'x' );
	assert.ok( performance.now() - _start < 2000 );
	assert.ok( _counts.every( count => count === 1 ) );
} );

attack( S, 'subscribing and unsubscribing 10000 different names leaves nothing behind', () => {
	const _bus = new Bus();
	for ( let i = 0; i < 10000; i++ ) { _bus.on( `name-${i}`, () => {} )(); }
	assert.equal( _bus._handlers.size, 0, 'an empty set per name stays forever' );
} );

attack( S, 'two buses are independent', () => {
	const _a = new Bus();
	const _b = new Bus();
	let _calls = 0;
	_a.on( 'x', () => { _calls += 1; } );
	_b.emit( 'x' );
	assert.equal( _calls, 0 );
} );

attack( S, 'the unsubscribe of one bus does not touch the same handler on another bus', () => {
	const _a = new Bus();
	const _b = new Bus();
	let _calls = 0;
	const _cb = () => { _calls += 1; };
	const _offA = _a.on( 'x', _cb );
	_b.on( 'x', _cb );
	_offA();
	_b.emit( 'x' );
	assert.equal( _calls, 1 );
} );

attack( S, 'off() for one name keeps the same handler on another name', () => {
	const _bus = new Bus();
	const _seen = [];
	const _cb = data => _seen.push( data );
	_bus.on( 'a', _cb );
	_bus.on( 'b', _cb );
	_bus.off( 'a', _cb );
	_bus.emit( 'a', 1 );
	_bus.emit( 'b', 2 );
	assert.deepEqual( _seen, [ 2 ] );
} );

attack( S, 'the handler gets exactly one argument (the data), never the name or the bus', () => {
	const _bus = new Bus();
	let _args;
	_bus.on( 'x', ( ...args ) => { _args = args; } );
	_bus.emit( 'x', 'data', 'ignored' );
	assert.deepEqual( _args, [ 'data' ] );
	_bus.emit( 'x' );
	assert.deepEqual( _args, [ undefined ] );
} );

attack( S, 'a handler that mutates the data changes what later handlers see (one shared object, documented)', () => {
	const _bus = new Bus();
	const _data = { n: 1 };
	let _seen;
	_bus.on( 'x', ( data ) => { data.n = 2; } );
	_bus.on( 'x', ( data ) => { _seen = data.n; } );
	_bus.emit( 'x', _data );
	assert.equal( _seen, 2 );
} );

attack( S, 'unsubscribing one of two handlers during emit lets the remaining one finish normally', () => {
	const _bus = new Bus();
	const _seen = [];
	const _later = { off: null };
	_bus.on( 'x', ( n ) => {
		_seen.push( `a${n}` );
		if ( n === 2 ) { _later.off(); }
	} );
	_later.off = _bus.on( 'x', n => _seen.push( `b${n}` ) );
	_bus.emit( 'x', 1 );
	_bus.emit( 'x', 2 );
	_bus.emit( 'x', 3 );
	assert.deepEqual( _seen.filter( item => item.startsWith( 'a' ) ), [ 'a1', 'a2', 'a3' ] );
	assert.ok( !_seen.includes( 'b3' ) );
} );

attack( S, 'a handler that throws while app.fail itself throws: the emitter sees that error, nothing is swallowed silently', () => {
	const _bus = new Bus();
	const _original = agency.fail;
	agency.fail = () => { throw new Error( 'fail broke' ); };
	try {
		_bus.on( 'x', () => { throw new Error( 'handler broke' ); } );
		assert.throws( () => _bus.emit( 'x' ), /fail broke/ );
	} finally {
		agency.fail = _original;
	}
} );

// Hostile event names: each one is its own channel, and none touches a prototype.
const NAMES = distinct( hostile( 'keys', 'strings', 'numbers', 'types' ) );
attacks( S, NAMES.map( item => ( { ...item, name: `event name ${item.label} delivers to its own handlers only` } ) ), ( { value } ) => {
	const _bus = new Bus();
	const _before = Object.getOwnPropertyNames( Object.prototype ).join();
	const _seen = [];
	_bus.on( value, data => _seen.push( data ) );
	_bus.on( 'other', () => _seen.push( 'wrong' ) );
	_bus.emit( value, value );
	_bus.emit( `${String( typeof value === 'symbol' ? 'sym' : value )}-not` );
	assert.equal( _seen.length, 1 );
	assert.ok( Object.is( _seen[ 0 ], value ) );
	assert.equal( Object.getOwnPropertyNames( Object.prototype ).join(), _before );
	assert.equal( {}.polluted, undefined );
} );
