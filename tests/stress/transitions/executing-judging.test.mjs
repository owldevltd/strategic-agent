// executing → judging (table 16.1: every move in an end state, nothing open, G3). The real ways: the plan ran through
// and proved the criterion, a move reported a wall of the strategy, a move failed, a move ran past its lease (A3), the
// plan ran through without proving the criterion (not_reached), and a move reported a missing precondition (U2).
import assert from 'node:assert/strict';
import { matrix } from './matrix.mjs';
import { path, P1 } from './paths.mjs';
import { attack } from '../hostile.mjs';
import { rig, out } from './rig.mjs';

const T = 'executing→judging';

// Nothing is open when the node judges: the attempt ended in the journal and no move is pending (G3, 16.1).
const ended = ( outcome, cause ) => ( { last, hit, r } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	assert.equal( hit[ 0 ].event.data.outcome, outcome );
	assert.equal( hit[ 0 ].event.data.cause, cause );
	const _first = r.system.journal.forNode( _node.id )[ 0 ];
	assert.ok( _first.endedAt, 'the attempt ended before the judgment (L2)' );
	const _events = last.events( _node );
	const _at = _events.findIndex( event => event.id === hit[ 0 ].event.id );
	const _started = _events.slice( 0, _at ).filter( event => event.kind === 'move_started' ).length;
	const _finished = _events.slice( 0, _at ).filter( event => event.kind === 'move_ended' ).length;
	if ( cause !== 'aborted' ) { assert.equal( _started, _finished, 'every move in an end state' ); }
	return _node;
};

matrix( T, [
	{
		name: 'the plan ran through and proved the criterion', options: path( 'direct' ), status: 'fulfilled',
		check: ( state ) => {
			ended( 'done', null )( state );
			assert.ok( state.last.events( state.root, 'credited' ).length, 'the criterion is credited to the attempt (L4)' );
		},
	},
	{ name: 'a move reported a wall of the strategy', options: path( 'other' ), status: 'fulfilled', expect: { tokens: 'failed' }, check: ended( 'wall', 'not_reached' ) },
	{
		name: 'a move failed while it ran', options: path( 'broken' ), status: 'fulfilled', expect: { tokens: 'failed' },
		check: ( state ) => {
			ended( 'wall', 'move_failed' )( state );
			assert.match( JSON.stringify( state.root.walls[ 0 ].detail ), /the tool broke/ );
		},
	},
	{
		name: 'a move ran past its lease (A3)', options: path( 'lease' ), status: 'fulfilled', expect: { tokens: 'failed' },
		check: ( state ) => {
			ended( 'wall', 'lease_expired' )( state );
			assert.ok( state.last.events( state.root, 'lease_expired' ).length );
		},
	},
	{
		name: 'the plan ran through without proving the criterion', status: 'fulfilled', expect: { tokens: 'failed' },
		options: path( 'other', { script: { 'stress.measure': [ out.none(), out.fact() ] } } ),
		check: ( state ) => {
			const _attempt = state.r.system.journal.forNode( state.root.id )[ 0 ];
			assert.deepEqual( [ _attempt.outcome, _attempt.cause ], [ 'wall', 'not_reached' ], 'ran through, the criterion still open: a wall (L2)' );
			assert.equal( state.root.walls[ 0 ].cause, 'not_reached' );
		},
	},
	{
		name: 'a move reports a missing precondition (16.4)', options: path( 'deeper' ), status: 'fulfilled', expect: { tokens: 'failed' },
		check: ( state ) => {
			ended( 'wall', 'precondition_missing' )( state );
			assert.deepEqual( state.root.walls[ 0 ].precondition, P1, 'the wall names the precondition with its id (16.4)' );
		},
	},
] );

attack( `transition ${T}`, 'the event names the outcome the journal books: a plan that ran through without proving its criterion is a wall', async () => {
	const r = await rig( { script: { 'stress.measure': [ out.none(), out.fact() ] } } );
	const _root = await r.run();
	r.stop();
	const [ _first ] = r.events( _root, 'state_changed' ).filter( event => event.data.from === 'executing' );
	const [ _attempt ] = r.system.journal.forNode( _root.id );
	assert.deepEqual( [ _first.data.outcome, _first.data.cause ], [ _attempt.outcome, _attempt.cause ], 'the log and the journal agree (Z4, L2)' );
} );
