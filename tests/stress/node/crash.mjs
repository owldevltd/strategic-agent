// The properties every restart must keep, whatever moment the core died at (18.4, 18.6, G-1c, G6, O9), for the
// restart tests built on rig.mjs.
import assert from 'node:assert/strict';
import { crashAt, outcome } from './rig.mjs';
import { chain } from './kit.mjs';

export function sound( result, { fulfilled = true } = {} ) {
	assert.equal( result.resumed, true, 'the resumed goal ends (G-1c)' );
	assert.deepEqual( result.open, [], 'every node reached an end state' );
	if ( fulfilled ) { assert.equal( result.root, 'fulfilled', `the crash must not cost the goal: ${result.reason}` ); }
	assert.ok( result.reports <= 1, `the report went out ${result.reports} times` );
	assert.deepEqual( result.attemptsOpen, [], 'every attempt ended and booked (G6, commercial)' );
	assert.deepEqual( result.deliveriesOpen, [], 'no outside action left open (O9)' );
	result.nodes.forEach( item => chain( result.events, item.id ) );
}

// Crashes, resumes, and gives what the office left behind. A case a late answer started (8.1) is a goal of its own and
// may still be closing when the resumed goal ends: it gets settleMs to reach its end state too (G-1c) before anything
// is counted as open.
export async function restart( when, options = {} ) {
	const _r = await crashAt( when, options );
	try {
		assert.equal( _r.crashed, true, 'the run reached the crash point' );
		const _end = Date.now() + ( options.settleMs ?? 3000 );
		while ( _r.roots && _r.nodes().some( item => item.state !== 'closed' ) && Date.now() < _end ) {
			await new Promise( resolve => setTimeout( resolve, 20 ) );
		}
		return { ...outcome( _r ), runners: _r.second.runners.length };
	} finally {
		_r.stop();
	}
}

// Crash points that need to know what came before: the first event when() picks after the root heard its child end.
export function afterChildEnded( when ) {
	let _ended = false;
	return ( event, context ) => {
		if ( event.kind === 'child_ended' ) { _ended = true; }
		return _ended && event.kind !== 'child_ended' && when( event, context );
	};
}
