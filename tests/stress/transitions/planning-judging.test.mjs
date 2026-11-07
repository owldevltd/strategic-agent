// planning → judging (table 16.1: no eligible strategy; the verdict is "escalate"). The real ways: the only strategy
// just hit its wall, the same with a person who says "try once more", no strategy fits the budget left, the deadline
// leaves every strategy too little chance (θ), and a child with no way left that escalates to its parent (8.4).
import assert from 'node:assert/strict';
import { matrix } from './matrix.mjs';
import { path, ALPHA, P1 } from './paths.mjs';
import { strategy, out } from './rig.mjs';

const T = 'planning→judging';

// Stuck: nothing was started in between, the reason is logged, and the judgment escalates (U4) or a person decides.
const stuck = ( { last, hit } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	assert.equal( hit[ 0 ].event.data.reason, 'no eligible strategy left' );
	const _events = last.events( _node );
	const _at = _events.findIndex( event => event.id === hit[ 0 ].event.id );
	const _scored = [ ..._events.slice( 0, _at ) ].reverse().find( event => event.kind === 'strategy_scored' );
	assert.ok( _scored.data.scored.every( item => item.reason ), 'every strategy had a reason not to be chosen' );
	assert.ok( !_events.slice( _at ).some( event => event.kind === 'plan_accepted' && event.id < ( _events[ _at + 1 ]?.id ?? Infinity ) ) );
	return _node;
};
const escalated = ( state ) => {
	const _node = stuck( state );
	const _verdicts = state.last.events( _node, 'verdict' ).filter( event => event.id > state.hit[ 0 ].event.id ).map( event => event.data.verdict );
	if ( !_node.parent && state.id === 'none' ) { assert.equal( _verdicts[ 0 ], 'escalate', 'stuck: a person decides (U4)' ); }
	return _node;
};
const TIGHT = [ ALPHA, strategy( 'beta', [ 'stress.measure' ], { class: 'widen', price: 5 } ) ];
const SLOW = strategy( 'alpha', [ 'stress.measure' ], { startCurve: { p0: 0.9, tauH: 1000 } } );

matrix( T, [
	{
		name: 'the only strategy just hit its wall', options: path( 'escalate' ), status: 'failed', expect: { late: 'fulfilled', twice: 'fulfilled' },
		check: escalated,
	},
	{
		name: 'the only strategy hit its wall and the person says "try once more"', options: path( 'retry' ), status: 'fulfilled',
		expect: { tokens: 'failed' },
		check: ( state ) => {
			escalated( state );
			if ( state.id === 'none' ) { assert.ok( state.last.transitions( state.root ).includes( 'waiting→judging' ) ); }
		},
	},
	{
		name: 'no other strategy fits the budget left', options: path( 'other', { strategies: TIGHT, script: { 'stress.measure': [ out.wall( 'not_reached' ) ] } } ),
		given: { budget: 4 }, status: 'failed', expect: { late: 'fulfilled', twice: 'fulfilled' },
		check: ( state ) => {
			const _node = escalated( state );
			assert.ok( state.last.events( _node, 'strategy_scored' ).some( event => event.data.scored.some( item => item.reason === 'over budget' ) ) );
		},
	},
	{
		name: 'the deadline leaves every strategy too little chance (θ)', options: path( 'direct', { strategies: [ SLOW ] } ), status: 'failed',
		expect: { late: 'fulfilled', twice: 'fulfilled' },
		check: ( state ) => {
			const _node = escalated( state );
			assert.equal( state.last.events( _node, 'plan_accepted' ).length, 0, 'nothing was started' );
			assert.ok( state.last.events( _node, 'strategy_scored' )[ 0 ].data.scored.every( item => item.reason === 'chance below θ' ) );
		},
	},
	{
		name: 'a child with no way left escalates to its parent (8.4)', node: 'child', status: 'failed',
		options: { strategies: [ ALPHA ], script: { 'stress.measure@0': [ out.wall( 'precondition_missing', P1 ), out.fact() ], 'stress.measure@1': [ out.wall( 'not_reached' ) ] } },
		check: ( state ) => {
			const _child = stuck( state );
			assert.equal( _child.result.status, [ 'abort', 'abortSoon', 'abortTwice', 'abortCrash', 'failed' ].includes( state.id ) ? 'aborted' : 'failed', 'from above: aborted' );
			assert.ok( state.last.events( _child, 'ticket_to_parent' ).length || _child.result.status === 'aborted' || state.id !== 'none' );
			assert.ok( !state.last.events( _child, 'ticket_opened' ).some( event => event.data.to === 'client' ), 'a child asks its parent, not a person' );
		},
	},
] );
