// Core.Main as a process: what it opens, what it refuses to start with (7.1), the limits of a public demo, and the
// read-only part of its API. A real gate and a real core talk over HTTP on 127.0.0.1, each with its own storage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attack, attacks, within } from '../hostile.mjs';
import { CoreMain, deployment, configFor, tempRoot, withEnv, json } from './processes.mjs';

const SUBJECT = 'core/main.js';
const request = ( ip = '10.0.0.1', forwarded = null ) => ( { headers: forwarded ? { 'x-forwarded-for': forwarded } : {}, socket: { remoteAddress: ip } } );
const make = ( env = {}, core = {} ) => withEnv( env, () => {
	const _root = tempRoot( 'stress-main-' );
	return { main: new CoreMain( configFor( _root, core ) ), root: _root };
} );

attack( SUBJECT, 'constructor: the core keeps its own database in its storage folder, its log speaks as "core"', async () => {
	const { main, root } = await make();
	assert.ok( fs.existsSync( path.join( root, 'core.db' ) ) );
	assert.equal( main.log.source, 'core' );
	assert.equal( main.demo, false );
	fs.rmSync( root, { recursive: true, force: true } );
} );

attacks( SUBJECT, [ 'true', 'yes', '0', '', ' 1', '1 ' ].map( value => ( {
	name: `constructor: PUBLIC_DEMO=${JSON.stringify( value )} is not the public demo; only "1" is`, value,
} ) ), async ( { value } ) => {
	const { main, root } = await make( { PUBLIC_DEMO: value } );
	assert.equal( main.demo, false );
	assert.equal( main._limited( request() ), null );
	fs.rmSync( root, { recursive: true, force: true } );
} );

attack( SUBJECT, 'limits: outside the demo no caller is ever limited', async () => {
	const { main, root } = await make();
	for ( let i = 0; i < 1000; i++ ) {
		assert.equal( main._limited( request(), i % 2 ? 'calls' : 'starts' ), null );
	}
	fs.rmSync( root, { recursive: true, force: true } );
} );

attack( SUBJECT, 'limits: in the demo one caller gets 40 calls, the 41st is refused, another caller still gets through', async () => {
	const { main, root } = await make( { PUBLIC_DEMO: '1' } );
	for ( let i = 0; i < 40; i++ ) { assert.equal( main._limited( request( '10.0.0.1' ) ), null ); }
	assert.match( main._limited( request( '10.0.0.1' ) ), /too many requests; this is a public demo/ );
	assert.equal( main._limited( request( '10.0.0.2' ) ), null );
	fs.rmSync( root, { recursive: true, force: true } );
} );

attack( SUBJECT, 'limits: in the demo one caller may start four runs an hour', async () => {
	const { main, root } = await make( { PUBLIC_DEMO: '1' } );
	for ( let i = 0; i < 4; i++ ) { assert.equal( main._limited( request(), 'starts' ), null ); }
	assert.notEqual( main._limited( request(), 'starts' ), null );
	assert.equal( main._limited( request(), 'calls' ), null, 'starts and calls are counted apart' );
	fs.rmSync( root, { recursive: true, force: true } );
} );

attack( SUBJECT, 'limits: inventing a new X-Forwarded-For for every call still hits the total of 600', async () => {
	const { main, root } = await make( { PUBLIC_DEMO: '1' } );
	let _allowed = 0;
	for ( let i = 0; i < 700; i++ ) {
		if ( main._limited( request( '10.0.0.1', `203.0.113.${i % 250}, 10.${i}.0.1` ) ) === null ) { _allowed++; }
	}
	assert.ok( _allowed <= 600, `${_allowed} calls went through` );
	fs.rmSync( root, { recursive: true, force: true } );
} );

attack( SUBJECT, 'limits: the 31st start in the demo is refused for everybody', async () => {
	const { main, root } = await make( { PUBLIC_DEMO: '1' } );
	let _allowed = 0;
	for ( let i = 0; i < 40; i++ ) {
		if ( main._limited( request( `10.1.0.${i}` ), 'starts' ) === null ) { _allowed++; }
	}
	assert.equal( _allowed, 30 );
	fs.rmSync( root, { recursive: true, force: true } );
} );

attack( SUBJECT, 'start: the core listens, logs its start with the sandbox and the model it uses, and stops again', async () => {
	const d = await deployment();
	const _started = d.main.log.since( 0, 1e9 ).find( event => event.kind === 'core_started' );
	assert.deepEqual( _started.data, { port: d.port, runtime: 'process', isolated: false, provider: 'stub', boardPin: false, inbound: false, demo: true } );
	assert.equal( ( await d.call( 'GET', '/api/nodes' ) ).status, 200 );
	await d.stop();
	await assert.rejects( fetch( `${d.base}/api/nodes` ), 'after stop() nothing answers' );
} );

