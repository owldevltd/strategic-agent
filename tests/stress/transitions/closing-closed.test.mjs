// closing → closed (table 16.1: fulfilled when every evidence predicate holds, children closed, lesson written, budget
// booked, G6 and G4; failed or aborted when the cascade is done). Z5: closed is final, it reacts to nothing, a later
// fact is a new case. The real ways: G6 passes after U1, a failed goal after its escalation, the abort cascade, a goal
// refused at G1, a child before its parent (bottom-up), and an error that forces the node closed (18.6).
import assert from 'node:assert/strict';
import { matrix, INTERFERENCES } from './matrix.mjs';
import { path } from './paths.mjs';
import { QUANTITY } from './rig.mjs';

const T = 'closing→closed';
// Closed is final: whatever arrives, the result stays.
const final = status => Object.fromEntries( Object.keys( INTERFERENCES ).map( id => [ id, status ] ) );

// The closed node: its result is logged with the transition, nothing happened to it afterwards (Z5), the books are done.
const closed = ( { last, hit, r } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	assert.deepEqual( hit[ 0 ].event.data.result, _node.result, 'the result is logged with the transition (Z4)' );
	const _after = last.events( _node ).filter( event => event.id > hit[ 0 ].event.id );
	const _moving = [ 'state_changed', 'abort_received', 'deadline_reached', 'fact_delivered', 'fact_queued', 'verdict', 'move_started' ];
	assert.deepEqual( _after.filter( event => _moving.includes( event.kind ) ).map( event => event.kind ), [], 'closed reacts to nothing (Z5)' );
	assert.ok( r.system.journal.forNode( _node.id ).every( attempt => attempt.endedAt ), 'every attempt ended and booked (G6)' );
	return _node;
};
const refusedSpec = { criteria: [ { id: 'k1', type: 'number_in_range', values: { quantity: QUANTITY, min: 5, max: 1 } } ] };

matrix( T, [
	{
		name: 'G6 passes after U1', options: path( 'direct' ), status: 'fulfilled', expect: final( 'fulfilled' ),
		check: ( state ) => {
			closed( state );
			const _check = state.last.events( state.root, 'check' ).filter( event => event.data.gate === 'G6' ).at( -1 );
			assert.equal( _check.data.ok, true );
			assert.ok( state.last.events( state.root, 'lesson_written' ).length, 'the lesson is written before it closes (G4)' );
		},
	},
	{ name: 'a failed goal closes after its escalation', options: path( 'escalate' ), status: 'failed', expect: final( 'failed' ), check: closed },
	{
		name: 'the abort cascade closes the goal', options: path( 'other' ), status: 'aborted', expect: final( 'aborted' ),
		prepare: r => r.on( 'executing→judging', () => r.abort( r.root ), { node: 'root' } ),
		check: ( state ) => {
			closed( state );
			assert.ok( state.last.events( state.root, 'outside_cleared' ).length, 'outside actions were settled first (16.5)' );
		},
	},
	{
		name: 'a goal refused at G1 closes', options: path( 'direct' ), given: refusedSpec, status: 'refused', expect: final( 'refused' ),
		check: state => assert.deepEqual( state.last.transitions( closed( state ) ), [ 'draft→closing', 'closing→closed' ] ),
	},
	{
		// Z5: the closed child reacts to nothing, not even to its own deadline or budget.
		name: 'a child closes before its parent', node: 'child', options: path( 'deeper' ), status: 'fulfilled',
		expect: { tokens: 'failed', expire: 'fulfilled', exhaust: 'fulfilled' },
		check: ( state ) => {
			const _child = closed( state );
			assert.equal( _child.result.status, 'fulfilled', 'the child stays fulfilled, whatever reaches its parent' );
			const _report = state.last.events( state.root ).find( event => event.kind === 'child_ended' && event.data.child === _child.id
				|| ( event.kind === 'state_changed' && event.data.resumed && event.data.event === 'child_ended' ) );
			assert.ok( _report, 'the parent hears of the child\'s end: its report (2.3), or after a restart its closed state (18)' );
			assert.ok( _report.id > state.hit[ 0 ].event.id );
		},
	},
	{
		name: 'an error forces the goal closed (18.6)', options: path( 'direct' ), status: 'failed', expect: final( 'failed' ),
		prepare: ( r ) => {
			r.current().execution.run = async () => {
				throw new Error( 'a broken executor' );
			};
		},
		check: ( state ) => {
			closed( state );
			assert.ok( state.last.events( state.root, 'alarm' ).length );
		},
	},
] );
