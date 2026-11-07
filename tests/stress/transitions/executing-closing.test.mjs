// executing → closing (table 16.1: from every state but the final ones; deadline, budget and abort come first, Z6,
// and no move starts after them, G-1a). The real ways: the client aborts, the deadline passes or the budget runs out
// as the plan is accepted; the deadline or the budget ends between two moves; an error in the core while executing
// (18.6); and the cascade from above reaches a child as its plan is accepted.
import assert from 'node:assert/strict';
import { matrix, INTERFERENCES } from './matrix.mjs';
import { path } from './paths.mjs';
import { strategy, out } from './rig.mjs';

const T = 'executing→closing';
const first = status => Object.fromEntries( Object.keys( INTERFERENCES ).map( id => [ id, status ] ) );
const TWO = path( 'direct', { strategies: [ strategy( 'alpha', [ 'stress.probe', 'stress.measure' ] ) ], script: { 'stress.probe': [ out.none() ], 'stress.measure': [ out.fact() ] } } );

// After the cause no move started; the open attempt ended in the journal, booked as a wall (16.3: books and budget).
const stopped = ( { last, hit, r } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	const _after = last.events( _node ).filter( event => event.id > hit[ 0 ].event.id );
	assert.ok( !_after.some( event => event.kind === 'move_started' && event.data.move !== 'move.cancel' ), 'no move after it (G-1a)' );
	const _attempts = r.system.journal.forNode( _node.id );
	assert.ok( _attempts.length && _attempts.every( attempt => attempt.endedAt ), 'the open attempt is ended and booked' );
	assert.ok( _attempts.every( attempt => attempt.outcome !== 'done' ), 'an attempt cut off is no success' );
	return _node;
};
const at = ( cause, node = 'root' ) => r => r.on( 'planning→executing', target => cause( r, target ), { node } );
const between = cause => r => r.onEvent( 'move_ended', target => cause( r, target ), { node: 'root' } );

matrix( T, [
	{
		name: 'the client aborts as the plan is accepted', options: path( 'direct' ), status: 'aborted', expect: first( 'aborted' ),
		prepare: at( r => r.abort( r.root ) ), check: stopped,
	},
	{
		name: 'the deadline passes as the plan is accepted', options: path( 'direct' ), status: 'failed', expect: first( 'failed' ),
		prepare: at( ( r, node ) => r.expire( node ) ),
		check: ( state ) => {
			stopped( state );
			assert.match( state.root.result.reason, /deadline/ );
		},
	},
	{
		name: 'the deadline passes between two moves (Z6)', options: TWO, status: 'failed', expect: first( 'failed' ),
		prepare: between( ( r, node ) => r.expire( node ) ),
		check: ( state ) => {
			stopped( state );
			assert.equal( state.last.events( state.root, 'move_started' ).filter( event => event.data.move === 'stress.measure' ).length, 0 );
		},
	},
	{
		name: 'the budget runs out between two moves (Z6)', options: TWO, status: 'failed', expect: first( 'failed' ),
		prepare: between( ( r, node ) => r.exhaust( node ) ),
		check: ( state ) => {
			stopped( state );
			assert.match( state.root.result.reason, /budget/ );
		},
	},
	{
		name: 'an error in the core while executing (18.6)', options: path( 'direct' ), status: 'failed', expect: first( 'failed' ),
		prepare: ( r ) => {
			r.current().execution.run = async () => {
				throw new Error( 'a broken executor' );
			};
		},
		check: ( state ) => {
			stopped( state );
			assert.ok( state.last.events( state.root, 'alarm' ).length, 'a person is alarmed' );
		},
	},
	{
		name: 'the client aborts while a move runs', status: 'aborted', expect: first( 'aborted' ),
		options: path( 'direct', { script: { 'stress.measure': [ out.after( 20, out.fact() ) ] } } ),
		prepare: r => r.onEvent( 'move_started', () => setImmediate( () => r.abort( r.root ) ), { node: 'root' } ),
		check: ( state ) => {
			stopped( state );
			assert.ok( state.last.events( state.root, 'move_ended' ).length <= 1, 'the running move was not started again' );
		},
	},
	{
		name: 'the cascade from above reaches a child as its plan is accepted', node: 'child', options: path( 'deeper' ), status: 'aborted',
		expect: first( 'aborted' ), prepare: at( r => r.abort( r.root ), 'child' ),
		check: state => assert.match( stopped( state ).result.reason, /aborted from above/ ),
	},
] );
