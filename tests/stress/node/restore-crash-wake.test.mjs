// core/loop/restore.js under attack, part 8: after a restart the child re-sends its invitation; the answers to the
// first one arrive while the second waits for its approval (18.4, E1, E4, G-1c).
import assert from 'node:assert/strict';
import { attack } from '../hostile.mjs';
import { after } from './rig.mjs';
import { restart } from './crash.mjs';

const S = 'core/loop/restore.js';

// The person takes a second to approve each invitation, so the answers to the first invitation (sent before the crash)
// arrive while the second one waits for its approval.
function slowInvites() {
	const _seen = new Map();
	return ( approval ) => {
		if ( approval.summary.action !== 'invite' ) { return true; }
		_seen.set( approval.id, _seen.get( approval.id ) ?? Date.now() );
		return Date.now() - _seen.get( approval.id ) > 1000;
	};
}

attack( S, 'E4: after the restart, answers that arrive while an invitation waits for approval are judged, and the goal still ends', async () => {
	const _result = await restart( after( 'waiting_for', { depth: 1 } ), { approve: slowInvites(), waitMs: 5000 } );
	const _skipped = _result.events.filter( event => event.kind === 'transition_skipped' ).length;
	assert.equal( _result.resumed, true, `the goal hangs (${_skipped} transition(s) skipped by E1)` );
	// What is still open, and the last it did: a hang names itself.
	const _unfinished = _result.nodes.filter( item => !item.result );
	const _last = _result.events.filter( event => _unfinished.some( item => item.id === event.node ) ).slice( -12 )
		.map( event => `${event.kind} ${JSON.stringify( event.data ).slice( 0, 160 )}` );
	assert.deepEqual( _result.open, [], `${JSON.stringify( _unfinished.map( item => [ item.depth, item.contract.spec?.kind, item.contract.goal.slice( 0, 60 ) ] ) )}\n${_last.join( '\n' )}` );
}, { timeout: 40000 } );
