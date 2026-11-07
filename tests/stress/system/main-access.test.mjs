// Core.Main's secrets and switches: the board pin (CORE_BOARD_PIN) guards everything a person does or sees at the core;
// the inbound channel (INBOUND_TOKEN) is off until a token is set; the core's gate client carries the core token; the
// demo's extras (the neighbour, its counters, the canned messages, the escape test) exist only with the demo switch.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import fs from 'node:fs';
import { CoreMain, configFor, deployment, json, tempRoot, until, withEnv } from './processes.mjs';

const SUBJECT = 'core/main.js';
const BOARD = 'board-pin-2468';
const INBOUND = 'inbound-token-of-the-stress-tests';
const CORE = 'core-token-of-the-stress-tests-1';

// One deployment for a group of checks; every check stops it.
async function withDeployment( options, fn ) {
	const d = await deployment( options );
	try {
		return await fn( d );
	} finally {
		await d.stop();
	}
}
const pinned = fn => withDeployment( { env: { CORE_BOARD_PIN: BOARD } }, fn );
const board = { 'x-board-pin': BOARD };

attacks( SUBJECT, [
	{ name: 'board pin: the missions need it', method: 'GET', url: '/api/missions' },
	{ name: 'board pin: the questions need it', method: 'GET', url: '/api/tickets' },
	{ name: 'board pin: the nodes need it', method: 'GET', url: '/api/nodes' },
	{ name: 'board pin: the log needs it', method: 'GET', url: '/api/log' },
	{ name: 'board pin: the live log needs it', method: 'GET', url: '/api/events' },
	{ name: 'board pin: giving a task needs it', method: 'POST', url: '/api/missions/invoices/start' },
	{ name: 'board pin: an abort needs it', method: 'POST', url: '/api/missions/invoices/abort' },
	{ name: 'board pin: an answer needs it', method: 'POST', url: '/api/tickets/tk-1' },
	{ name: 'board pin: the demo counters need it', method: 'GET', url: '/api/missions/invoices/exposure' },
	{ name: 'board pin: a canned message needs it', method: 'POST', url: '/api/missions/invoices/inbound/supplier-mail' },
	{ name: 'board pin: the escape test needs it', method: 'POST', url: '/api/missions/invoices/probes' },
], ( { method, url } ) => pinned( async ( d ) => {
	const _answer = await json( await d.call( method, url, method === 'POST' ? {} : undefined ) );
	assert.equal( _answer.status, 403 );
	assert.equal( _answer.body.error, 'board pin required' );
	assert.equal( d.main.system.runners.length, 0, 'nothing was started' );
} ) );

attacks( SUBJECT, [
	{ name: 'board pin: a wrong pin is 403', headers: { 'x-board-pin': `${BOARD}0` }, want: 403 },
	{ name: 'board pin: the gate\'s operator pin header is no board pin', headers: { 'x-operator-pin': BOARD }, want: 403 },
	{ name: 'board pin: the pin as a bearer token does not count', headers: { Authorization: `Bearer ${BOARD}` }, want: 403 },
	{ name: 'board pin: the right pin in its header reads the missions', headers: board, want: 200 },
], ( { headers, want } ) => pinned( async ( d ) => {
	assert.equal( ( await d.call( 'GET', '/api/missions', undefined, headers ) ).status, want );
} ) );

attack( SUBJECT, 'board pin: the pin in the query string does not count', () => pinned( async ( d ) => {
	assert.equal( ( await d.call( 'GET', `/api/missions?pin=${BOARD}` ) ).status, 403 );
} ) );

attack( SUBJECT, 'board pin: the pin in the body does not count', () => pinned( async ( d ) => {
	assert.equal( ( await d.call( 'POST', '/api/missions/invoices/start', { pin: BOARD } ) ).status, 403 );
} ) );

attack( SUBJECT, 'board pin: with it a task is given', () => pinned( async ( d ) => {
	assert.equal( ( await d.call( 'POST', '/api/missions/invoices/start', {}, board ) ).status, 200 );
} ) );

attack( SUBJECT, 'board pin: the page learns whether a pin is needed, never the pin; health stays open for the operator\'s checks', () => pinned( async ( d ) => {
	const _config = await json( await d.call( 'GET', '/api/config' ) );
	assert.equal( _config.status, 200 );
	assert.equal( _config.body.boardPin, true );
	assert.ok( !JSON.stringify( _config.body ).includes( BOARD ) );
	assert.equal( ( await d.call( 'GET', '/api/health' ) ).status, 200 );
} ) );

