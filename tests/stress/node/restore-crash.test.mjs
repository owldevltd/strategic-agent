// core/loop/restore.js under attack, part 4: the core of a real office dies at a chosen moment of the root's work and a
// new core resumes on the same databases and gate (18.4, 18.6). Whatever the moment, the goal must end (G-1c), nothing
// may go out twice, every attempt must be booked (G6) and no outside action may be left open (O9).
import { attacks } from '../hostile.mjs';
import { after } from './rig.mjs';
import { sound, restart } from './crash.mjs';

const S = 'core/loop/restore.js';

attacks( S, [
	{ name: '18.6: dead right after the root was created, before anyone confirmed it', when: () => after( 'node_created', { depth: 0 } ) },
	{ name: '18.6: dead right after the person confirmed the goal', when: () => after( 'contract_confirmed', { depth: 0 } ) },
	{ name: '18.6: dead right after the root accepted its first plan', when: () => after( 'plan_accepted', { depth: 0 } ) },
	{ name: '18.6: dead right after the root hit its first wall', when: () => after( 'wall', { depth: 0 } ) },
	{ name: '18.6: dead right after the root decided to go deeper (U2)', when: () => after( 'verdict', { depth: 0, where: event => event.data.verdict === 'deeper' } ) },
	{ name: '18.6: dead right after the child was created, before its goal was checked', when: () => after( 'node_created', { depth: 1 } ) },
], async ( { when } ) => {
	sound( await restart( when() ) );
}, { timeout: 40000 } );
