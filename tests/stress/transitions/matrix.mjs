// The matrix of a transition: every real way it happens (a trigger) crossed with what can cut in at that very moment
// (an interference: an abort, the deadline, the budget, the start tokens, a late or doubled fact, a crash with a
// restart). The interference runs inside the transition, through a hook on the log. After every run the common
// checks hold (check.mjs), the transition happened, and the goal ends with the result the paper prescribes.
import assert from 'node:assert/strict';
import { attacks, within } from '../hostile.mjs';
import { rig, spec, measured, QUANTITY } from './rig.mjs';
import { verify } from './check.mjs';

// A late fact from outside, about the root's quantity; with a fixed id, so a second delivery is a duplicate (E2).
export const LATE = measured( 1, { id: 'late-fact', source: 'mail stress', origin: 'outside', late: true }, QUANTITY );

export const INTERFERENCES = {
	none: { name: 'nothing else happens' },
	abort: { name: 'the client aborts the goal inside it', apply: r => r.abort( r.root ) },
	failed: { name: 'the cascade with status failed starts inside it', apply: r => r.abort( r.root, 'failed' ) },
	abortTwice: {
		name: 'two aborts arrive inside it', apply: ( r ) => {
			r.abort( r.root );
			r.abort( r.root );
		},
	},
	expire: { name: 'the node\'s deadline passes inside it', apply: ( r, node ) => r.expire( node ) },
	exhaust: { name: 'the node\'s budget is exhausted inside it', apply: ( r, node ) => r.exhaust( node ) },
	tokens: { name: 'the start tokens run out inside it', apply: r => r.noTokens() },
	late: { name: 'a late fact from outside arrives inside it', apply: ( r, node ) => r.deliver( node, LATE ) },
	twice: {
		name: 'the same fact arrives twice inside it (E2)', apply: ( r, node ) => {
			r.deliver( node, LATE );
			r.deliver( node, LATE );
		},
	},
	// Events from outside come through the event loop: these land on its next turn, right after the transition.
	abortSoon: { name: 'the client aborts the goal right after it', apply: r => setImmediate( () => r.abort( r.root ) ) },
	lateSoon: { name: 'a late fact from outside arrives right after it', apply: ( r, node ) => setImmediate( () => r.deliver( node, LATE ) ) },
	// The model of every role answers outside its step contract the whole time: the code's own reading applies.
	garbage: { name: 'the model answers garbage throughout', options: { model: 'garbage' } },
	crash: { name: 'the core crashes inside it and restarts', apply: r => r.crash() },
	lateCrash: {
		name: 'a late fact is queued and the core crashes inside it', apply: ( r, node ) => {
			r.deliver( node, LATE );
			r.crash();
		},
	},
	abortCrash: {
		name: 'an abort arrives and the core crashes inside it', apply: ( r ) => {
			r.abort( r.root );
			r.crash();
		},
	},
};

const DEFAULTS = { abort: 'aborted', abortSoon: 'aborted', abortTwice: 'aborted', abortCrash: 'aborted', failed: 'failed', expire: 'failed', exhaust: 'failed' };
// Interferences of the same kind share their expectation unless a trigger names one of them.
const SAME = { abortSoon: 'abort', lateSoon: 'late', lateCrash: 'late' };

// The result the goal must end with: the trigger's own expectation, else the rule of the interference.
export function expected( trigger, id ) {
	if ( trigger.expect && id in trigger.expect ) { return trigger.expect[ id ]; }
	if ( trigger.expect && SAME[ id ] in trigger.expect ) { return trigger.expect[ SAME[ id ] ]; }
	return DEFAULTS[ id ] ?? trigger.status;
}