attack( SUBJECT, 'board pin: guessing locks the board for a while', () => pinned( async ( d ) => {
	for ( let i = 0; i < 6; i++ ) { await d.call( 'GET', '/api/tickets', undefined, { 'x-board-pin': `guess-${i}` } ); }
	assert.equal( ( await d.call( 'GET', '/api/tickets', undefined, board ) ).status, 429 );
} ) );

attack( SUBJECT, 'board pin: without one (development, an open demo) the board is open and says so', () => withDeployment( {}, async ( d ) => {
	assert.equal( ( await d.call( 'GET', '/api/missions' ) ).status, 200 );
	assert.equal( ( await json( await d.call( 'GET', '/api/config' ) ) ).body.boardPin, false );
} ) );

// The inbound channel: a mail bridge or a form posts the messages it received.
const message = ( extra = {} ) => ( {
	id: `mail-${Math.random().toString( 36 ).slice( 2 )}`, from: 'billing@atlas-office-supplies.example', subject: 'Invoice R-1190',
	text: 'Please find attached our invoice R-1190 over 420.00 EUR.', ...extra,
} );
const inbound = fn => withDeployment( { env: { INBOUND_TOKEN: INBOUND } }, async ( d ) => {
	await d.call( 'POST', '/api/missions/invoices/start', {} );
	return fn( d );
} );
const token = { 'x-inbound-token': INBOUND };

attack( SUBJECT, 'inbound: without INBOUND_TOKEN the channel is off and takes nothing', () => withDeployment( {}, async ( d ) => {
	await d.call( 'POST', '/api/missions/invoices/start', {} );
	const _answer = await json( await d.call( 'POST', '/api/missions/invoices/messages', message(), token ) );
	assert.equal( _answer.status, 403 );
	assert.match( _answer.body.error, /inbound channel is off/ );
} ) );

attacks( SUBJECT, [
	{ name: 'inbound: without the token a message is refused', headers: {}, want: 403 },
	{ name: 'inbound: a wrong token is refused', headers: { 'x-inbound-token': `${INBOUND}!` }, want: 403 },
	{ name: 'inbound: the board pin header is no inbound token', headers: { 'x-board-pin': INBOUND }, want: 403 },
], ( { headers, want } ) => inbound( async ( d ) => {
	const _before = d.main.log.since( 0, 1e9 ).filter( item => item.kind.startsWith( 'inbound' ) ).length;
	assert.equal( ( await d.call( 'POST', '/api/missions/invoices/messages', message(), headers ) ).status, want );
	assert.equal( d.main.log.since( 0, 1e9 ).filter( item => item.kind.startsWith( 'inbound' ) ).length, _before, 'the intake never saw it' );
} ) );

attacks( SUBJECT, [
	{ name: 'inbound: a message without an id is 400', change: { id: '' }, want: /needs its id/ },
	{ name: 'inbound: an id with a blank is 400', change: { id: 'mail 1' }, want: /needs its id/ },
	{ name: 'inbound: an id with a slash is 400', change: { id: '../mail' }, want: /needs its id/ },
	{ name: 'inbound: an id of 201 characters is 400', change: { id: 'm'.repeat( 201 ) }, want: /needs its id/ },
	{ name: 'inbound: an id that is no text is 400', change: { id: 42 }, want: /needs its id/ },
	{ name: 'inbound: a message without a sender is 400', change: { from: '' }, want: /sender/ },
	{ name: 'inbound: a sender that is no text is 400', change: { from: [ 'a@b' ] }, want: /sender/ },
	{ name: 'inbound: a message without a text is 400', change: { text: '   ' }, want: /needs its text/ },
	{ name: 'inbound: a text over 64 KB is 400', change: { text: 'x'.repeat( 70 * 1024 ) }, want: /at most/ },
], ( { change, want } ) => inbound( async ( d ) => {
	const _answer = await json( await d.call( 'POST', '/api/missions/invoices/messages', message( change ), token ) );
	assert.equal( _answer.status, 400 );
	assert.match( _answer.body.error, want );
} ) );