attack( SUBJECT, 'start: a public demo with the development sandbox refuses to start and never listens (7.1)', async () => {
	await withEnv( { PUBLIC_DEMO: '1' }, async () => {
		const _root = tempRoot( 'stress-main-' );
		const _main = new CoreMain( configFor( _root, { runtime: 'process' } ) );
		await assert.rejects( _main.start(), /PUBLIC_DEMO=1 needs an isolated sandbox runtime/ );
		assert.equal( _main.http.server, null, 'no port was opened' );
		assert.ok( !_main.log.since( 0, 1e9 ).some( event => event.kind === 'core_started' ) );
		fs.rmSync( _root, { recursive: true, force: true } );
	} );
} );

attack( SUBJECT, 'start: a public demo with the container sandbox starts and says it is isolated', async () => {
	const d = await deployment( { env: { PUBLIC_DEMO: '1' }, core: { runtime: 'docker' } } );
	const { body } = await json( await d.call( 'GET', '/api/config' ) );
	await d.stop();
	assert.equal( body.isolated, true );
	assert.equal( body.runtime, 'docker' );
} );

attack( SUBJECT, 'start: a misspelled container runtime in a public demo is refused, not run without isolation', async () => {
	await withEnv( { PUBLIC_DEMO: '1' }, async () => {
		const _root = tempRoot( 'stress-main-' );
		const _main = new CoreMain( configFor( _root, { runtime: 'Docker' } ) );
		await assert.rejects( _main.start(), /isolated/ );
		fs.rmSync( _root, { recursive: true, force: true } );
	} );
} );

attack( SUBJECT, 'start: a second core on the same storage reads the log the first one wrote', async () => {
	const _root = tempRoot( 'stress-main-' );
	const _first = new CoreMain( configFor( _root ) );
	await _first.start();
	await _first.stop();
	const _second = new CoreMain( configFor( _root ) );
	await _second.start();
	const _kinds = _second.log.since( 0, 1e9 ).filter( event => event.kind === 'core_started' );
	await _second.stop();
	fs.rmSync( _root, { recursive: true, force: true } );
	assert.equal( _kinds.length, 2 );
} );

attack( SUBJECT, 'stop: stopping a core that never listened resolves', async () => {
	const { main, root } = await make();
	await within( main.stop(), 1000 );
	fs.rmSync( root, { recursive: true, force: true } );
} );

attack( SUBJECT, 'GET /: sends the visitor to the office', async () => {
	const d = await deployment();
	const _response = await d.call( 'GET', '/', undefined );
	const _redirect = await fetch( `${d.base}/`, { redirect: 'manual' } );
	await d.stop();
	assert.equal( _response.status, 200, 'the office page is served' );
	assert.equal( _redirect.status, 302 );
	assert.equal( _redirect.headers.get( 'location' ), '/ui/office/' );
} );

attack( SUBJECT, 'GET /api/config: the gate address and the sandbox, never a key', async () => {
	const d = await deployment( { core: { apiKey: 'sk-very-secret-key', model: 'glm-test' } } );
	const _plain = await json( await d.call( 'GET', '/api/config' ) );
	const _public = await withEnv( { GATE_PUBLIC_URL: 'https://example.test/gate' }, async () => json( await d.call( 'GET', '/api/config' ) ) );
	await d.stop();
	assert.equal( _plain.body.gateUrl, d.gateBase );
	assert.equal( _public.body.gateUrl, 'https://example.test/gate' );
	assert.equal( _plain.body.provider, 'glm-test' );
	assert.ok( !JSON.stringify( _plain.body ).includes( 'sk-very-secret-key' ) );
} );

attack( SUBJECT, 'GET /api/health: says whether the gate answers', async () => {
	const d = await deployment();
	const _up = await json( await d.call( 'GET', '/api/health' ) );
	await d.gate.stop();
	const _down = await json( await d.call( 'GET', '/api/health' ) );
	await d.stop();
	assert.deepEqual( [ _up.status, _up.body.ok, _up.body.gate ], [ 200, true, true ] );
	assert.deepEqual( [ _down.status, _down.body.ok, _down.body.gate ], [ 200, true, false ] );
} );

attack( SUBJECT, 'GET /api/missions: the demo missions in their order, without data, answers or master data', async () => {
	const d = await deployment();
	const { body } = await json( await d.call( 'GET', '/api/missions' ) );
	await d.stop();
	assert.deepEqual( body.map( item => item.id ), [ 'survey', 'invoices' ] );
	const _text = JSON.stringify( body );
	for ( const secret of [ 'DE02120300000000202051', 'most likely Anna', 'masterData', '"stub"', 'counter' ] ) {
		assert.ok( !_text.includes( secret ), `${secret} is not shown` );
	}
} );

