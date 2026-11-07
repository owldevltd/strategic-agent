// executing → waiting (table 16.1: the plan leaves something open, an expectation, a ticket, an approval or a child;
// only this node waits). The real ways: a move asks a person, a second person in the same attempt, a move waits for
// an answer from outside, an action waits for a person's approval at the gate, the parent waits for its child (U2),
// and a person's move that outlasts its lease. Each crossed with what can cut in at that moment.
import assert from 'node:assert/strict';
import { matrix } from './matrix.mjs';
import { path, BETA } from './paths.mjs';
import { strategy, out } from './rig.mjs';

const T = 'executing→waiting';

// Only this node waits, for the move it names; a node that waits started nothing new while it waited.
const waits = what => ( { last, hit } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	assert.ok( hit[ 0 ].event.data.move || hit[ 0 ].event.data.for, 'the transition names what the node waits for' );
	if ( what ) { assert.match( JSON.stringify( hit[ 0 ].event.data ), what ); }
	const _events = last.events( _node );
	const _at = _events.findIndex( event => event.id === hit[ 0 ].event.id );
	const _next = _events.slice( _at + 1 ).find( event => event.kind === 'state_changed' );
	if ( _next ) { assert.notEqual( _next.data.to, 'executing', 'after waiting comes the judgment, never executing (16.1)' ); }
	return _node;
};
const HOLD = { strategies: [ strategy( 'alpha', [ 'stress.hold', 'stress.measure' ] ), BETA ], script: { 'stress.hold': [ out.hang() ], 'stress.measure': [ out.fact() ] } };

matrix( T, [
	{ name: 'a move asks a person', options: path( 'ask' ), status: 'fulfilled', check: waits( /stress\.ask/ ) },
	{
		name: 'a second person is asked in the same attempt', nth: 2, options: path( 'askTwice' ), status: 'fulfilled',
		check: ( state ) => {
			waits( /stress\.ask/ )( state );
			// After a crash the interrupted attempt ends and a new one starts, unless the late fact queued before the crash
			// already proves the goal once the restart took the queue over (E3).
			assert.equal( state.last.events( state.root, 'plan_accepted' ).length, state.id === 'crash' ? 2 : 1, 'one attempt, two waits' );
		},
	},
	{ name: 'a move waits for an answer from outside', options: path( 'wait' ), status: 'fulfilled', check: waits( /stress\.wait/ ) },
	{
		name: 'an action waits for a person\'s approval at the gate', options: path( 'report' ), given: { report: true }, status: 'fulfilled', ms: 1500,
		skip: [ 'garbage' ],
		check: ( state ) => {
			waits( /approval/ )( state );
			const _sent = state.last.gateDb.all( 'SELECT status FROM deliveries' ).map( row => row.status );
			if ( state.root.result.status === 'fulfilled' ) {
				assert.equal( _sent.filter( status => status === 'executed' ).length, 1, 'one report sent, with its token' );
				assert.ok( _sent.every( status => [ 'executed', 'not_sent' ].includes( status ) ), 'what a dead core left pending was withdrawn (O9)' );
			}
			if ( state.root.result.status === 'aborted' ) { assert.ok( !_sent.includes( 'executed' ), 'an aborted goal sent nothing (O9)' ); }
		},
	},
	{
		name: 'the parent waits for its child (U2)', options: path( 'deeper' ), status: 'fulfilled', expect: { tokens: 'failed' },
		check: ( state ) => {
			const _node = waits( /a child/ )( state );
			if ( ![ 'crash', 'abortCrash', 'lateCrash' ].includes( state.id ) ) { assert.equal( _node.children.length, 1, 'one child for the precondition' ); }
		},
	},
	{
		name: 'a person\'s move outlasts its lease (A3)', options: HOLD, status: 'fulfilled', expect: { tokens: 'failed' },
		check: ( state ) => {
			waits( /stress\.hold/ )( state );
			if ( state.id === 'none' ) { assert.equal( state.root.walls[ 0 ].cause, 'lease_expired' ); }
		},
	},
] );