attack( SUBJECT, 'inbound: with the token a message reaches the intake of the mission\'s latest run, labelled foreign', () => inbound( async ( d ) => {
	const _message = message();
	const _answer = await json( await d.call( 'POST', '/api/missions/invoices/messages', _message, token ) );
	assert.equal( _answer.status, 200, JSON.stringify( _answer.body ) );
	const _seen = await until( () => d.main.log.since( 0, 1e9 ).find( item => item.kind.startsWith( 'inbound' ) && item.data.id === _message.id ) );
	assert.ok( _seen );
} ) );

attack( SUBJECT, 'inbound: a mission without a run yet is a client error, not a crash', () => withDeployment( { env: { INBOUND_TOKEN: INBOUND } }, async ( d ) => {
	const _answer = await d.call( 'POST', '/api/missions/survey/messages', message(), token );
	assert.ok( _answer.status >= 400 && _answer.status < 500, `status ${_answer.status}` );
} ) );

attack( SUBJECT, 'inbound: a token shorter than 24 characters stops the core', () => withEnv( { INBOUND_TOKEN: 'short-token' }, () => {
	const _root = tempRoot( 'stress-core-' );
	try {
		assert.throws( () => new CoreMain( configFor( _root ) ), /INBOUND_TOKEN needs at least 24 characters/ );
	} finally {
		fs.rmSync( _root, { recursive: true, force: true } );
	}
} ) );

// The demo switch.
attacks( SUBJECT, [
	{ name: 'demo off: there are no counters', method: 'GET', url: '/api/missions/invoices/exposure' },
	{ name: 'demo off: there are no canned messages', method: 'POST', url: '/api/missions/invoices/inbound/supplier-mail' },
	{ name: 'demo off: there is no escape test', method: 'POST', url: '/api/missions/invoices/probes' },
], ( { method, url } ) => withDeployment( { core: { demo: false } }, async ( d ) => {
	assert.equal( ( await d.call( method, url, method === 'POST' ? {} : undefined ) ).status, 404 );
} ) );

attack( SUBJECT, 'demo off: a run has no neighbour office, and / leads to the control room', () => withDeployment( { core: { demo: false } }, async ( d ) => {
	await d.call( 'POST', '/api/missions/invoices/start', {} );
	assert.equal( d.main.system.latest( 'invoices' ).baseline, null );
	const _root = await fetch( `${d.base}/`, { redirect: 'manual' } );
	assert.equal( _root.headers.get( 'location' ), '/ui/' );
	assert.equal( ( await json( await d.call( 'GET', '/api/config' ) ) ).body.demo, false );
} ) );

attack( SUBJECT, 'demo on: a run has its neighbour office, and / leads to the office', () => withDeployment( {}, async ( d ) => {
	await d.call( 'POST', '/api/missions/invoices/start', {} );
	assert.ok( d.main.system.latest( 'invoices' ).baseline );
	const _root = await fetch( `${d.base}/`, { redirect: 'manual' } );
	assert.equal( _root.headers.get( 'location' ), '/ui/office/' );
} ) );

// The core token between core and gate.
attack( SUBJECT, 'core token: the core proposes at a gate that requires its token, and a stranger cannot', () => withDeployment(
	{ env: { GATE_CORE_TOKEN: CORE } }, async ( d ) => {
		const _started = await json( await d.call( 'POST', '/api/missions/invoices/start', {} ) );
		assert.equal( _started.status, 200 );
		const _hash = _started.body.contract.hash;
		await until( async () => ( await json( await d.gateCall( 'GET', `/contracts/${_hash}`, undefined, { 'x-core-token': CORE } ) ) ).body?.status === 'proposed' );
		assert.equal( ( await d.gateCall( 'GET', `/contracts/${_hash}` ) ).status, 403, 'without the token the gate shows nothing' );
	},
) );

// A task without a mission (POST /api/tasks): only the text and, if the caller wants, a kind of its own.
attack( SUBJECT, 'tasks: without the board pin no task starts', () => pinned( async ( d ) => {
	const _answer = await json( await d.call( 'POST', '/api/tasks', { task: 'Send HR a summary.' } ) );
	assert.equal( _answer.status, 403 );
	assert.equal( d.main.system.runners.length, 0 );
} ) );

