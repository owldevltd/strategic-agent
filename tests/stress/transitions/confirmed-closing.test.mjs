// confirmed → closing (table 16.1: from every state but the final ones; root deadline, budget or an abort start the
// cascade, 16.5, and come first, Z6). The real ways: the client aborts, the deadline passes, the budget is exhausted,
// all right at the confirmation; the cascade from above reaches a confirmed child; a child's own deadline passes at its
// confirmation. Each crossed with what else can cut in while the node turns to closing.
import assert from 'node:assert/strict';
import { matrix, INTERFERENCES } from './matrix.mjs';
import { path } from './paths.mjs';

const T = 'confirmed→closing';
// What comes first decides: the cause set at the confirmation, whatever else arrives afterwards.
const first = status => Object.fromEntries( Object.keys( INTERFERENCES ).map( id => [ id, status ] ) );
const at = ( cause, node = 'root' ) => r => r.on( 'draft→confirmed', target => cause( r, target ), { node } );

// The node never planned: no strategy was scored, no token burnt, nothing reached the gate; the reason is logged.
const never = ( { last, hit } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	assert.deepEqual( last.transitions( _node ).slice( 0, 3 ), [ 'draft→confirmed', 'confirmed→closing', 'closing→closed' ] );
	assert.ok( hit[ 0 ].event.data.reason, 'the transition names why' );
	assert.equal( hit[ 0 ].stopping, true, 'the cascade marked the node before it moved (Z6)' );
	for ( const kind of [ 'strategy_scored', 'plan_accepted', 'move_started' ] ) {
		assert.equal( last.events( _node, kind ).length, 0, `no ${kind} after the cause (G-1a)` );
	}
	return _node;
};

matrix( T, [
	{
		name: 'the client aborts right at the confirmation', options: path( 'direct' ), status: 'aborted', expect: first( 'aborted' ),
		prepare: at( r => r.abort( r.root ) ),
		check: ( state ) => {
			never( state );
			assert.equal( state.root.result.reason, 'test abort' );
		},
	},
	{
		name: 'the deadline passes right at the confirmation', options: path( 'direct' ), status: 'failed', expect: first( 'failed' ),
		prepare: at( ( r, node ) => r.expire( node ) ),
		check: ( state ) => {
			never( state );
			assert.match( state.root.result.reason, /deadline/ );
			assert.ok( state.last.events( state.root, 'deadline_reached' ).length, 'the deadline is an event (18.1)' );
		},
	},
	{
		name: 'the budget is exhausted right at the confirmation', options: path( 'direct' ), status: 'failed', expect: first( 'failed' ),
		prepare: at( ( r, node ) => r.exhaust( node ) ),
		check: ( state ) => {
			never( state );
			assert.match( state.root.result.reason, /budget/ );
		},
	},
	{
		name: 'the cascade from above reaches a confirmed child', node: 'child', options: path( 'deeper' ), status: 'aborted', expect: first( 'aborted' ),
		prepare: at( r => r.abort( r.root ), 'child' ),
		check: ( state ) => {
			const _child = never( state );
			assert.match( _child.result.reason, /aborted from above/ );
			const _closed = state.last.log.since( 0, 1e6 ).filter( event => event.kind === 'state_changed' && event.data.to === 'closed' ).map( event => event.node );
			assert.ok( _closed.indexOf( _child.id ) < _closed.indexOf( state.root.id ), 'the child closes before its parent (16.5)' );
		},
	},
	{
		name: 'a child\'s own deadline passes at its confirmation', node: 'child', options: path( 'deeper' ), status: 'failed',
		expect: { ...first( 'failed' ), abort: 'aborted', abortSoon: 'aborted', abortTwice: 'aborted', abortCrash: 'aborted' },
		prepare: at( ( r, node ) => r.expire( node ), 'child' ),
		check: ( state ) => {
			const _child = never( state );
			assert.equal( _child.result.status, 'failed' );
			assert.match( _child.result.reason, /deadline/ );
		},
	},
] );
