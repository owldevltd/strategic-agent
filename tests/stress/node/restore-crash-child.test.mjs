// core/loop/restore.js under attack, part 5: the core dies while the child works for its precondition, or just before
// the root closes (18.4, 18.6). The same properties hold as in restore-crash.test.mjs.
import { attack, attacks } from '../hostile.mjs';
import { after } from './rig.mjs';
import { sound, restart } from './crash.mjs';

const S = 'core/loop/restore.js';

attacks( S, [
	{ name: '18.6: dead right after the child asked for approval of the invitation', when: () => after( 'delivery_started', { depth: 1 } ) },
	{ name: '18.6: dead right after the child closed, before its parent heard of it', when: () => after( 'node_closed', { depth: 1 } ) },
	{ name: '18.6: dead right after the root learned its lessons, before it closed', when: () => after( 'lesson_written', { depth: 0 } ) },
], async ( { when } ) => {
	sound( await restart( when() ) );
}, { timeout: 40000 } );

// Answers to the first invitation may reach the child while its second invitation waits for approval; see the
// deterministic case in restore-crash-after-child.test.mjs. Whether this run hits that window depends on timing.
attack( S, '18.6: dead right after the child began to wait for answers', async () => {
	sound( await restart( after( 'waiting_for', { depth: 1 } ), { waitMs: 8000 } ) );
}, { timeout: 40000 } );