// One case: → { r, last, root, hit } after the run (and the restart) ended.
export async function play( transition, trigger, id = 'none' ) {
	const _interference = INTERFERENCES[ id ];
	const r = await rig( { ...trigger.options, ..._interference.options } );
	const hit = [];
	let _crashed;
	const _crash = new Promise( ( resolve ) => {
		_crashed = resolve;
	} );
	r.on( transition, ( node, event ) => {
		hit.push( { node, event, version: node.version, stopping: Boolean( node.stopping ) } );
		trigger.inside?.( r, node, event );
		_interference.apply?.( r, node, event );
		if ( r.state.crashed ) { _crashed(); }
	}, { nth: trigger.nth ?? 1, node: trigger.node ?? 'root' } );
	trigger.prepare?.( r );
	const root = await r.start( spec( trigger.given ) );
	r.root = root;
	const _run = r.current().run( root );
	let last = r;
	try {
		const _first = await within( Promise.race( [ _run.then( () => 'ended' ), _crash.then( () => 'crashed' ) ] ), trigger.ms ?? 6000, 'the run' );
		if ( _first === 'crashed' ) {
			last = await r.restart( trigger.restart || {}, trigger.ms ?? 6000 ).catch( ( error ) => {
				r.state.next?.crash();
				throw error;
			} );
			last = last.system.runners.length ? last : r;
		}
	} catch ( error ) {
		// A run that hangs is frozen, so its loops stop and the test file can end.
		r.crash();
		throw error;
	} finally {
		r.stop();
		last.stop();
	}
	// What was scheduled for the next turns of the event loop lands before the checks.
	await new Promise( resolve => setTimeout( resolve, 5 ) );
	return { r, last, root: last.root || root, hit };
}

// The checks of one case.
export async function run( transition, trigger, id ) {
	const { r, last, root, hit } = await play( transition, trigger, id );
	const _status = expected( trigger, id );
	verify( last, { status: _status, root } );
	if ( trigger.absent ) {
		assert.equal( hit.length, 0, `${transition} happened although it must not` );
	} else {
		assert.ok( hit.length, `${transition} never happened` );
		const [ _hit ] = hit;
		assert.equal( _hit.event.nodeVersion, _hit.version, 'the transition event carries the version after it (E1, Z4)' );
		assert.ok( last.events( last.node( _hit.node.id ) || _hit.node, 'state_changed' ).some( event => event.id === _hit.event.id ), 'logged (Z4)' );
	}
	if ( [ 'abort', 'abortSoon', 'abortTwice', 'failed', 'abortCrash' ].includes( id ) && root.state === 'closed' && _status !== trigger.status ) {
		assert.equal( last.events( root, 'abort_received' ).length, 1, 'one abort per node, however many arrive (16.5)' );
	}
	if ( [ 'late', 'lateSoon', 'twice', 'lateCrash' ].includes( id ) && hit.length ) {
		const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
		assert.ok( _node.facts.filter( fact => fact.id === 'late-fact' ).length <= 1, 'a fact with a known id is dropped (E2)' );
		const _kinds = [ 'fact_queued', 'fact_recorded_only', 'fact_after_close' ];
		const _seen = last.events( _node ).filter( event => _kinds.includes( event.kind ) && event.data.kind === 'measured' && event.data.source === 'mail stress' );
		assert.equal( _seen.length, id === 'twice' ? 2 : 1, 'every delivery from outside is in the history (E4)' );
	}
	// Where the interference decided the result, the result names it.
	const _decided = !hit[ 0 ]?.node.parent && _status === 'failed' && trigger.status !== 'failed';
	if ( id === 'expire' && _decided ) {
		assert.match( root.result.reason, /deadline/ );
	}
	if ( id === 'exhaust' && _decided ) {
		assert.match( root.result.reason, /budget/ );
	}
	// A node that crashed while closing is closed by the restart; a goal once closing is not judged again (16.1).
	if ( [ 'crash', 'abortCrash', 'lateCrash' ].includes( id ) && hit.length && hit[ 0 ].event.data.to === 'closing' && !trigger.rejudge ) {
		const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
		const _after = last.events( _node, 'state_changed' ).filter( event => event.id > hit[ 0 ].event.id ).map( event => `${event.data.from}→${event.data.to}` );
		assert.deepEqual( _after, [ 'closing→closed' ], 'the restart finishes the closing it found' );
	}
	await trigger.check?.( { r, last, root, hit, id } );
	return { r, last, root, hit };
}

// Registers trigger × interference for a transition; trigger.only / trigger.skip narrow the interferences.
export function matrix( transition, triggers, ids = Object.keys( INTERFERENCES ) ) {
	const _ids = trigger => ( trigger.only || ids ).filter( id => !( trigger.skip || [] ).includes( id ) );
	const _cases = triggers.flatMap( trigger => _ids( trigger ).map( id => ( {
		name: `${trigger.name}; ${INTERFERENCES[ id ].name}`, trigger, id, defect: trigger.defects?.[ id ] ?? null,
	} ) ) );
	attacks( `transition ${transition}`, _cases, item => run( transition, item.trigger, item.id ) );
	return _cases.length;
}