attack( SUBJECT, 'GET /api/log: events after an id, at most a page of them', async () => {
	const d = await deployment();
	d.main.db.transaction( () => {
		for ( let i = 0; i < 1100; i++ ) { d.main.log.append( 'test_event', { i } ); }
	} );
	const _all = await json( await d.call( 'GET', '/api/log' ) );
	const _later = await json( await d.call( 'GET', `/api/log?since=${_all.body.at( -1 ).id}` ) );
	await d.stop();
	assert.equal( _all.body.length, 1000 );
	assert.ok( _later.body.length > 0 && _later.body.every( event => event.id > _all.body.at( -1 ).id ) );
} );

attacks( SUBJECT, [ 'abc', '-5', '1e309', '%00', '' ].map( value => ( { name: `GET /api/log?since=${value}: a broken position answers, never crashes the core`, value } ) ),
	async ( { value } ) => {
		const d = await deployment();
		const _response = await d.call( 'GET', `/api/log?since=${value}` );
		const _after = await d.call( 'GET', '/api/nodes' );
		await d.stop();
		assert.ok( [ 200, 400 ].includes( _response.status ), `status ${_response.status}` );
		assert.equal( _after.status, 200, 'the core still answers' );
	} );

attack( SUBJECT, 'GET /api/events: the log streams as server-sent events, old ones first, new ones as they come', async () => {
	const d = await deployment();
	const _controller = new AbortController();
	const _response = await fetch( `${d.base}/api/events?since=0`, { signal: _controller.signal } );
	const _reader = _response.body.getReader();
	d.main.log.append( 'live_event', { n: 1 } );
	let _text = '';
	for ( let i = 0; i < 50 && !_text.includes( 'live_event' ); i++ ) {
		const { value } = await within( _reader.read(), 2000 );
		_text += Buffer.from( value ).toString( 'utf8' );
	}
	_controller.abort();
	await d.stop();
	assert.equal( _response.headers.get( 'content-type' ), 'text/event-stream' );
	assert.ok( _text.indexOf( 'core_started' ) < _text.indexOf( 'live_event' ) );
} );

attack( SUBJECT, 'GET /api/events: a client that leaves takes its subscription with it', async () => {
	const d = await deployment();
	const _count = () => d.main.log._bus._handlers.get( 'event' )?.size ?? 0;
	const _before = _count();
	const _controller = new AbortController();
	const _response = await fetch( `${d.base}/api/events`, { signal: _controller.signal } );
	await within( _response.body.getReader().read(), 2000 );
	const _during = _count();
	_controller.abort();
	for ( let i = 0; i < 100 && _count() > _before; i++ ) { await new Promise( resolve => setTimeout( resolve, 5 ) ); }
	const _after = _count();
	await d.stop();
	assert.equal( _during, _before + 1 );
	assert.equal( _after, _before );
} );

attacks( SUBJECT, [
	{ name: 'static: the office page is served', url: '/ui/office/', status: 200 },
	{ name: 'static: the shared class files are served', url: '/lib/app.js', status: 200 },
	{ name: 'static: a dot-dot path cannot leave the served folder', url: '/ui/../package.json', status: 404 },
	{ name: 'static: an encoded dot-dot cannot leave the served folder', url: '/lib/%2e%2e/package.json', status: 404 },
	{ name: 'static: an encoded slash cannot leave the served folder', url: '/ui/..%2fpackage.json', status: 404 },
	{ name: 'static: the core\'s code is not served', url: '/core/main.js', status: 404 },
	{ name: 'static: an unknown route is a JSON 404', url: '/api/nothing-here', status: 404 },
], async ( { url, status } ) => {
	const d = await deployment();
	const _response = await fetch( `${d.base}${url}` );
	const _body = await _response.text();
	await d.stop();
	assert.equal( _response.status, status );
	if ( status === 404 ) { assert.deepEqual( JSON.parse( _body ), { error: 'not found' } ); }
} );

attack( SUBJECT, 'routes: the wrong method on a known path is not found, and changes nothing', async () => {
	const d = await deployment();
	const _response = await d.call( 'GET', '/api/missions/invoices/start' );
	await d.stop();
	assert.equal( _response.status, 404 );
	assert.equal( d.main.system.runners.length, 0 );
} );

attack( SUBJECT, 'routes: twenty requests at once all get their answer', async () => {
	const d = await deployment();
	const _all = await Promise.all( Array.from( { length: 20 }, ( _x, i ) => d.call( 'GET', i % 2 ? '/api/nodes' : '/api/tickets' ) ) );
	await d.stop();
	assert.ok( _all.every( response => response.status === 200 ) );
} );