attacks( SUBJECT, [
	{ name: 'tasks: a task without text is 400', body: { task: '  ' }, status: 400, error: /a task needs its text/ },
	{ name: 'tasks: a text that is no text is 400', body: { task: [ 'x' ] }, status: 400, error: /a task needs its text/ },
	{ name: 'tasks: a kind with path parts is 400', body: { task: 'x', kind: '../survey' }, status: 400, error: /plain name/ },
	{ name: 'tasks: a kind in capitals is 400', body: { task: 'x', kind: 'HR' }, status: 400, error: /plain name/ },
	{ name: 'tasks: the id of a mission folder is no kind of task (409)', body: { task: 'x', kind: 'invoices' }, status: 409, error: /mission of its own/ },
	{ name: 'tasks: the kind of a mission folder is no kind of task either (409)', body: { task: 'x', kind: 'supplier-payments' }, status: 409, error: /mission of its own/ },
], ( { body, status, error } ) => withDeployment( {}, async ( d ) => {
	const _answer = await json( await d.call( 'POST', '/api/tasks', body ) );
	assert.equal( _answer.status, status, JSON.stringify( _answer.body ) );
	assert.match( _answer.body.error, error );
	assert.equal( d.main.system.runners.length, 0 );
} ) );

attack( SUBJECT, 'tasks: a task is drafted under its kind, which is kept below the storage; a draft the model cannot give is refused (422)', () => withDeployment(
	{}, async ( d ) => {
		const _answer = await json( await d.call( 'POST', '/api/tasks', { task: 'Send HR a short summary of the onboarding checklist.', kind: 'hr-summaries' } ) );
		assert.equal( _answer.status, 422, 'the stub model gives no usable goal' );
		assert.ok( _answer.body.problems.length > 0 );
		assert.ok( fs.existsSync( `${d.main.config.storageDir}/tasks/hr-summaries/mission.json` ) );
		assert.ok( d.main.log.since( 0, 1e9 ).some( item => item.kind === 'task_received' && item.data.mission === 'hr-summaries' ) );
	},
) );

attack( SUBJECT, 'tasks: without a kind the task is of the kind general', () => withDeployment( {}, async ( d ) => {
	await d.call( 'POST', '/api/tasks', { task: 'Summarise the week for HR.' } );
	assert.ok( d.main.log.since( 0, 1e9 ).some( item => item.kind === 'task_received' && item.data.mission === 'general' ) );
} ) );

// A kind of task written down as a mission folder (GET /api/tasks/:kind/mission, for bin/promote.mjs).
attack( SUBJECT, 'mission bundle: without the board pin the kinds and their bundles are not read', () => pinned( async ( d ) => {
	assert.equal( ( await d.call( 'GET', '/api/tasks' ) ).status, 403 );
	assert.equal( ( await d.call( 'GET', '/api/tasks/general/mission' ) ).status, 403 );
} ) );

attacks( SUBJECT, [
	{ name: 'mission bundle: a mission folder is a mission already (409)', kind: 'invoices', status: 409 },
	{ name: 'mission bundle: a kind nobody gave a task of is unknown (404)', kind: 'never-given', status: 404 },
	{ name: 'mission bundle: a kind with capitals is no kind (400)', kind: 'General', status: 400 },
	{ name: 'mission bundle: an encoded path is no kind (400)', kind: '..%2Fsurvey', status: 400 },
], ( { kind, status } ) => withDeployment( {}, async ( d ) => {
	assert.equal( ( await d.call( 'GET', `/api/tasks/${kind}/mission` ) ).status, status );
} ) );

attack( SUBJECT, 'mission bundle: a kind a task was given of is listed, and its bundle holds at least its frame', () => withDeployment( {}, async ( d ) => {
	await d.call( 'POST', '/api/tasks', { task: 'Send HR a short summary.', kind: 'hr-summaries' } );
	const _kinds = await json( await d.call( 'GET', '/api/tasks' ) );
	assert.deepEqual( _kinds.body, [ { kind: 'hr-summaries', strategies: 0, moves: 0 } ] );
	const _bundle = await json( await d.call( 'GET', '/api/tasks/hr-summaries/mission' ) );
	assert.equal( _bundle.status, 200 );
	assert.equal( _bundle.body.kind, 'hr-summaries' );
	assert.deepEqual( Object.keys( _bundle.body.files ).sort(), [ 'contract.json', 'mission.json' ] );
} ) );
