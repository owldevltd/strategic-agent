// core/loop/restore.js under attack, part 7: the core dies while the root goes on after its child's end, with its last
// verdict still "deeper" in the log (18.4, A3, O9). The same properties hold as in restore-crash.test.mjs.
import assert from 'node:assert/strict';
import { attack } from '../hostile.mjs';
import { sound, restart, afterChildEnded } from './crash.mjs';

const S = 'core/loop/restore.js';
const root = kind => ( event, { nodes } ) => event.kind === kind && nodes.get( event.node )?.depth === 0;

attack( S, '18.4: dead while the root ran a new attempt after its child had ended: the goal still closes fulfilled', async () => {
	const _result = await restart( afterChildEnded( root( 'move_started' ) ) );
	assert.deepEqual( _result.attemptsOpen, [], 'the attempt the core was in must be ended and booked' );
	assert.equal( _result.root, 'fulfilled', _result.reason );
}, { timeout: 40000 } );

attack( S, 'A3, O9: dead right after the root asked for approval of its report: the request is settled, never left approved at the gate', async () => {
	const _result = await restart( afterChildEnded( root( 'delivery_started' ) ) );
	assert.deepEqual( _result.deliveriesOpen, [], 'an approved action nobody redeems stays open at the gate' );
	sound( _result );
}, { timeout: 40000 } );
