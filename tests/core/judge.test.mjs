import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';
import { office, registry, Contract, Mission } from '../office.mjs';

const [ Node, Judge ] = await use( 'Core.Node.Node', 'Core.Loop.Judge' );

function node() {
	return new Node( { contract: new Contract( Mission.load( 'survey' ).contractSpec(), registry ) } );
}

const proposing = verdict => ( { complete: async () => ( { verdict, reason: 'test' } ) } );
const judge = new Judge( { registry } );

test( 'U3: a wall of the strategy with an eligible alternative means another strategy', () => {
	const _node = node();
	_node.hitWall( 'group_too_small', [ 'only 2 people' ] );
	const _decided = judge.decide( _node, null, [ { id: 'widen-group', points: 30, reason: null } ] );
	assert.deepEqual( _decided, { verdict: 'other', rule: 'U3', overruled: false } );
} );

test( 'U3 does not hold without a positive alternative, or for a wall that is not the strategy\'s: a person decides (U4)', () => {
	const _node = node();
	_node.hitWall( 'group_too_small' );
	const _none = judge.decide( _node, { verdict: 'other' }, [ { id: 'widen-group', points: 30, reason: 'already tried for this wall' } ] );
	assert.deepEqual( _none, { verdict: 'escalate', rule: 'U4', overruled: true } );
	_node.hitWall( 'expired' );
	const _expired = judge.decide( _node, null, [ { id: 'widen-group', points: 30, reason: null } ] );
	assert.equal( _expired.verdict, 'escalate' );
} );

test( 'a proposed "done" without evidence is overruled; G6 alone decides U1', async () => {
	const _node = node();
	_node.hitWall( 'group_too_small' );
	const _overruled = await new Judge( { registry, provider: proposing( 'done' ) } ).judge( _node, {
		alternatives: [ { id: 'widen-group', points: 30, reason: null } ],
	} );
	assert.deepEqual( _overruled, { verdict: 'other', rule: 'U3', overruled: true } );
	const _receipt = { kind: 'delivered', evidenceClass: 'observation', source: 'gate', data: { action: 'report', to: 'hr' } };
	_node.addFact( _receipt );
	assert.deepEqual( judge.decide( _node, null, [] ), { verdict: 'done', rule: 'U1', overruled: false } );
	const _alternatives = [ { id: 'widen-group', points: 30, reason: null } ];
	assert.deepEqual( judge.decide( _node, { verdict: 'other' }, _alternatives ), { verdict: 'done', rule: 'U1', overruled: true },
		'when everything is proven, U1 wins over any proposal' );
	// The agent's own claim is not evidence.
	const _claimed = node();
	_claimed.addFact( { ..._receipt, evidenceClass: 'claim' } );
	assert.notEqual( judge.decide( _claimed, { verdict: 'done' }, [] ).verdict, 'done' );
} );

test( 'U2 needs a precondition of a known type that serves an open criterion and is not met yet', () => {
	const _pre = { id: 'p1', type: 'report_delivered', values: { to: 'hr', topic: 'who answered' } };
	const _node = node();
	_node.hitWall( 'precondition_missing', [], { precondition: _pre } );
	const _deeper = judge.decide( _node, null, [] );
	assert.equal( _deeper.verdict, 'deeper' );
	assert.equal( _deeper.precondition.serves, 'k1' );
	_node.addFact( { kind: 'precondition_met', evidenceClass: 'observation', source: 'child c', data: { id: 'p1' }, validUntil: new Date( Date.now() + 60000 ).toISOString() } );
	const _again = judge.decide( _node, { verdict: 'deeper' }, [] );
	assert.deepEqual( [ _again.verdict, _again.rule ], [ 'escalate', 'R8' ], 'named missing again although its evidence is valid' );
	_node.facts.at( -1 ).validUntil = new Date( Date.now() - 1000 ).toISOString();
	assert.equal( judge.decide( _node, null, [] ).verdict, 'deeper', 'evidence expired: the precondition is open again (R7, B2)' );
	const _unknown = node();
	_unknown.hitWall( 'precondition_missing', [], { precondition: { id: 'p2', type: 'invented_type' } } );
	assert.equal( judge.decide( _unknown, { verdict: 'deeper' }, [] ).verdict, 'escalate' );
	const _other = node();
	_other.hitWall( 'group_too_small' );
	const _proposed = { verdict: 'deeper', precondition: [ _pre ] };
	assert.equal( judge.decide( _other, _proposed, [] ).verdict, 'escalate', 'the model cannot turn any wall into a child' );
	const _unnamed = node();
	_unnamed.hitWall( 'precondition_missing', [], { reason: 'something is missing' } );
	assert.notEqual( judge.decide( _unnamed, _proposed, [] ).verdict, 'deeper', 'U2 takes the precondition from the wall, never from the model' );
} );

