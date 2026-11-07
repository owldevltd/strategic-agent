// planning → closing (table 16.1: root deadline, budget or an abort while the node plans, Z6; R1: no start token for
// the next round; P1: the budget exactly spent with nothing eligible). The real ways, each crossed with what else can
// cut in while the node turns to closing.
import assert from 'node:assert/strict';
import { matrix, INTERFERENCES } from './matrix.mjs';
import { path, ALPHA, BETA } from './paths.mjs';
import { out } from './rig.mjs';

const T = 'planning→closing';
const first = status => Object.fromEntries( Object.keys( INTERFERENCES ).map( id => [ id, status ] ) );

// Nothing new began after the cause: no token burnt and no move started once the node turned to closing (G-1a, Z6).
const held = ( { last, hit } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	const _after = last.events( _node ).filter( event => event.id > hit[ 0 ].event.id );
	assert.ok( !_after.some( event => [ 'plan_accepted', 'child_started' ].includes( event.kind ) ), 'nothing new after it (G-1a)' );
	assert.ok( !_after.some( event => event.kind === 'move_started' && event.data.move !== 'move.cancel' ) );
	assert.ok( hit[ 0 ].event.data.reason, 'the transition names why' );
	return _node;
};

matrix( T, [
	{
		name: 'the client aborts while the node plans', options: path( 'other' ), status: 'aborted', expect: first( 'aborted' ),
		prepare: r => r.on( 'judging→planning', () => r.abort( r.root ) ),
		check: ( state ) => {
			held( state );
			assert.equal( state.last.events( state.root, 'plan_accepted' ).length, 1, 'only the first strategy ever started' );
		},
	},
	{
		name: 'the deadline passes while the node plans its first strategy', options: path( 'direct' ), status: 'failed', expect: first( 'failed' ),
		prepare: r => r.on( 'confirmed→planning', node => r.expire( node ) ),
		check: ( state ) => {
			held( state );
			assert.match( state.root.result.reason, /deadline/ );
		},
	},
	{
		name: 'the budget is exhausted while the node plans another strategy', options: path( 'other' ), status: 'failed', expect: first( 'failed' ),
		prepare: r => r.on( 'judging→planning', node => r.exhaust( node ) ),
		check: ( state ) => {
			held( state );
			assert.match( state.root.result.reason, /budget/ );
		},
	},
	{
		// An abort that arrives while the goal already closes as failed: which result counts is open (a question).
		name: 'no start token is left for the next round (R1)', options: path( 'other' ), status: 'failed',
		expect: { ...first( 'failed' ), ...Object.fromEntries( [ 'abort', 'abortSoon', 'abortTwice', 'abortCrash' ].map( id => [ id, [ 'failed', 'aborted' ] ] ) ) },
		prepare: r => r.on( 'executing→judging', () => r.noTokens() ),
		check: ( state ) => {
			held( state );
			if ( [ 'none', 'late', 'twice', 'tokens', 'crash', 'lateCrash' ].includes( state.id ) ) { assert.match( state.root.result.reason, /no start tokens left/ ); }
			assert.equal( state.last.events( state.root, 'plan_accepted' ).length, 1 );
		},
	},
	{
		name: 'the budget is exactly spent and nothing is eligible (P1)', status: 'failed', given: { budget: 1 },
		options: path( 'other', { strategies: [ ALPHA, BETA ], script: { 'stress.measure': [ out.wall( 'not_reached' ) ] } } ),
		expect: { ...first( 'failed' ), abort: 'failed', abortTwice: 'failed', abortCrash: 'failed' },
		check: ( state ) => {
			held( state );
			assert.match( state.root.result.reason, /budget is exhausted \(1 of 1\)/, 'the budget ends the goal; no person is asked (Z6)' );
			assert.ok( !state.last.events( state.root, 'ticket_opened' ).length );
		},
	},
	{
		name: 'the cascade from above reaches a child while it plans', node: 'child', options: path( 'deeper' ), status: 'aborted', expect: first( 'aborted' ),
		prepare: r => r.on( 'confirmed→planning', () => r.abort( r.root ), { node: 'child' } ),
		check: ( state ) => {
			const _child = held( state );
			assert.match( _child.result.reason, /aborted from above/ );
		},
	},
	{
		name: 'the deadline passes while the strategy is being chosen (Z6 before the token)', options: path( 'direct' ), status: 'failed',
		expect: first( 'failed' ),
		prepare: r => r.onEvent( 'check', node => r.expire( node ), { node: 'root', when: event => event.data.gate === 'G2' } ),
		check: ( state ) => {
			held( state );
			assert.equal( state.last.events( state.root, 'plan_accepted' ).length, 0, 'the plan G2 passed did not burn a token after the deadline (R4)' );
		},
	},
] );
