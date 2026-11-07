// Tools of the chaos runs: the test missions, a crash that really stops the old core, and waiting without hanging.
import { office, Mission } from '../../office.mjs';
import { MISSIONS, Recording } from './coding.mjs';

export const load = id => Mission.load( id, MISSIONS );
export const sleep = ms => new Promise( resolve => setTimeout( resolve, ms ) );

export async function until( check, ms = 8000, what = 'the condition' ) {
	for ( const end = Date.now() + ms; Date.now() < end; await sleep( 3 ) ) {
		const _value = await check();
		if ( _value ) { return _value; }
	}
	throw new Error( `timed out waiting for ${what}` );
}

// An office for one of the test missions, with a recording provider.
export async function missionOffice( id, { edit = null, answers = {}, approve, person, share = null, resume = false } = {} ) {
	const _mission = load( id );
	edit?.( _mission );
	const _provider = new Recording( { answers: { ..._mission.stub, ...answers } } );
	const _office = await office( { mission: _mission, provider: _provider, approve, person, share, resume } );
	// The harness beats leases every 50 ms (a 200 ms window); under a full parallel test run the event loop can stall
	// longer, and a lease that runs out ends its move (A3). The missions here are about the missions: a 4 s window.
	_office.system.config = { ..._office.system.config, beatMs: 1000 };
	if ( _office.runner ) { _office.runner.supervisor.beatMs = 1000; }
	return { ..._office, provider: _provider, mission: _mission };
}

// A lease window of 4 s for an office made with office() directly (see missionOffice).
export function steady( o ) {
	o.system.config = { ...o.system.config, beatMs: 1000 };
	o.runner.supervisor.beatMs = 1000;
	return o;
}

// A crash: the core is gone. office.crash() cuts the gate and the log; in one test process the old core's promises
// would still run, so everything it could still do hangs from here on, and nothing it does reaches the shared stores.
export function freeze( o ) {
	const _hang = () => new Promise( () => {} );
	const _silent = { append: () => ( {} ), since: () => [], forNode: () => [], subscribe: () => () => {} };
	const _journal = new Proxy( {}, { get: () => () => [] } );
	o.crash();
	o.system.runtime.run = _hang;
	o.provider.complete = _hang;
	for ( const runner of o.system.runners ) {
		Object.assign( runner, { _step: _hang, spawn: _hang, start: _hang, trusted: _hang } );
		Object.assign( runner, { log: _silent, journal: _journal, memory: null, account: null } );
		Object.assign( runner.executor, { log: _silent, provider: o.provider } );
		runner.nodes.forEach( ( node ) => {
			node.log = null;
		} );
	}
}

// Calls fn once, after the k-th event the core logs from now on (k counts from 1); → a promise of whether it ran.
export function afterEvents( o, k, fn ) {
	let _count = 0;
	let _done = false;
	return new Promise( ( resolve ) => {
		const _off = o.log.subscribe( () => {
			_count += 1;
			if ( _done || _count < k ) { return; }
			_done = true;
			_off();
			setImmediate( () => Promise.resolve( fn() ).then( () => resolve( true ), () => resolve( true ) ) );
		} );
		o.whenClosed = () => {
			if ( !_done ) {
				_done = true;
				_off();
				resolve( false );
			}
		};
	} );
}

// The resumed office on the stores of a crashed one. Its ticket board exists before the resume starts: office( {
// resume: true } ) would race System.board() against the resume (a defect with a test of its own in chaos-restart).
export async function restarted( o, id, { edit = null, answers = {}, approve, person } = {} ) {
	const _second = await missionOffice( id, { edit, answers, approve, person, share: o } );
	// Closing waits at most Δ for what only time clears; 1.2 s instead of 5 minutes keeps a stuck close inside the test.
	_second.system.config = { ..._second.system.config, gate: { ..._second.system.config.gate, bufferMinutes: 0.02 } };
	const _fresh = () => {
		const _mission = load( id );
		edit?.( _mission );
		return _mission;
	};
	const _resumed = _second.system.resume( { load: _fresh, provider: _second.provider, pollMs: 5 } );
	return { ..._second, resumed: _resumed };
}
