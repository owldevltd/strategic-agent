// draft → closing (table 16.1: a goal that never became a confirmed node closes at once, with the reason; for a child
// also the refusals of R1, R2, P4 and G-1a). Every real way: G1 finds a problem, the person never confirms before the
// deadline, the client aborts before the confirmation, an error at the gate, and a child that may not start (depth,
// start tokens, budget, its parent being aborted). Each crossed with what can cut in during the refusal.
import assert from 'node:assert/strict';
import { matrix } from './matrix.mjs';
import { path } from './paths.mjs';
import { QUANTITY } from './rig.mjs';

const T = 'draft→closing';
const range = ( id, values ) => ( { id, type: 'number_in_range', values: { quantity: QUANTITY, ...values } } );

// The refused node: closed with its reason, never planned or judged, no token burnt for it (R1).
const refused = status => ( { last, hit, root } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	assert.equal( _node.state, 'closed' );
	assert.ok( [].concat( status ).includes( _node.result.status ), JSON.stringify( _node.result ) );
	assert.ok( hit[ 0 ].event.data.reason, 'the refusal names its reason' );
	assert.deepEqual( last.transitions( _node ), [ 'draft→closing', 'closing→closed' ], 'never planned, never judged' );
	assert.equal( last.events( _node, 'plan_accepted' ).length, 0, 'no token burnt for it (R1)' );
	if ( _node === root ) {
		assert.equal( last.gateDb.get( 'SELECT COUNT(*) AS n FROM deliveries' ).n, 0, 'nothing reached the gate' );
	}
};
const g1 = ( name, given, problem ) => ( {
	name: `G1 refuses the goal: ${name}`, options: path( 'direct' ), given, status: 'refused', only: [ 'none', 'abort', 'crash', 'late', 'tokens' ],
	expect: { abort: 'refused' },
	check: ( state ) => {
		refused( 'refused' )( state );
		assert.ok( state.root.result.problems.some( text => problem.test( text ) ), JSON.stringify( state.root.result.problems ) );
	},
} );
const CHILD = [ 'none', 'abort', 'crash', 'late' ];

matrix( T, [
	g1( 'its deadline is in the past', { deadlineMs: -60000 }, /deadline is in the past/ ),
	g1( 'an unknown criterion type', { criteria: [ range( 'k1', { min: 1 } ), { id: 'k2', type: 'invented_type', values: {} } ] }, /unknown criterion type/ ),
	g1( 'the budget is below the cheapest way', { budget: 0.5 }, /below the cheapest way/ ),
	g1( 'an empty range (K6)', { criteria: [ range( 'k1', { min: 5, max: 1 } ) ] }, /range is empty/ ),
	g1( 'two criteria with one id', { criteria: [ range( 'k1', { min: 1 } ), range( 'k1', { min: 2 } ) ] }, /duplicate criterion id/ ),
	g1( 'only a criterion of the agent describes the effect', { criteria: [ { ...range( 'k1', { min: 1 } ), origin: 'agent', serves: 'k0' } ] },
		/the client's own outcome is missing/ ),
	{
		// 16.3: a deadline ends a goal as failed; only the client or the cascade from above aborts it.
		// The gate answers slowly, so the deadline's own timer is always first (as it is when the gate is a process of its own).
		name: 'the person never confirms before the deadline', options: path( 'direct', { confirm: () => false } ), given: { deadlineMs: 120 },
		prepare: ( r ) => {
			const _gate = r.current().gate;
			const _contract = r.egress.store.contract.bind( r.egress.store );
			_gate.contract = hash => new Promise( resolve => setTimeout( () => resolve( _contract( hash ) ), 150 ) );
		},
		status: [ 'expired', 'failed' ], only: [ 'none', 'abort', 'late', 'expire', 'crash' ], expect: { abort: [ 'expired', 'failed' ], expire: [ 'expired', 'failed' ] },
		check: refused( [ 'expired', 'failed' ] ),
	},
	{
		name: 'the client aborts before the person confirms', options: path( 'direct', { confirm: () => false } ), status: 'aborted',
		only: [ 'none', 'late', 'crash', 'tokens', 'abortTwice' ],
		prepare: r => r.onEvent( 'contract_proposed', () => setTimeout( () => r.abort( r.root ), 20 ) ), check: refused( 'aborted' ),
	},
	{
		name: 'the gate cannot take the proposal (an error in the core, 18.6)', status: 'failed', only: [ 'none', 'abort', 'crash', 'late', 'expire' ],
		expect: { abort: 'failed' },
		options: path( 'direct' ), prepare: ( r ) => {
			r.current().gate.propose = async () => {
				throw new Error( 'the gate is unreachable' );
			};
		},
		check: ( state ) => {
			refused( 'failed' )( state );
			assert.ok( state.last.events( state.root, 'alarm' ).length, 'a person is alarmed' );
			assert.ok( state.last.events( state.root, 'abort_received' ).length, 'the error starts the cascade (16.5)' );
		},
	},
	{
		name: 'a child deeper than the maximum depth (R2)', node: 'child', options: path( 'deeper' ), status: 'failed', only: CHILD,
		prepare: ( r ) => {
			r.current().maxDepth = 0;
		},
		check: refused( 'refused' ),
	},
	{
		name: 'a child when no start token is left (R1)', node: 'child', options: path( 'deeper' ), status: 'failed', only: CHILD,
		prepare: r => r.on( 'judging→planning', () => r.noTokens() ), check: refused( 'refused' ),
	},
	{
		name: 'a child whose parent cannot reserve its budget (P4)', node: 'child', options: path( 'deeper' ), given: { budget: 1.5 }, status: 'failed',
		only: CHILD, check: refused( 'refused' ),
	},
	{
		name: 'a child whose parent is being aborted (G-1a)', node: 'child', options: path( 'deeper' ), status: 'aborted', only: CHILD,
		prepare: r => r.on( 'planning→executing', () => r.abort( r.root ), { nth: 2 } ), check: refused( 'refused' ),
	},
] );
