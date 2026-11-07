// judging → closing (table 16.1: "done" proposed; and from every state but the final ones the cascade). The real ways:
// U1 every criterion is proven, the open attempt already proved the goal, a person closes the goal after the
// escalation, nobody is there to ask, a child with no way left reports to its parent (8.4), and an abort after a wall.
import assert from 'node:assert/strict';
import { matrix, LATE } from './matrix.mjs';
import { path, P1, ALPHA } from './paths.mjs';
import { out } from './rig.mjs';

const T = 'judging→closing';
// An abort, the deadline or the budget that arrives while the goal already closes: which result counts is open (a
// question in the report); both are accepted, every other check holds.
const open = status => ( {
	abort: [ status, 'aborted' ], abortSoon: [ status, 'aborted' ], abortTwice: [ status, 'aborted' ], abortCrash: [ status, 'aborted' ],
	failed: [ status, 'failed' ], expire: [ status, 'failed' ], exhaust: [ status, 'failed' ],
} );
const WAKE = path( 'ask', { script: { 'stress.ask': [ out.gated( 'never', out.none() ) ], 'stress.measure': [ out.fact() ] } } );
const STUCK_CHILD = { strategies: [ ALPHA ], script: { 'stress.measure@0': [ out.wall( 'precondition_missing', P1 ), out.fact() ], 'stress.measure@1': [ out.wall( 'not_reached' ) ] } };

// Closing follows the judgment at once; a goal judged done carries no result yet (G6 decides), a failed one does.
const closes = ( { last, hit } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	const _events = last.events( _node );
	const _at = _events.findIndex( event => event.id === hit[ 0 ].event.id );
	const _next = _events.slice( _at + 1 ).find( event => event.kind === 'state_changed' );
	assert.ok( [ 'closed', 'judging' ].includes( _next?.data.to ), `after closing: ${_next?.data.to}` );
	assert.ok( !_events.slice( _at + 1 ).some( event => event.kind === 'plan_accepted' ), 'nothing new starts while closing' );
	return _node;
};

matrix( T, [
	{
		name: 'U1: every criterion is proven', options: path( 'direct' ), status: 'fulfilled', expect: open( 'fulfilled' ),
		check: ( state ) => {
			closes( state );
			const _verdict = state.last.events( state.root, 'verdict' ).at( -1 );
			assert.deepEqual( [ _verdict.data.verdict, _verdict.data.rule ], [ 'done', 'U1' ] );
		},
	},
	{
		name: 'the open attempt already proved the goal (U1 while it is open)', options: WAKE, status: 'fulfilled', expect: open( 'fulfilled' ), ms: 3000,
		prepare: r => r.on( 'executing→waiting', node => setTimeout( () => r.deliver( node, LATE ), 10 ) ),
		skip: [ 'late', 'lateSoon', 'twice', 'lateCrash' ],
		check: ( state ) => {
			closes( state );
			assert.ok( /continue/.test( JSON.stringify( state.hit[ 0 ].event.data ) ), 'the judgment of the open attempt (19)' );
		},
	},
	{
		name: 'a person closes the goal after the escalation', options: path( 'escalate' ), status: 'failed', expect: open( 'failed' ),
		check: ( state ) => {
			closes( state );
			assert.match( JSON.stringify( state.root.result ), /escalation|abort|deadline|budget/ );
		},
	},
	{
		name: 'nobody is there to ask: the escalation closes the goal', options: path( 'escalate', { board: false } ), status: 'failed', expect: open( 'failed' ),
		check: ( state ) => {
			closes( state );
			if ( state.id === 'none' ) { assert.equal( state.root.result.reason, 'stuck, nobody to ask' ); }
		},
	},
	{
		name: 'a child with no way left reports to its parent (8.4)', node: 'child', options: STUCK_CHILD, status: 'failed',
		check: ( state ) => {
			const _child = closes( state );
			const _ok = [ 'failed', 'aborted' ].includes( _child.result.status );
			assert.ok( _ok, JSON.stringify( _child.result ) );
			if ( state.id === 'none' ) { assert.ok( state.last.events( state.root, 'ticket_from_child' ).length, 'the parent holds the child\'s ticket (8.4)' ); }
		},
	},
	{
		name: 'the client aborts after a wall', options: path( 'other' ), status: 'aborted',
		expect: { failed: 'aborted', expire: 'aborted', exhaust: 'aborted', tokens: 'aborted', late: 'aborted', lateSoon: 'aborted', twice: 'aborted', crash: 'aborted', lateCrash: 'aborted' },
		prepare: r => r.on( 'executing→judging', () => r.abort( r.root ), { node: 'root' } ),
		check: ( state ) => {
			closes( state );
			assert.equal( state.last.events( state.root, 'verdict' ).length, 0, 'no judgment after the abort (Z6)' );
		},
	},
] );