test( 'U2 makes no second child for a precondition a child already tried, nor a child that would restate an outcome (R5)', () => {
	const _pre = { id: 'p1', type: 'report_delivered', values: { to: 'hr', topic: 'who answered' } };
	const _tried = node();
	_tried.hitWall( 'precondition_missing', [], { precondition: _pre } );
	assert.equal( judge.decide( _tried, null, [] ).verdict, 'deeper', 'the first time it is a child' );
	_tried.preconditionsTried = new Set( [ 'p1' ] );
	assert.notEqual( judge.decide( _tried, null, [] ).verdict, 'deeper', 'a child tried it and did not meet it' );
	assert.notEqual( judge.decide( _tried, { verdict: 'deeper' }, [] ).verdict, 'deeper', 'not even when the model proposes it' );
	const _restating = node();
	const [ _outcome ] = _restating.contract.outcomes();
	_restating.hitWall( 'precondition_missing', [], { precondition: { id: 'gate-sg-1', type: _outcome.type, values: structuredClone( _outcome.values ) } } );
	assert.notEqual( judge.decide( _restating, { verdict: 'deeper' }, [] ).verdict, 'deeper', 'the goal\'s own outcome is no child (R5)' );
	const _other = node();
	_other.hitWall( 'precondition_missing', [], { precondition: { id: 'gate-sg-2', type: _outcome.type, values: { ..._outcome.values, to: 'ceo' } } } );
	assert.equal( judge.decide( _other, null, [] ).verdict, 'deeper', 'other values are another precondition' );
} );

test( 'U4: stuck, a person is asked; "try once more" is offered a single time, then the goal closes as failed', async () => {
	const _raw = [ {
		id: 'read-raw', serves: 'report_delivered', cost: 1, startCurve: { p0: 0.9, tauH: 1 },
		steps: [
			{ move: 'survey.rows', params: { teams: [ 'design' ] }, as: 'rows' },
			{ move: 'report.draft', from: [ 'rows' ], as: 'report' },
			{ move: 'report.send', from: 'report', target: 'hr' },
		],
	} ];
	const _asked = [];
	const _person = ( ticket ) => {
		_asked.push( ticket.options );
		return ticket.options[ 0 ];
	};
	const { run } = await office( { strategies: _raw, person: _person, by: 'hr-lead' } );
	const _node = await run();
	assert.deepEqual( _asked, [ [ 'try once more', 'close as failed' ], [ 'close as failed' ] ] );
	assert.equal( _node.result.status, 'failed' );
	assert.match( _node.result.reason, /closed by hr-lead after escalation/ );
	assert.deepEqual( _node.walls.map( wall => wall.cause ), [ 'plan_refused', 'plan_refused' ] );
} );

test( 'U2: a missing precondition becomes a child on the same route; once it is met the strategy runs again', async () => {
	const { run, log, executor } = await office( { strategies: [ 'team-report', 'widen-group' ] } );
	// The first analysis of the root reports, as trusted code, that it depends on something not there yet.
	const _run = executor.run.bind( executor );
	let _reported = false;
	executor.run = async ( step, ctx ) => {
		if ( !_reported && !ctx.node.parent && step.move === 'analysis.run' ) {
			_reported = true;
			const _pre = { id: 'roster-report', type: 'report_delivered', values: { to: 'hr', topic: 'who belongs to which team' } };
			return { wall: { cause: 'precondition_missing', precondition: _pre, reason: 'the roster is not confirmed' } };
		}
		return _run( step, ctx );
	};
	const _node = await run();
	assert.equal( _node.result.status, 'fulfilled', JSON.stringify( _node.result ) );
	assert.equal( _node.children.length, 1 );
	const [ _child ] = _node.children;
	assert.equal( _child.result.status, 'fulfilled', JSON.stringify( _child.result ) );
	assert.match( _child.contract.id, /^survey-design.*\/roster-report$/ );
	assert.deepEqual( _child.contract.serves, { criterion: 'k1', precondition: 'roster-report' } );
	// The child inherits every invariant of its parent.
	assert.deepEqual( _child.contract.invariants().map( item => item.type ).sort(), [ 'min_group', 'no_difference' ] );
	assert.ok( _node.facts.some( fact => fact.kind === 'precondition_met' ) );
	const _verdicts = log.forNode( _node.id ).filter( event => event.kind === 'verdict' ).map( event => event.data.verdict );
	assert.equal( _verdicts[ 0 ], 'deeper' );
} );

test( '16.4: the wall report carries a suggestion, the model\'s or else the catalog\'s', async () => {
	const _node = node();
	_node.hitWall( 'group_too_small', [ 'only 2 people' ] );
	await new Judge( { registry } ).judge( _node, { alternatives: [] } );
	assert.match( _node.walls[ 0 ].suggestion, /larger group/ );
} );

test( 'U4 is "every other case": a proposed escalation does not stand while U2 or U3 applies', () => {
	const _node = node();
	_node.hitWall( 'precondition_missing', [], { precondition: { id: 'p9', type: 'report_delivered', values: { to: 'hr', topic: 'answers' } } } );
	const _decided = judge.decide( _node, { verdict: 'escalate' }, [] );
	assert.deepEqual( [ _decided.verdict, _decided.rule, _decided.overruled ], [ 'deeper', 'U2', true ] );
} );
