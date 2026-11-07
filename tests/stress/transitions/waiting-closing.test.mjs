// waiting → closing (table 16.1: root deadline, budget or an abort while the node waits; the cascade withdraws what is
// open and wakes the node at once, Z6, 16.5). The real ways: the client aborts while a person is asked, while an
// approval is pending, while the node waits for an answer from outside; the goal's deadline passes while it waits; the
// cascade from above reaches a waiting child; and a child's own deadline passes while it waits for a person.
import assert from 'node:assert/strict';
import { matrix, INTERFERENCES } from './matrix.mjs';
import { path, P1 } from './paths.mjs';
import { out, strategy } from './rig.mjs';

const T = 'waiting→closing';
const first = status => Object.fromEntries( Object.keys( INTERFERENCES ).map( id => [ id, status ] ) );
const soon = cause => r => r.on( 'executing→waiting', node => setTimeout( () => cause( r, node ), 15 ), { node: 'root' } );
// A real deadline costs real time: these triggers take the interferences that matter for it.
const TIMED = [ 'none', 'abort', 'abortSoon', 'late', 'lateSoon', 'tokens', 'crash', 'garbage' ];
const NEVER = path( 'ask', { script: { 'stress.ask': [ out.gated( 'never', out.none() ) ], 'stress.measure': [ out.fact() ] } } );
// The root asks a person who answers, the child asks one who never does.
const CHILD = {
	strategies: [ strategy( 'alpha', [ 'stress.ask', 'stress.measure' ] ) ],
	script: {
		'stress.ask@0': [ out.after( 5, out.none() ) ], 'stress.ask@1': [ out.gated( 'never', out.none() ) ],
		'stress.measure@0': [ out.wall( 'precondition_missing', P1 ), out.fact() ], 'stress.measure@1': [ out.fact() ],
	},
};

// Woken at once: the wait ended right after the cause, what it waited for was withdrawn, nothing new started.
const released = ( { last, hit } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	assert.ok( hit[ 0 ].stopping, 'the cascade marked the node before it moved (Z6)' );
	const _after = last.events( _node ).filter( event => event.id > hit[ 0 ].event.id );
	assert.ok( !_after.some( event => event.kind === 'move_started' && event.data.move !== 'move.cancel' ), 'no move after it (G-1a)' );
	const _attempts = last.system.journal.forNode( _node.id );
	assert.ok( _attempts.every( attempt => attempt.endedAt && attempt.outcome !== 'done' ), 'the waiting attempt ended as a wall' );
	return _node;
};

matrix( T, [
	{ name: 'the client aborts while a person is asked', options: NEVER, status: 'aborted', expect: first( 'aborted' ), prepare: soon( r => r.abort( r.root ) ), check: released },
	{
		name: 'the client aborts while an approval is pending', options: path( 'report', { approve: () => null } ), given: { report: true }, status: 'aborted',
		expect: first( 'aborted' ), prepare: soon( r => r.abort( r.root ) ), skip: [ 'garbage' ],
		check: ( state ) => {
			released( state );
			assert.deepEqual( state.last.gateDb.all( 'SELECT status FROM deliveries' ).map( row => row.status ), [ 'not_sent' ], 'withdrawn at the gate (O9)' );
			assert.equal( state.last.gateDb.get( 'SELECT COUNT(*) AS n FROM outbox' ).n, 0 );
		},
	},
	{
		name: 'the client aborts while the node waits for an answer from outside', status: 'aborted', expect: first( 'aborted' ),
		options: path( 'wait', { script: { 'stress.wait': [ out.gated( 'never', out.none() ) ], 'stress.measure': [ out.fact() ] } } ),
		prepare: soon( r => r.abort( r.root ) ), check: released,
	},
	{
		name: 'the goal\'s deadline passes while a person is asked', options: NEVER, given: { deadlineMs: 400 }, status: 'failed', expect: first( 'failed' ),
		only: TIMED,
		check: ( state ) => {
			released( state );
			assert.match( state.root.result.reason, /deadline/ );
			assert.ok( state.last.events( state.root, 'deadline_reached' ).length, 'the deadline is an event (18.1)' );
		},
	},
	{
		name: 'the cascade from above reaches a child waiting for a person', node: 'child', options: CHILD, status: 'aborted', expect: first( 'aborted' ),
		prepare: r => r.on( 'executing→waiting', () => setTimeout( () => r.abort( r.root ), 15 ), { node: 'child' } ),
		check: ( state ) => {
			const _child = released( state );
			assert.match( _child.result.reason, /aborted from above/ );
		},
	},
	{
		name: 'a child\'s own deadline passes while it waits for a person (G-1c)', node: 'child', options: CHILD, status: 'failed',
		given: { deadlineMs: 600400 }, only: TIMED, expect: { ...first( 'failed' ), abort: 'aborted', abortSoon: 'aborted', abortTwice: 'aborted', abortCrash: 'aborted' },
		check: ( state ) => {
			const _child = released( state );
			assert.equal( _child.result.status, 'failed' );
			assert.match( _child.result.reason, /deadline of the node/ );
		},
	},
] );
