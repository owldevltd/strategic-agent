// planning → executing (table 16.1: the plan is accepted, a start token burnt, G2 and the system gate passed). The
// real ways: the first strategy, another strategy after a wall (U3), an open attempt carried on (19, no new token),
// the child for a missing precondition (U2), the child's own first strategy, and "try once more" after an
// escalation. Each is crossed with what can cut in at that moment.
import assert from 'node:assert/strict';
import { matrix } from './matrix.mjs';
import { path } from './paths.mjs';

const T = 'planning→executing';
const starts = ( r, node ) => r.events( node, 'plan_accepted' ).length;

matrix( T, [
	{
		name: 'the first strategy is accepted', options: path( 'direct' ), status: 'fulfilled',
		check: ( { last, root, hit } ) => {
			assert.equal( hit[ 0 ].event.data.strategy, 'alpha' );
			assert.deepEqual( hit[ 0 ].event.data.steps, [ 'stress.measure' ] );
			const _events = last.events( root ).map( event => event.kind );
			const _move = _events.indexOf( 'move_started' );
			assert.ok( _move < 0 || _events.indexOf( 'plan_accepted' ) < _move, 'the token burns before the first move (R1)' );
		},
	},
	{
		name: 'another strategy after a wall (U3)', nth: 2, options: path( 'other' ), status: 'fulfilled',
		check: ( { hit } ) => assert.equal( hit[ 0 ].event.data.strategy, 'beta', 'another way means another strategy' ),
	},
	{
		name: 'an open attempt is carried on after waiting (19)', nth: 2, options: path( 'ask' ), status: 'fulfilled',
		check: ( { last, root, hit, id } ) => {
			assert.equal( hit[ 0 ].event.data.resumed, 'alpha', 'the open attempt is taken up, not started again' );
			if ( [ 'none', 'late', 'twice', 'tokens' ].includes( id ) ) {
				assert.equal( starts( last, root ), 1, 'carrying an attempt on burns no new token (R1)' );
			}
		},
	},
	{
		name: 'the parent goes deeper for a missing precondition (U2)', nth: 2, options: path( 'deeper' ), status: 'fulfilled',
		expect: { tokens: 'failed' },
		check: ( { hit } ) => assert.equal( hit[ 0 ].event.data.child, 'p1' ),
	},
	{
		name: 'the child for the precondition starts its own strategy', node: 'child', options: path( 'deeper' ), status: 'fulfilled',
		expect: { tokens: 'failed' },
		check: ( { last, hit } ) => {
			const _child = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
			assert.equal( _child.depth, 1 );
			assert.ok( last.events( _child, 'plan_accepted' ).length >= 1 );
		},
	},
	{
		name: 'the person says "try once more" after an escalation', nth: 2, options: path( 'retry' ), status: 'fulfilled',
		check: ( { last, root } ) => assert.ok( last.events( root, 'ticket_answered' ).some( event => event.data.choice === 'try once more' ) ),
	},
] );
