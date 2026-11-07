import { test } from 'node:test';
import assert from 'node:assert/strict';
import { office, app } from '../office.mjs';

const quick = mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;
const withGates = ( ...gates ) => ( mission ) => {
	quick( mission );
	mission.gates = gates;
};
const refusedBy = ( o, root ) => o.events( root, 'check' ).filter( check => check.gate === 'G2' && !check.ok ).flatMap( check => check.problems );

test( '21: an order gate is checked at G2; the strategies that break it are refused, the one that keeps it runs', async () => {
	const _o = await office( { edit: withGates( { rule: 'order', before: 'survey.coverage', after: 'report.send' } ) } );
	const _root = await _o.run();
	assert.equal( _root.result.status, 'fulfilled' );
	const [ _gate ] = _o.system.gates.active( 'hr-survey' );
	assert.ok( refusedBy( _o, _root ).some( text => text.includes( `report.send may only run after survey.coverage (gate ${_gate.id})` ) ) );
	assert.ok( !_root.tried.some( item => item.strategy === 'team-report' && item.cause !== 'plan_refused' ), 'team-report never reached the gate' );
} );

test( '7.3: a precondition gate blocks the move; the judgment sees the precondition and makes it a child (U2)', async () => {
	const _gate = { rule: 'precondition', move: 'report.send', criterion: { type: 'number_in_range', values: { quantity: 'answers:design', min: 5 } } };
	const _o = await office( { strategies: [ 'team-report', 'invite-the-team', 'wait-longer' ], edit: withGates( _gate ) } );
	const _root = await _o.run();
	const [ _instance ] = _o.system.gates.active( 'hr-survey' );
	const _wall = _root.walls.find( wall => wall.cause === 'precondition_missing' );
	assert.equal( _wall.precondition.id, `gate-${_instance.id}` );
	assert.match( _wall.reason, /report.send is blocked by a strategy gate/ );
	assert.equal( _root.children[ 0 ].contract.serves.precondition, `gate-${_instance.id}` );
	assert.equal( _root.children[ 0 ].result.status, 'fulfilled' );
	assert.ok( _root.facts.some( fact => fact.kind === 'precondition_met' && fact.data.id === `gate-${_instance.id}` ) );
	assert.equal( _root.result.status, 'fulfilled', JSON.stringify( _root.result ) );
} );

test( '7.3, R5: a precondition gate that is an outcome of the goal itself makes no child that restates it; the goal is still reached', async () => {
	const _range = { quantity: 'answers:design', min: 1, max: 10000 };
	const _o = await office( { edit: ( mission ) => {
		withGates( { rule: 'precondition', move: 'report.send', criterion: { type: 'number_in_range', values: _range } } )( mission );
		mission.contract.criteria.push( { id: 'k4', type: 'number_in_range', values: _range } );
	} } );
	const _root = await _o.run();
	const _all = _root.children.flatMap( function tree( child ) { return [ child, ...child.children.flatMap( tree ) ]; } );
	assert.ok( !_all.some( child => child.result?.status === 'refused' ), JSON.stringify( _all.map( child => child.result ) ) );
	assert.equal( _root.result.status, 'fulfilled', JSON.stringify( _root.result ) );
} );

test( '21: when strategy gates leave no strategy, a person gets "check the gates" with the blocking instances; only they can lift them', async () => {
	const _asked = [];
	const _o = await office( {
		edit: withGates( { rule: 'restrict', move: 'analysis.run', param: 'teams', allowed: [ 'marketing' ] } ),
		person: ( ticket ) => {
			if ( !/Check the gates/.test( ticket.question ) ) { return ticket.recommendation; }
			_asked.push( ticket );
			return 'lift these gates and try once more';
		},
	} );
	const _root = await _o.run();
	assert.equal( _asked.length, 1 );
	assert.match( _asked[ 0 ].question, /strategy gate sg-/ );
	assert.equal( _root.result.status, 'fulfilled', 'after the person lifted the gate the goal was reached' );
	assert.deepEqual( _o.system.gates.active( 'hr-survey' ), [] );
	assert.ok( _o.log.since( 0 ).some( event => event.kind === 'strategy_gate_lifted' && event.data.by === 'test-person' ) );
} );

test( '21: a child stopped by strategy gates reports them with its wall; the parent\'s "check the gates" names them', async () => {
	const [ Judgment ] = await app.use( [ 'Core.Loop.Judgment' ] );
	const _child = { walls: [ { cause: 'plan_refused', reason: null, detail: [ 'report.send may only run after survey.coverage (gate sg-1a2b)', { gate: 'sg-1a2b' } ] } ] };
	assert.deepEqual( Judgment.gatesOf( _child ), [ 'sg-1a2b' ] );
	const _parent = { walls: [ { cause: 'child_failed', reason: null, detail: [ { id: 'n-child', status: 'failed', gates: Judgment.gatesOf( _child ) } ] } ] };
	assert.deepEqual( Judgment.gatesOf( _parent ), [ 'sg-1a2b' ] );
	const _runner = { gates: {} };
	const _node = { ..._parent, contract: { criteria: [] }, emit: () => {} };
	assert.deepEqual( new Judgment( _runner ).paralysis( _node ), [ 'strategy gate sg-1a2b' ] );
} );
