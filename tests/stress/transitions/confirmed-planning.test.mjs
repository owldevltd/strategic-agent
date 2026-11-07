// confirmed → planning (table 16.1: at once, no gate). The real ways: a confirmed root goal, a report goal, a child
// confirmed by derivation, a goal whose only strategy will hit a wall, and a goal whose first plan G2 refuses (the
// node stays in planning with the next strategy, chapter 19). Each crossed with what can cut in at that moment.
import assert from 'node:assert/strict';
import { matrix } from './matrix.mjs';
import { path, BETA } from './paths.mjs';
import { strategy } from './rig.mjs';

const T = 'confirmed→planning';

// The node plans right after its confirmation: nothing happened in between but the confirmation's own event.
const atOnce = ( { last, hit } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	const _events = last.events( _node );
	const _at = _events.findIndex( event => event.id === hit[ 0 ].event.id );
	assert.equal( _events[ _at - 1 ].kind, 'contract_confirmed', 'confirmed → planning follows the confirmation at once' );
	assert.deepEqual( Object.keys( hit[ 0 ].event.data ), [ 'from', 'to' ], 'no trigger but the confirmation' );
	assert.equal( hit[ 0 ].stopping, false );
	return _node;
};
// G2 refuses this plan: the move has no parameter "bogus".
const REFUSED = strategy( 'alpha', [ { move: 'stress.measure', params: { bogus: 1 } } ] );

matrix( T, [
	{ name: 'a confirmed root goal', options: path( 'direct' ), status: 'fulfilled', expect: { tokens: 'failed' }, check: atOnce },
	{
		// A model that only answers garbage cannot write the report: the step stops (6.4) and a person closes the goal.
		name: 'a confirmed report goal', options: path( 'report' ), given: { report: true }, status: 'fulfilled',
		expect: { tokens: 'failed', garbage: 'failed' }, check: atOnce,
	},
	{
		name: 'a child confirmed by derivation', node: 'child', options: path( 'deeper' ), status: 'fulfilled', expect: { tokens: 'failed' },
		check: state => assert.equal( atOnce( state ).depth, 1 ),
	},
	{
		name: 'a goal whose only strategy will hit a wall', options: path( 'escalate' ), status: 'failed',
		expect: { late: 'fulfilled', twice: 'fulfilled' }, check: atOnce,
	},
	{
		name: 'a goal whose first plan G2 refuses (19)', options: path( 'direct', { strategies: [ REFUSED, BETA ] } ), status: 'fulfilled',
		expect: { tokens: 'failed' },
		check: ( state ) => {
			const _node = atOnce( state );
			if ( state.id !== 'none' ) { return; }
			assert.deepEqual( state.last.transitions( _node ).slice( 2, 3 ), [ 'planning→executing' ], 'the refused plan never went to judging' );
			assert.equal( _node.walls[ 0 ].cause, 'plan_refused' );
			assert.equal( state.last.events( _node, 'plan_accepted' ).length, 1, 'the refused plan burnt no token (R1)' );
		},
	},
] );
