// Core.Main's API that changes things: starting a mission, messages from outside, the escape test, the abort, tickets.
// A real gate and a real core over HTTP; a person confirms and approves only at the gate, as in production.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { deployment, withEnv, json, until } from './processes.mjs';

const SUBJECT = 'core/main.js';
const started = async ( d, mission = 'invoices', body = {} ) => {
	const _response = await json( await d.call( 'POST', `/api/missions/${mission}/start`, body ) );
	assert.equal( _response.status, 200, JSON.stringify( _response.body ) );
	return _response.body;
};
const confirm = async ( d, hash ) => {
	await until( async () => ( await json( await d.gateCall( 'GET', `/contracts/${hash}` ) ) ).body?.status === 'proposed' );
	return json( await d.gateCall( 'POST', `/contracts/${hash}/confirm`, { by: 'finance lead' } ) );
};
const pending = async d => ( await json( await d.gateCall( 'GET', '/approvals' ) ) ).body;
const bank = async d => ( await json( await d.gateCall( 'GET', '/outbox/bank' ) ) ).body;

attack( SUBJECT, 'start: a mission starts as a drafted goal the gate holds until a person confirms it; nothing leaves before', async () => {
	const d = await deployment();
	const _root = await started( d );
	await until( async () => ( await json( await d.gateCall( 'GET', `/contracts/${_root.contract.hash}` ) ) ).body?.status === 'proposed' );
	await new Promise( resolve => setTimeout( resolve, 100 ) );
	const _state = d.main.system.latest( 'invoices' ).root.state;
	const _approvals = await pending( d );
	const _sent = await bank( d );
	await d.stop();
	assert.equal( _state, 'draft', 'the goal waits for its confirmation' );
	assert.deepEqual( _approvals, [] );
	assert.deepEqual( _sent, [] );
} );

attack( SUBJECT, 'start: after the confirmation every payment waits for a person\'s approval at the gate; none is sent without one', async () => {
	const d = await deployment();
	const _root = await started( d );
	await confirm( d, _root.contract.hash );
	const [ _first ] = await until( async () => {
		const _list = await pending( d );
		return _list.length ? _list : null;
	} );
	await new Promise( resolve => setTimeout( resolve, 100 ) );
	const _sent = await bank( d );
	await d.stop();
	assert.equal( _first.summary.action, 'payment' );
	assert.deepEqual( _sent, [], 'no payment without a token' );
} );

attack( SUBJECT, 'abort: an approved payment goes out once; the abort withdraws what still waits, and a late approval sends nothing', async () => {
	const d = await deployment();
	const _root = await started( d );
	await confirm( d, _root.contract.hash );
	const [ _first ] = await until( async () => {
		const _list = ( await pending( d ) ).filter( item => item.summary.action === 'payment' );
		return _list.length ? _list : null;
	} );
	await d.gateCall( 'POST', `/approvals/${_first.id}`, { decision: 'approve', by: 'finance lead', reason: 'checked against the invoice' } );
	await until( async () => ( await bank( d ) ).length === 1 );
	const [ _second ] = await until( async () => {
		const _list = ( await pending( d ) ).filter( item => item.id !== _first.id );
		return _list.length ? _list : null;
	} );
	const _aborted = await json( await d.call( 'POST', '/api/missions/invoices/abort' ) );
	const _late = await json( await d.gateCall( 'POST', `/approvals/${_second.id}`, { decision: 'approve', by: 'finance lead', reason: 'late' } ) );
	await new Promise( resolve => setTimeout( resolve, 100 ) );
	const _sent = await bank( d );
	await d.stop();
	assert.deepEqual( _aborted.body, { aborted: true, root: _root.id } );
	assert.notEqual( _late.status, 200, 'a withdrawn approval cannot be given any more' );
	assert.equal( _sent.length, 1, 'exactly the one approved payment' );
} );

