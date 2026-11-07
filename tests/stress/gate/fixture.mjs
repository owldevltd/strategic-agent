// Shared set-up of the gate stress tests: an Egress on an in-memory ledger with a fake clock and a confirmed
// contract, request builders, channel doubles that fail, hang or hold, a gate process on 127.0.0.1 port 0 with a
// temporary storage folder, and a capture server that records what the core's client sends.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { use } from '../../helper.mjs';
import { boot } from '../../../lib/node.mjs';

export const app = boot( { overrides: '' } );

export const [
	Registry, Contract, Db, EventLog, Egress, Outbox, Actions, Store, Leases, Rules, Local, Channels, Hash, Main, GateClient, Proposals,
] = await use(
	'Core.Criteria.Registry', 'Core.Contract.Contract', 'Lib.Db', 'Lib.EventLog', 'Gate.Egress', 'Gate.Channel.Outbox', 'Lib.Actions',
	'Gate.Store', 'Gate.Leases', 'Gate.Rules', 'Gate.Local', 'Gate.Channels', 'Lib.Hash', 'Gate.Main', 'Core.Outbound.GateClient', 'Gate.Proposals',
);
export const registry = await Registry.load();
export const START = Date.parse( '2026-11-05T09:00:00Z' );
export const DEADLINE = '2026-11-07T17:00:00Z';
export const MINUTE = 60000;
export const IBAN = 'DE02120300000000202051';
export const FOREIGN = 'DE89370400440532013000';

export const people = ( n, from = 1 ) => Array.from( { length: n }, ( _x, i ) => `r${String( i + from ).padStart( 2, '0' )}` );

// Each goal names the kind of its mission, as the core's drafter always does: the gate's master data from the mission
// folders serves the goals of that kind.
export const surveySpec = ( extra = {} ) => ( {
	id: 'survey', goal: 'Find out why the design team is unhappy', deadline: DEADLINE, kind: 'hr-survey',
	criteria: [
		{ id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'morale' } },
		{ id: 'k2', type: 'min_group', values: { k: 5 } },
		{ id: 'k3', type: 'no_difference', values: { k: 5 } },
	],
	...extra,
} );

export const invoiceSpec = ( extra = {}, max = 5000 ) => ( {
	id: 'invoices', goal: 'Pay this week\'s supplier invoices', deadline: DEADLINE, kind: 'supplier-payments',
	criteria: [
		{ id: 'k1', type: 'items_resolved', values: { collection: 'invoices', items: [ 'R-1186', 'R-1187' ], outcomes: [ 'paid', 'escalated' ] } },
		{ id: 'k2', type: 'exactly_once', values: { key: 'invoiceId', action: 'payment' } },
		{ id: 'k3', type: 'account_from_master', values: { param: 'iban' } },
		{ id: 'k4', type: 'sum_max', values: { max } },
		{ id: 'k5', type: 'human_approval', values: { actions: [ 'payment' ] } },
	],
	...extra,
} );

export const reply = ( cohort, labels = [ 'own' ], extra = {} ) => ( {
	action: 'reply', target: 'ceo', params: { body: 'Workload is the main reason' }, labels: { body: labels }, cohort, ...extra,
} );

export const pay = ( invoiceId, amount = 1200, { iban = IBAN, labels = [ 'own' ], extra = {} } = {} ) => ( {
	action: 'payment', target: 'bank', params: { invoiceId, iban, amount }, labels: { iban: labels }, ...extra,
} );

// The action table of the catalog with some entries replaced or added.
export const actionsWith = ( overrides = {} ) => new Actions( { ...Actions.load().table, ...overrides } );

// A channel that fails the first sends, never answers, holds every send until released, or answers with whatever
// answer() returns. With idempotent = false it does not keep the key (O3).
export class Service extends Outbox {

	static IDEMPOTENT = true;

	constructor( db, { failures = 0, silent = false, hold = false, answer = null, lookup = null } = {} ) {
		super( db );
		Object.assign( this, { failures, silent, hold, answer, lookupWith: lookup, sent: [], waiting: [] } );
	}

	async send( delivery ) {
		this.sent.push( delivery.id );
		if ( this.silent ) { return new Promise( () => {} ); }
		if ( this.hold ) {
			const _go = await new Promise( resolve => this.waiting.push( resolve ) );
			if ( !_go ) { return { ok: false, error: 'released as failed' }; }
		}
		if ( this.answer ) { return this.answer( delivery ); }
		if ( this.failures-- > 0 ) { return { ok: false, error: 'service unavailable' }; }
		return super.send( delivery );
	}

