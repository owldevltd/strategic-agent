// Shared builders for the stress tests of nodes, recovery and learning: contracts, nodes, logs that keep what was
// written, journals with a clock, and runners made of fakes for the cascade and the restore.
import assert from 'node:assert/strict';
import { app, registry, Contract } from '../../office.mjs';

export const [ Node, Machine, WaitGraph, Cascade, Restore, Journal, Learner, Db, EventLog, Provider, Hash ] = await app.use( [
	'Core.Node.Node', 'Core.Node.Machine', 'Core.Loop.WaitGraph', 'Core.Loop.Cascade', 'Core.Loop.Restore', 'Core.Learn.Journal',
	'Core.Learn.Learner', 'Lib.Db', 'Lib.EventLog', 'Core.Ai.Provider', 'Lib.Hash',
] );
export { app, registry, Contract };

export const HOUR = 3600000;
export const STATES = Object.keys( Machine.TRANSITIONS );
export const tick = ms => new Promise( resolve => setTimeout( resolve, ms ) );

// Polls until check() gives something truthy; a hang becomes a failure.
export async function until( check, ms = 3000, what = 'the condition' ) {
	for ( const end = Date.now() + ms; Date.now() < end; ) {
		const _value = check();
		if ( _value ) { return _value; }
		await tick( 5 );
	}
	throw new Error( `${what} did not hold within ${ms} ms` );
}

// k1: at least two answers measured. deadline: of the contract; criteria: replaces k1.
export function spec( { id = 'c', deadline = new Date( Date.now() + HOUR ).toISOString(), criteria = null, budget = 9, goal = 'g' } = {} ) {
	return {
		id, goal, deadline, budget,
		criteria: criteria || [ { id: 'k1', type: 'number_in_range', values: { quantity: 'answers', min: 2 } } ],
	};
}

export function contract( options = {} ) {
	return new Contract( spec( options ), registry );
}

// A log that keeps every event as the real one would store it (JSON), and can be told to fail.
export function recorder() {
	const _log = {
		events: [], broken: false,
		append( kind, data = {}, { node: nodeId = null, nodeVersion = null } = {} ) {
			if ( _log.broken ) { throw new Error( 'the log cannot be written' ); }
			const _event = { id: _log.events.length + 1, kind, node: nodeId, nodeVersion, data: JSON.parse( JSON.stringify( data ) ) };
			_log.events.push( _event );
			return _event;
		},
		kinds: ( nodeId = null ) => _log.events.filter( event => !nodeId || event.node === nodeId ).map( event => event.kind ),
		of: kind => _log.events.filter( event => event.kind === kind ).map( event => event.data ),
	};
	return _log;
}

export function node( options = {} ) {
	const { log = recorder(), parent = null, id = null, ...rest } = options;
	const _contract = options.contract || contract( rest );
	const _node = new Node( { contract: _contract, parent, log, id } );
	parent?.children.push( _node );
	return _node;
}

// A fact from a count: the measured number of answers.
export const measured = ( value, extra = {} ) => ( {
	kind: 'measured', evidenceClass: 'observation', origin: 'system', data: { quantity: 'answers', value }, ...extra,
} );

// A fact about one thing (E5): its kind, what it is about, its value, its origin.
export const about = ( thing, value, origin, kind = 'item_state' ) => ( {
	kind, evidenceClass: 'claim', source: `inbound ${origin}`, origin, data: { about: thing, value },
} );

// Moves a node along table 16.1 into the given state.
export function bring( item, to ) {
	const _path = {
		draft: [], confirmed: [ 'confirmed' ], planning: [ 'confirmed', 'planning' ], executing: [ 'confirmed', 'planning', 'executing' ],
		waiting: [ 'confirmed', 'planning', 'executing', 'waiting' ], judging: [ 'confirmed', 'planning', 'judging' ],
		closing: [ 'confirmed', 'closing' ], closed: [ 'confirmed', 'closing', 'closed' ],
	}[ to ];
	_path.forEach( state => item.move( state ) );
	return item;
}

// A tree of real nodes: depth levels below the root, width children per node.
export function tree( depth, width = 1, log = recorder() ) {
	const _root = node( { log } );
	let _level = [ _root ];
	for ( let d = 0; d < depth; d++ ) {
		_level = _level.flatMap( parent => Array.from( { length: width }, () => node( { log, parent } ) ) );
	}
	return { root: _root, log, all: Cascade.tree( _root ) };
}

// A journal on its own database with a clock the test moves.
export function journal( start = '2026-11-03T16:00:00Z' ) {
	const _clock = { now: Date.parse( start ) };
	const _db = new Db( ':memory:' );
	return { db: _db, clock: _clock, journal: new Journal( _db, { now: () => _clock.now } ) };
}

// What the journal needs of a node.
export const jnode = id => ( { id, depth: 0, contract: { hash: `h-${id}` } } );

// A runner of fakes for the cascade: a gate with rows per delivery, a board and a runtime that record what they are
// told. gate.withdraw answers with the status in rows (or what withdraw( id ) returns when given).
export function cascadeRunner( { rows = {}, withdraw = null, board = true, runtime = true } = {} ) {
	const calls = { withdrawn: [], stopped: [], tickets: [], boardWithdrawn: [], followed: [], asked: [] };
	const _board = board && {
		withdraw: ( ids ) => {
			calls.boardWithdrawn.push( [ ...ids ] );
			return [];
		},
		ask: async ( item, ticket ) => {
			calls.asked.push( { node: item.id, ...ticket } );
			return { choice: 'checked', by: 'test-person' };
		},
	};
	const _runner = {
		executor: { board: _board || null, runtime: runtime ? { stop: id => calls.stopped.push( id ) } : null },
		gate: {
			withdraw: async ( id ) => {
				calls.withdrawn.push( id );
				return withdraw ? withdraw( id ) : { delivery: id, status: rows[ id ] ?? 'not_sent' };
			},
			delivery: async id => ( id in rows ? { id, status: rows[ id ] } : null ),
		},
		execution: { follow: ( item, id ) => calls.followed.push( id ) },
	};
	return { runner: _runner, calls, cascade: new Cascade( _runner ) };
}

// A model for the learner whose answers are scripted; each call takes the next one (a function is called).
export function scripted( ...answers ) {
	class Scripted extends Provider {

		constructor() {
			super( {} );
			this.calls = [];
		}

		async _complete( request ) {
			this.calls.push( request );
			const _next = answers.length > 1 ? answers.shift() : answers[ 0 ];
			return typeof _next === 'function' ? _next( request ) : _next;
		}

	}
	return new Scripted();
}

// Every state_changed of a node continues where the one before it ended, and only along table 16.1 (Z3, Z4).
export function chain( events, nodeId ) {
	let _at = 'draft';
	for ( const event of events.filter( item => item.node === nodeId && item.kind === 'state_changed' ) ) {
		assert.equal( event.data.from, _at, `node ${nodeId}: ${event.data.from} → ${event.data.to} does not continue from ${_at}` );
		assert.ok( Machine.allowed( event.data.from, event.data.to ), `node ${nodeId}: ${event.data.from} → ${event.data.to}` );
		_at = event.data.to;
	}
	return _at;
}