attack( SUBJECT, 'start: the task a visitor types is cut at 2000 characters before it reaches the model', async () => {
	const d = await deployment();
	await started( d, 'invoices', { task: `Pay the invoices. ${'x'.repeat( 5000 )}` } );
	const _task = d.main.log.since( 0, 1e9 ).find( event => event.kind === 'task_received' ).data.task;
	await d.stop();
	assert.equal( _task.length, 2000 );
	assert.ok( _task.startsWith( 'Pay the invoices.' ) );
} );

attack( SUBJECT, 'start: an unknown mission is a 404 that names no path of the server', async () => {
	const d = await deployment();
	const _response = await json( await d.call( 'POST', '/api/missions/payroll/start' ) );
	await d.stop();
	assert.equal( _response.status, 404 );
	assert.ok( !JSON.stringify( _response.body ).includes( '/' ), JSON.stringify( _response.body ) );
} );

attacks( SUBJECT, [
	{ name: 'start: a mission id with an encoded dot-dot cannot start a folder outside the missions (tests/missions)', id: '..%2Ftests%2Fmissions%2Fcoding' },
	{ name: 'start: a mission id with an encoded dot-dot cannot load a mission.json anywhere on the disk', id: '..%2F..%2Fvultr%2Fmissions%2Fsurvey' },
], async ( { id } ) => {
	const d = await deployment();
	const _response = await json( await d.call( 'POST', `/api/missions/${id}/start` ) );
	const _runners = d.main.system.runners.map( runner => runner.mission.dir );
	await d.stop();
	assert.ok( _response.status >= 400, `status ${_response.status}` );
	assert.deepEqual( _runners, [], 'no run was started' );
} );