	lookup( delivery ) {
		return this.lookupWith ? this.lookupWith( delivery ) : super.lookup( delivery );
	}

	release( ok = true ) {
		const _list = this.waiting.splice( 0 );
		_list.forEach( resolve => resolve( ok ) );
		return _list.length;
	}

}

export class Plain extends Service {

	static IDEMPOTENT = false;

}

// An Egress with a fake clock, one proposed (and by default confirmed) contract and helpers for the usual steps.
export function gate( options = {} ) {
	const { spec = surveySpec(), db = new Db( ':memory:' ), channel = null, channels = null, actions, confirm = true } = options;
	const { retryMs = 1, sendMs = 200, approvalMinutes, bufferMinutes = 5, master = [ IBAN ], service = {}, plain = false } = options;
	const { ledger, recipients = [ 'hr', 'ceo' ], proposals = false } = options;
	const _clock = { now: START };
	const _channel = channel || new ( plain ? Plain : Service )( db, service );
	const _egress = new Egress( {
		db, log: new EventLog( db, 'gate' ), channels: channels || { default: _channel }, now: () => _clock.now, actions, retryMs, sendMs,
		approvalMinutes, bufferMinutes, ledger, proposals,
	} );
	const _contract = new Contract( spec, registry );
	_egress.propose( _contract.canonical(), _contract.rules(), _contract.hash );
	if ( confirm ) { _egress.confirm( _contract.hash, 'person' ); }
	_egress.store.addMaster( 'account', master );
	_egress.store.addMaster( 'recipient', recipients );
	const g = { db, clock: _clock, egress: _egress, store: _egress.store, channel: _channel, contract: _contract, hash: _contract.hash };
	g.lease = ( node = 'worker', minutes = 5, contract = _contract.hash ) => _egress.lease( { node, move: 'test', contract, minutes } );
	g.submit = ( request, lease = g.lease() ) => _egress.submit( {
		contract: _contract.hash, lease: lease.id, fence: lease.fence, ...request,
	} );
	g.approve = ( result, opts = { reason: 'checked against the order', explicit: true } ) => _egress.decide(
		result.approval, 'approve', 'person', opts,
	);
	g.redeem = ( result, lease = g.lease() ) => _egress.redeem( {
		delivery: result.delivery, approval: result.approval, lease: lease.id, fence: lease.fence,
	} );
	g.approved = async request => g.approve( await g.submit( request ) );
	g.send = async ( request ) => {
		const _result = await g.submit( request );
		return _result.status === 'awaiting_approval' ? g.redeem( await g.approve( _result ) ) : _result;
	};
	g.row = id => _egress.store.delivery( id );
	g.approval = id => db.get( 'SELECT * FROM approvals WHERE id = :id', { id } );
	g.attempts = id => db.all( 'SELECT * FROM attempts WHERE delivery = :id ORDER BY nr', { id } );
	g.outbox = () => db.all( 'SELECT * FROM outbox ORDER BY rowid' );
	g.events = kind => db.all( 'SELECT * FROM events WHERE kind = :kind ORDER BY id', { kind } ).map( row => JSON.parse( row.data ) );
	g.child = ( spec2, rules = null ) => {
		const _child = new Contract( spec2, registry );
		return { contract: _child, row: _egress.propose( _child.canonical(), rules || _child.rules(), _child.hash ) };
	};
	return g;
}

// Waits (in real time, a few milliseconds per round) until a delivery leaves 'open'.
export async function settle( g, id, rounds = 200 ) {
	for ( let i = 0; i < rounds && g.row( id ).status === 'open'; i++ ) {
		await new Promise( resolve => setTimeout( resolve, 2 ) );
	}
	return g.row( id );
}

export const tick = ( ms = 0 ) => new Promise( resolve => setTimeout( resolve, ms ) );

// The core's token at a gate with a pin: a deployment sets both.
export const CORE_TOKEN = 'the-core-token-of-the-stress-tests';