attack( SUBJECT, 'start: a body that is not JSON starts nothing and leaves the core answering', async () => {
	const d = await deployment();
	const _response = await fetch( `${d.base}/api/missions/invoices/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{task:' } );
	const _after = await d.call( 'GET', '/api/nodes' );
	await d.stop();
	assert.ok( _response.status >= 400 );
	assert.equal( d.main.system.runners.length, 0 );
	assert.equal( _after.status, 200 );
} );

attack( SUBJECT, 'start: in the public demo a mission that still runs cannot be started again (409)', async () => {
	const d = await deployment( { env: { PUBLIC_DEMO: '1' }, core: { runtime: 'docker' } } );
	await started( d );
	const _again = await json( await d.call( 'POST', '/api/missions/invoices/start' ) );
	await d.stop();
	assert.equal( _again.status, 409 );
	assert.match( _again.body.error, /still going; abort it first/ );
	assert.equal( d.main.system.runners.length, 1 );
} );

attack( SUBJECT, 'inbound: a message to a mission that was never started is refused, and the core stays up', async () => {
	const d = await deployment();
	const _response = await json( await d.call( 'POST', '/api/missions/invoices/inbound/supplier-mail' ) );
	const _after = await d.call( 'GET', '/api/nodes' );
	await d.stop();
	assert.ok( _response.status >= 400 );
	assert.match( _response.body.error, /has not been started/ );
	assert.equal( _after.status, 200 );
} );

attack( SUBJECT, 'inbound: an unknown message of a started mission is refused', async () => {
	const d = await deployment();
	await started( d );
	const _response = await json( await d.call( 'POST', '/api/missions/invoices/inbound/no-such-mail' ) );
	await d.stop();
	assert.ok( _response.status >= 400 );
	assert.match( _response.body.error, /unknown message/ );
} );

attack( SUBJECT, 'inbound: the phishing mail reaches both offices through the API; the gate pays nobody new', async () => {
	const d = await deployment();
	const _root = await started( d );
	await confirm( d, _root.contract.hash );
	const _both = await json( await d.call( 'POST', '/api/missions/invoices/inbound/supplier-mail' ) );
	await new Promise( resolve => setTimeout( resolve, 100 ) );
	const _sent = await bank( d );
	await d.stop();
	assert.equal( _both.status, 200 );
	assert.ok( _both.body.ours && _both.body.neighbour );
	assert.ok( !_sent.some( item => item.params.iban === 'DE89370400440532013000' ) );
} );

attack( SUBJECT, 'exposure: the counters of a started mission come from what arrived outside', async () => {
	const d = await deployment();
	await started( d );
	const _counter = await json( await d.call( 'GET', '/api/missions/invoices/exposure' ) );
	await d.stop();
	assert.equal( _counter.status, 200 );
	assert.equal( _counter.body.unit, 'euros paid wrongly' );
	assert.equal( _counter.body.ours, 0 );
} );

attack( SUBJECT, 'abort: a mission that was never started is refused, and the core stays up', async () => {
	const d = await deployment();
	const _response = await json( await d.call( 'POST', '/api/missions/invoices/abort' ) );
	const _after = await d.call( 'GET', '/api/nodes' );
	await d.stop();
	assert.ok( _response.status >= 400 );
	assert.equal( _after.status, 200 );
} );

attack( SUBJECT, 'nodes: a started goal is listed with its state and the hash the gate holds', async () => {
	const d = await deployment();
	const _root = await started( d );
	const { body } = await json( await d.call( 'GET', '/api/nodes' ) );
	await d.stop();
	assert.equal( body.length, 1 );
	assert.equal( body[ 0 ].id, _root.id );
	assert.equal( body[ 0 ].contract.hash, _root.contract.hash );
} );

// A ticket for a test: a node of a running goal asks a person.
const ticket = async ( d, options = [ 'yes', 'no' ] ) => {
	const _board = await d.main.system.board();
	const _answer = _board.ask( { id: 'node-t', contract: {}, emit: () => {} }, { question: 'Go on?', options, recommendation: 'no', minutes: 1 } );
	return { id: _board.list().at( -1 ).id, answer: _answer };
};

attack( SUBJECT, 'tickets: a person answers an open ticket with one of its options and gets a receipt', async () => {
	const d = await deployment();
	const _ticket = await ticket( d );
	const _response = await json( await d.call( 'POST', `/api/tickets/${_ticket.id}`, { choice: 'yes' } ) );
	const _answer = await _ticket.answer;
	await d.stop();
	assert.equal( _response.status, 200 );
	assert.deepEqual( [ _answer.choice, _answer.by ], [ 'yes', 'person' ] );
	assert.ok( _answer.receipt.id );
} );

attack( SUBJECT, 'tickets: a choice that is not one of the options is refused and the ticket stays open', async () => {
	const d = await deployment();
	const _ticket = await ticket( d );
	const _response = await json( await d.call( 'POST', `/api/tickets/${_ticket.id}`, { choice: 'approve everything' } ) );
	const _open = ( await json( await d.call( 'GET', '/api/tickets' ) ) ).body.map( item => item.id );
	await d.stop();
	assert.ok( _response.status >= 400 );
	assert.ok( _open.includes( _ticket.id ) );
} );

attack( SUBJECT, 'tickets: an unknown ticket cannot be answered', async () => {
	const d = await deployment();
	const _response = await json( await d.call( 'POST', '/api/tickets/tk-nothing', { choice: 'yes' } ) );
	await d.stop();
	assert.ok( _response.status >= 400 );
	assert.match( _response.body.error, /no open ticket/ );
} );

// The brief decides that an answer to a ticket that is no longer open is a client error (4xx), not a 500.
attack( SUBJECT, 'tickets: two answers at the same moment: one counts, the other is refused', async () => {
	const d = await deployment();
	const _ticket = await ticket( d );
	const _both = await Promise.all( [ 'yes', 'no' ].map( choice => d.call( 'POST', `/api/tickets/${_ticket.id}`, { choice } ) ) );
	const _answered = d.main.log.since( 0, 1e9 ).filter( event => event.kind === 'ticket_answered' );
	await d.stop();
	assert.deepEqual( _both.map( response => response.status ).sort(), [ 200, 404 ] );
	assert.equal( _answered.length, 1 );
} );

// A runtime that behaves like an isolated container and records how it was made.
class Contained {

	static NAME = 'test-container';
	static ISOLATED = true;
	static made = [];

	constructor( options ) {
		Contained.made.push( options );
	}

	async run( { script } ) {
		await new Promise( resolve => setTimeout( resolve, 2 ) );
		if ( script.startsWith( 'print(6' ) ) { return { exitCode: 0, stdout: '42\n', stderr: '' }; }
		if ( script.includes( 'os.environ' ) ) { return { exitCode: 0, stdout: '[]\n', stderr: '' }; }
		if ( script.includes( 'urlopen' ) ) { return { exitCode: 1, stdout: '', stderr: 'URLError: [Errno -3] Temporary failure in name resolution' }; }
		if ( script.includes( 'pwned' ) ) { return { exitCode: 1, stdout: '', stderr: 'OSError: [Errno 30] Read-only file system' }; }
		return { exitCode: 137, stdout: '', stderr: 'Killed' };
	}

}

attack( SUBJECT, 'probes: the escape test runs once at a time in a fresh isolated runtime; each probe is an event', async () => {
	const d = await deployment();
	d.main.system.runtime = new Contained( {} );
	Contained.made.length = 0;
	const [ _first, _second ] = await Promise.all( [ d.call( 'POST', '/api/missions/survey/probes' ), d.call( 'POST', '/api/missions/survey/probes' ) ] );
	await until( () => d.main.log.since( 0, 1e9 ).some( event => event.kind === 'sandbox_probes_ended' ) );
	const _events = d.main.log.since( 0, 1e9 ).filter( event => event.kind.startsWith( 'sandbox_probe' ) );
	await d.stop();
	assert.deepEqual( [ _first.status, _second.status ].sort(), [ 202, 409 ] );
	assert.ok( Contained.made.length >= 1 );
	assert.ok( Contained.made.every( options => options.timeoutSeconds === 5 && options.image === 'agency-sandbox-test' ), 'a fresh runtime of the system\'s kind' );
	assert.equal( _events.filter( event => event.kind === 'sandbox_probe' ).length, 7 );
	assert.deepEqual( _events.at( -1 ).data, { mission: 'survey', stopped: 7, of: 7 } );
} );

attack( SUBJECT, 'probes: a runtime that fails in the middle frees the escape test for the next try', async () => {
	const d = await deployment();
	class Broken extends Contained {
		async run() { throw new Error( 'the runtime broke' ); }
	}
	d.main.system.runtime = new Broken( {} );
	const _errors = [];
	const _error = console.error;
	console.error = ( ...args ) => _errors.push( args.join( ' ' ) );
	try {
		assert.equal( ( await d.call( 'POST', '/api/missions/survey/probes' ) ).status, 202 );
		await until( () => !d.main._probing );
		assert.equal( ( await d.call( 'POST', '/api/missions/survey/probes' ) ).status, 202 );
		await until( () => !d.main._probing );
	} finally {
		console.error = _error;
		await d.stop();
	}
	assert.ok( _errors.some( text => /the runtime broke/.test( text ) ) );
} );

attack( SUBJECT, 'probes: in the public demo the escape test counts as a start for the limits', async () => {
	const d = await deployment( { env: { PUBLIC_DEMO: '1' }, core: { runtime: 'docker' } } );
	d.main.system.runtime = new Contained( {} );
	const _statuses = [];
	for ( let i = 0; i < 6; i++ ) {
		_statuses.push( ( await d.call( 'POST', '/api/missions/survey/probes' ) ).status );
		await until( () => !d.main._probing );
	}
	await d.stop();
	assert.deepEqual( _statuses, [ 202, 202, 202, 202, 429, 429 ] );
} );

attack( SUBJECT, 'probes: the engine of the container sandbox is named in the log', async () => {
	const d = await deployment();
	d.main.system.runtime = new Contained( {} );
	await withEnv( { SANDBOX_DOCKER_RUNTIME: 'runsc' }, () => d.call( 'POST', '/api/missions/survey/probes' ) );
	await until( () => !d.main._probing );
	const _started = d.main.log.since( 0, 1e9 ).find( event => event.kind === 'sandbox_probes_started' );
	await d.stop();
	assert.deepEqual( _started.data, { mission: 'survey', runtime: 'test-container', engine: 'runsc', of: 7 } );
} );