// A gate process on 127.0.0.1 with its own temporary storage. The pin and the core token are set only while the process
// reads them; a gate with a pin has the core token too (token: '' for one without). call() is the core's: it carries the
// token, unless options.headers names x-core-token itself (empty for a stranger).
export async function startGate( { pin = '', token = pin ? CORE_TOKEN : '', dir = null, origins = undefined, proposals = false } = {} ) {
	const _dir = dir || fs.mkdtempSync( path.join( os.tmpdir(), 'gate-stress-' ) );
	const _before = { GATE_OPERATOR_PIN: process.env.GATE_OPERATOR_PIN, GATE_CORE_TOKEN: process.env.GATE_CORE_TOKEN };
	for ( const [ name, value ] of [ [ 'GATE_OPERATOR_PIN', pin ], [ 'GATE_CORE_TOKEN', token ] ] ) {
		if ( value ) { process.env[ name ] = value; } else { delete process.env[ name ]; }
	}
	let _main;
	try {
		_main = new Main( { storageDir: _dir, gate: { port: 0, host: '127.0.0.1', bufferMinutes: 5, origins }, proposals } );
	} finally {
		for ( const [ name, value ] of Object.entries( _before ) ) {
			if ( value === undefined ) { delete process.env[ name ]; } else { process.env[ name ] = value; }
		}
	}
	const _port = await _main.start();
	const _url = `http://127.0.0.1:${_port}`;
	const _core = token ? { 'x-core-token': token } : {};
	return {
		main: _main, port: _port, url: _url, dir: _dir, token,
		call: ( method, route, body, options = {} ) => call( _url, method, route, body, {
			...options, headers: { ..._core, ...options.headers },
		} ),
		async stop( { keep = false } = {} ) {
			await _main.stop();
			_main.db.close();
			if ( !keep ) { fs.rmSync( _dir, { recursive: true, force: true } ); }
		},
	};
}

// One HTTP call; raw sends a body as given (a string or a Buffer), otherwise the body is JSON.
export async function call( url, method, route, body, { raw = undefined, headers = {}, timeoutMs = 5000 } = {} ) {
	const _response = await fetch( `${url}${route}`, {
		method, headers: { 'Content-Type': 'application/json', ...headers },
		body: raw !== undefined ? raw : ( body === undefined ? undefined : JSON.stringify( body ) ),
		signal: AbortSignal.timeout( timeoutMs ),
	} );
	const _text = await _response.text();
	let _data = _text;
	try {
		_data = JSON.parse( _text );
	} catch {
		// keeps the text
	}
	return { status: _response.status, data: _data, headers: _response.headers };
}

// The body of a contract proposal, as the core sends it.
export const proposal = ( spec ) => {
	const _contract = new Contract( spec, registry );
	return { contract: _contract, body: { spec: _contract.canonical(), rules: _contract.rules(), hash: _contract.hash } };
};

// A server that records every request and answers with answer( request ) → { status, body } or { status, raw }.
export async function capture( answer = () => ( { status: 200, body: {} } ) ) {
	const _seen = [];
	const _server = http.createServer( ( req, res ) => {
		const _chunks = [];
		req.on( 'data', chunk => _chunks.push( chunk ) );
		req.on( 'end', async () => {
			const _text = Buffer.concat( _chunks ).toString( 'utf8' );
			const _request = {
				method: req.method, url: req.url, text: _text, body: _text ? JSON.parse( _text ) : undefined, headers: req.headers,
			};
			_seen.push( _request );
			const _answer = await answer( _request );
			res.writeHead( _answer.status ?? 200, { 'Content-Type': 'application/json' } );
			res.end( _answer.raw !== undefined ? _answer.raw : JSON.stringify( _answer.body ?? {} ) );
		} );
	} );
	await new Promise( resolve => _server.listen( 0, '127.0.0.1', resolve ) );
	const _url = `http://127.0.0.1:${_server.address().port}`;
	return {
		url: _url, seen: _seen,
		last: () => _seen[ _seen.length - 1 ],
		close: () => new Promise( ( resolve ) => {
			_server.closeAllConnections();
			_server.close( () => resolve() );
		} ),
	};
}

// The contract object the core hands to propose(): canonical(), rules() and hash, here with chosen values.
export const fakeContract = ( spec, rules, hash ) => ( { canonical: () => spec, rules: () => rules, hash } );

// Silences app.fail while a file runs and keeps what it would have printed, so a test can say what went wrong inside.
export function quiet() {
	const _failures = [];
	const _original = app.fail;
	app.fail = ( error ) => {
		_failures.push( error );
	};
	return { failures: _failures, restore: () => {
		app.fail = _original;
	} };
}

// The same ledger opened by a fresh gate, as after a crash: new channel, new Egress, same database and clock.
export function restart( g, { plain = false, service = {}, channel = null, actions, sendMs = 200 } = {} ) {
	const _channel = channel || new ( plain ? Plain : Service )( g.db, service );
	const _egress = new Egress( {
		db: g.db, log: new EventLog( g.db, 'gate' ), channels: { default: _channel }, now: () => g.clock.now, retryMs: 1, sendMs, actions,
	} );
	return { ...g, egress: _egress, store: _egress.store, channel: _channel, row: id => _egress.store.delivery( id ) };
}

// The longest timer Node accepts; a send that should never time out during a test uses it.
export const FOREVER = 2 ** 31 - 1;
