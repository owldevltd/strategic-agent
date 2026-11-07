// core/strategy/chooser.js, part 2: walls, diagnosis and open attempts (4.3, 5.6, 19, U3). Without a wall only the
// direct way; with a wall only the classes its diagnosis names, the first hypothesis first and a cheap probe before
// the large strategy; never a strategy with an open attempt for the same criterion, the one that just ended, or one
// G2 refused. A lesson only orders the allowed strategies; it never allows one (G-9).
import assert from 'node:assert/strict';
import { attack } from '../hostile.mjs';
import { Chooser, Diagnosis, nodeOf, strategy, survey } from './fixtures.mjs';

const SUBJECT = 'core/strategy/chooser.js';
const NOW = Date.now();
const DIAGNOSIS = Diagnosis.load( survey );
const choose = ( node, list, options = {} ) => new Chooser().choose( node, list, { now: NOW, diagnosis: DIAGNOSIS, ...options } );
const scored = ( result, id ) => result.scored.find( item => item.id === id );
const walled = ( ...causes ) => {
	const _node = nodeOf();
	causes.forEach( cause => _node.hitWall( cause, [] ) );
	return _node;
};
const CLASSES = [ strategy( 'direct' ), strategy( 'ask', { class: 'ask_more' } ), strategy( 'widen', { class: 'widen' } ), strategy( 'decline', { class: 'decline' } ) ];

attack( SUBJECT, 'without a wall only the direct way is eligible (4.3)', () => {
	const _result = choose( nodeOf(), CLASSES );
	assert.equal( _result.chosen.id, 'direct' );
	assert.deepEqual( [ 'ask', 'widen', 'decline' ].map( id => scored( _result, id ).reason ), [ 'not the direct way', 'not the direct way', 'not the direct way' ] );
} );

attack( SUBJECT, 'a strategy of several classes counts as direct without a wall', () => {
	assert.equal( choose( nodeOf(), [ strategy( 'both', { class: [ 'decline', 'direct' ] } ) ] ).chosen.id, 'both' );
} );

attack( SUBJECT, 'a wall leads to the classes of its diagnosis, the first hypothesis first (5.6)', () => {
	const _result = choose( walled( 'group_too_small' ), CLASSES );
	assert.equal( _result.wall, 'group_too_small' );
	assert.deepEqual( [ 'ask', 'widen', 'decline' ].map( id => scored( _result, id ).rank ), [ 0, 1, 2 ] );
	assert.equal( _result.chosen.id, 'ask' );
} );

attack( SUBJECT, 'with a wall the direct way is refused unless the diagnosis names it', () => {
	assert.match( scored( choose( walled( 'group_too_small' ), CLASSES ), 'direct' ).reason, /diagnosis of the wall does not lead to this class/ );
} );

attack( SUBJECT, 'a strategy of several classes takes the best rank among them', () => {
	const _result = choose( walled( 'group_too_small' ), [ strategy( 'mixed', { class: [ 'decline', 'ask_more' ] } ), strategy( 'widen', { class: 'widen' } ) ] );
	assert.equal( scored( _result, 'mixed' ).rank, 0 );
	assert.equal( _result.chosen.id, 'mixed' );
} );

attack( SUBJECT, 'a strategy with an empty class list is never eligible', () => {
	assert.equal( scored( choose( nodeOf(), [ strategy( 'none', { class: [] } ) ] ), 'none' ).reason, 'not the direct way' );
	assert.equal( scored( choose( walled( 'plan_refused' ), [ strategy( 'none', { class: [] } ) ] ), 'none' ).rank, -1 );
} );

attack( SUBJECT, 'a wildcard hypothesis admits every other class at its place; the direct way comes half a step later', () => {
	const _result = choose( walled( 'plan_refused' ), [ strategy( 'direct', { price: 0 } ), strategy( 'other', { class: 'widen', price: 9 } ) ] );
	assert.deepEqual( [ scored( _result, 'other' ).rank, scored( _result, 'direct' ).rank ], [ 0, 0.5 ] );
	assert.equal( _result.chosen.id, 'other', 'another way first, even with fewer points' );
} );

attack( SUBJECT, 'the rank beats the points: the first hypothesis wins over a better-scoring later one', () => {
	const _ask = strategy( 'ask', { class: 'ask_more', price: 10, startCurve: { p0: 0.3, tauH: 0.001 } } );
	const _widen = strategy( 'widen', { class: 'widen', price: 0, startCurve: { p0: 1, tauH: 0.001 } } );
	const _result = choose( walled( 'group_too_small' ), [ _widen, _ask ] );
	assert.ok( scored( _result, 'widen' ).points > scored( _result, 'ask' ).points );
	assert.equal( _result.chosen.id, 'ask' );
} );

attack( SUBJECT, 'a cheap probe goes before the large strategy of its class, even with fewer points', () => {
	const _probe = strategy( 'probe', { class: 'widen', probe: true, startCurve: { p0: 0.3, tauH: 0.001 } } );
	const _result = choose( walled( 'difference_too_small' ), [ strategy( 'widen', { class: 'widen' } ), _probe ] );
	assert.ok( scored( _result, 'probe' ).points < scored( _result, 'widen' ).points );
	assert.equal( _result.chosen.id, 'probe' );
} );

attack( SUBJECT, 'a probe of a later hypothesis does not jump ahead of the first hypothesis', () => {
	const _probe = strategy( 'probe', { class: 'decline', probe: true } );
	assert.equal( choose( walled( 'group_too_small' ), [ _probe, strategy( 'ask', { class: 'ask_more' } ) ] ).chosen.id, 'ask' );
} );

attack( SUBJECT, 'a wall the diagnosis cannot read is undiagnosed and chooses nothing', () => {
	const _result = choose( walled( 'calendar_full' ), CLASSES );
	assert.deepEqual( [ _result.chosen, _result.undiagnosed ], [ null, true ] );
	assert.ok( _result.scored.every( item => item.rank === -1 ) );
} );

attack( SUBJECT, 'without a diagnosis every wall is undiagnosed', () => {
	const _result = new Chooser().choose( walled( 'group_too_small' ), CLASSES, { now: NOW } );
	assert.deepEqual( [ _result.chosen, _result.undiagnosed ], [ null, true ] );
} );

attack( SUBJECT, 'a decision a person made is learned and makes the unknown wall readable', () => {
	const _learned = new Diagnosis( DIAGNOSIS.causes, [ { cause: 'calendar_full', class: 'widen', by: 'hr-lead' } ] );
	const _result = choose( walled( 'calendar_full' ), CLASSES, { diagnosis: _learned } );
	assert.deepEqual( [ _result.chosen.id, _result.undiagnosed ], [ 'widen', false ] );
} );

attack( SUBJECT, 'a learned class never makes a strategy eligible that θ, the budget or its kind refuse (G-9)', () => {
	const _learned = new Diagnosis( {}, [ { cause: 'calendar_full', class: 'widen', by: 'hr-lead' } ] );
	const _list = [
		strategy( 'weak', { class: 'widen', startCurve: { p0: 0.05, tauH: 0.001 } } ), strategy( 'dear', { class: 'widen', price: 99 } ),
		strategy( 'foreign', { class: 'widen', kind: 'supplier-payments' } ),
	];
	const _result = choose( walled( 'calendar_full' ), _list, { diagnosis: _learned, budgetLeft: 10 } );
	assert.equal( _result.chosen, null );
	assert.deepEqual( _result.scored.map( item => item.reason ), [ 'chance below θ', 'over budget', 'meant for another kind of goal' ] );
} );

attack( SUBJECT, 'a learned class that no strategy has leads nowhere', () => {
	const _learned = new Diagnosis( {}, [ { cause: 'calendar_full', class: 'pay_everyone', by: 'x' } ] );
	const _result = choose( walled( 'calendar_full' ), CLASSES, { diagnosis: _learned } );
	assert.deepEqual( [ _result.chosen, _result.undiagnosed ], [ null, false ] );
} );

attack( SUBJECT, 'a wall named like an Object.prototype member is undiagnosed, not a crash', () => {
	const _result = choose( walled( 'constructor' ), CLASSES );
	assert.deepEqual( [ _result.chosen, _result.undiagnosed ], [ null, true ] );
} );

// The current wall (R7, restart).

attack( SUBJECT, 'an interrupted move is no wall of the strategy', () => {
	const _node = walled( 'interrupted' );
	assert.equal( Chooser.currentWall( _node ), null );
	assert.equal( choose( _node, CLASSES ).chosen.id, 'direct' );
} );

attack( SUBJECT, 'the latest wall counts', () => {
	assert.equal( Chooser.currentWall( walled( 'group_too_small', 'difference_too_small' ) ), 'difference_too_small' );
	assert.equal( Chooser.currentWall( walled( 'difference_too_small', 'interrupted' ) ), 'difference_too_small' );
} );

attack( SUBJECT, 'a missing precondition a child has met is no wall any more; the wall before it counts again', () => {
	const _node = walled( 'group_too_small' );
	_node.hitWall( 'precondition_missing', [], { precondition: { id: 'answers-design' } } );
	assert.equal( Chooser.currentWall( _node ), 'precondition_missing' );
	_node.addFact( { kind: 'precondition_met', evidenceClass: 'observation', source: 'child', data: { id: 'answers-design' } } );
	assert.equal( Chooser.currentWall( _node ), 'group_too_small' );
} );

attack( SUBJECT, 'a precondition a child already went after is no wall any more', () => {
	const _node = nodeOf();
	_node.hitWall( 'precondition_missing', [], { precondition: { id: 'p1' } } );
	_node.preconditionsTried = new Set( [ 'p1' ] );
	assert.equal( Chooser.currentWall( _node ), null );
} );

// 5.6: a precondition child that failed is the wall the next strategy answers; seen live in a supplier onboarding
// and an offsite, where the mission's diagnosis of child_failed was never read and only direct strategies could run.
attack( SUBJECT, '5.6: a precondition child that was tried and failed is the current wall, so its diagnosis leads on', () => {
	const _node = nodeOf();
	_node.hitWall( 'precondition_missing', [], { precondition: { id: 'verify-okoro' } } );
	_node.preconditionsTried = new Set( [ 'verify-okoro' ] );
	_node.hitWall( 'child_failed', [ { id: 'c1', status: 'failed' } ], { precondition: { id: 'verify-okoro' } } );
	assert.equal( Chooser.currentWall( _node ), 'child_failed' );
} );

attack( SUBJECT, '5.6: after the failed child, the class its diagnosis names is chosen, not only the direct way', () => {
	const _node = nodeOf();
	_node.hitWall( 'precondition_missing', [], { precondition: { id: 'verify-okoro' } } );
	_node.preconditionsTried = new Set( [ 'verify-okoro' ] );
	_node.hitWall( 'child_failed', [ { id: 'c1', status: 'failed' } ], { precondition: { id: 'verify-okoro' } } );
	const _diagnosis = new Diagnosis( JSON.parse( '{"child_failed":[{"hypothesis":"the_precondition_is_out_of_reach","class":"hand_over"}]}' ) );
	const _strategies = [ { id: 'pay', serves: 'report_delivered', class: 'direct', price: 1 }, { id: 'to-purchasing', serves: 'report_delivered', class: 'hand_over', price: 1 } ];
	assert.equal( new Chooser().choose( _node, _strategies, { diagnosis: _diagnosis } ).chosen?.id, 'to-purchasing' );
} );

attack( SUBJECT, 'a failed child whose precondition has since been met is no wall any more', () => {
	const _node = nodeOf();
	_node.hitWall( 'child_failed', [], { precondition: { id: 'p2' } } );
	assert.equal( Chooser.currentWall( _node ), 'child_failed' );
	_node.addFact( { kind: 'precondition_met', evidenceClass: 'observation', source: 'child', data: { id: 'p2' } } );
	assert.equal( Chooser.currentWall( _node ), null );
} );

// Open attempts, U3 and G2 (19).

attack( SUBJECT, 'an open attempt of a strategy for the same criterion blocks it', () => {
	const _result = choose( nodeOf(), [ strategy( 'a' ) ], { open: [ { strategy: 'a', criterion: 'k1' } ] } );
	assert.equal( scored( _result, 'a' ).reason, 'an attempt of it is still open' );
} );

attack( SUBJECT, 'an open attempt of the strategy for another criterion does not block it', () => {
	assert.equal( choose( nodeOf(), [ strategy( 'a' ) ], { open: [ { strategy: 'a', criterion: 'k9' } ] } ).chosen.id, 'a' );
} );

attack( SUBJECT, 'an open attempt that names no criterion blocks the strategy for every criterion', () => {
	assert.equal( choose( nodeOf(), [ strategy( 'a' ) ], { open: [ { strategy: 'a' } ] } ).chosen, null );
} );

attack( SUBJECT, 'an open attempt of another strategy blocks nothing', () => {
	assert.equal( choose( nodeOf(), [ strategy( 'a' ) ], { open: [ { strategy: 'b', criterion: 'k1' } ] } ).chosen.id, 'a' );
} );

attack( SUBJECT, 'the node\'s own open plan blocks its strategy; a closed plan does not', () => {
	const _node = nodeOf();
	_node.plan = { open: true, strategy: 'a' };
	assert.equal( choose( _node, [ strategy( 'a' ) ] ).chosen, null );
	_node.plan.open = false;
	assert.equal( choose( _node, [ strategy( 'a' ) ] ).chosen.id, 'a' );
} );

attack( SUBJECT, 'the strategy that just ended is excluded; another one is chosen (U3)', () => {
	const _result = choose( nodeOf(), [ strategy( 'a', { price: 0 } ), strategy( 'b', { price: 5 } ) ], { exclude: 'a' } );
	assert.match( scored( _result, 'a' ).reason, /another way means another strategy/ );
	assert.equal( _result.chosen.id, 'b' );
} );

attack( SUBJECT, 'excluding an id that is not in the catalog changes nothing', () => {
	assert.equal( choose( nodeOf(), [ strategy( 'a' ) ], { exclude: 'zzz' } ).chosen.id, 'a' );
} );

attack( SUBJECT, 'a strategy whose plan G2 refused is not eligible again for this node', () => {
	const _node = nodeOf();
	_node.refused = new Set( [ 'a' ] );
	const _result = choose( _node, [ strategy( 'a', { price: 0 } ), strategy( 'b' ) ] );
	assert.equal( scored( _result, 'a' ).reason, 'G2 refused its plan' );
	assert.equal( _result.chosen.id, 'b' );
} );

attack( SUBJECT, 'when every strategy is refused nothing is chosen and each one says why', () => {
	const _node = nodeOf();
	_node.refused = new Set( [ 'a' ] );
	const _list = [ strategy( 'a' ), strategy( 'b' ), strategy( 'c', { price: 99 } ), strategy( 'd', { serves: 'x' } ), strategy( 'e', { class: 'widen' } ) ];
	const _result = choose( _node, _list, { exclude: 'b', budgetLeft: 10 } );
	assert.equal( _result.chosen, null );
	assert.deepEqual( _result.scored.map( item => item.reason ), [
		'G2 refused its plan', 'just tried; another way means another strategy', 'over budget', 'serves no open outcome', 'not the direct way',
	] );
} );

attack( SUBJECT, 'the order of the checks: serving an open outcome comes before every other reason', () => {
	const _node = nodeOf();
	_node.refused = new Set( [ 'x' ] );
	const _result = choose( _node, [ strategy( 'x', { serves: 'nothing', depth: 9, kind: 'k', price: 1e9 } ) ], { exclude: 'x', budgetLeft: 0 } );
	assert.equal( scored( _result, 'x' ).reason, 'serves no open outcome' );
} );

attack( SUBJECT, 'the survey catalog: a group that is too small leads to asking the team first, then widening', () => {
	const _node = nodeOf( { kind: 'hr-survey' } );
	_node.hitWall( 'group_too_small', [ 'only three answers' ] );
	const _first = choose( _node, survey.strategies );
	assert.equal( _first.chosen.id, 'ask-the-team' );
	assert.equal( choose( _node, survey.strategies, { exclude: 'ask-the-team' } ).chosen.id, 'widen-group' );
} );

attack( SUBJECT, 'the choice is the same for the same node, catalog and options', () => {
	const _node = walled( 'group_too_small' );
	const _runs = Array.from( { length: 4 }, () => JSON.stringify( choose( _node, CLASSES, { exclude: 'ask' } ) ) );
	assert.equal( new Set( _runs ).size, 1 );
} );

// U3 means another way, not the way back: a strategy chosen to answer the current wall that ran into it again is not
// chosen for it again, or two strategies would take turns at the same wall until every start token is spent.

attack( SUBJECT, 'U3: the choice never alternates between strategies that already hit the same wall', () => {
	const _node = walled( 'group_too_small' );
	const _chosen = [];
	for ( let round = 0; round < 8; round++ ) {
		const _result = choose( _node, CLASSES, { exclude: _node.tried.at( -1 )?.strategy || null } );
		if ( !_result.chosen ) { break; }
		_chosen.push( _result.chosen.id );
		_node.tried.push( { strategy: _result.chosen.id, wall: 'group_too_small', outcome: 'wall', cause: 'group_too_small' } );
	}
	assert.deepEqual( _chosen, [ 'ask', 'widen', 'decline' ], 'each way once, then nothing is eligible and the judgment escalates' );
	const _last = choose( _node, CLASSES, { exclude: 'decline' } );
	assert.deepEqual( [ 'ask', 'widen' ].map( id => scored( _last, id ).reason ), [ 'it already hit this wall', 'it already hit this wall' ] );
} );

attack( SUBJECT, 'U3: alpha → beta → alpha is refused even when alpha has the most points', () => {
	const _alpha = strategy( 'alpha', { class: 'ask_more', price: 0 } );
	const _beta = strategy( 'beta', { class: 'ask_more', price: 5 } );
	const _node = walled( 'group_too_small' );
	_node.tried.push( { strategy: 'alpha', wall: 'group_too_small', cause: 'group_too_small', outcome: 'wall' },
		{ strategy: 'beta', wall: 'group_too_small', cause: 'group_too_small', outcome: 'wall' } );
	const _result = choose( _node, [ _alpha, _beta ], { exclude: 'beta' } );
	assert.equal( _result.chosen, null );
	assert.equal( scored( _result, 'alpha' ).reason, 'it already hit this wall' );
} );

attack( SUBJECT, 'U3: the way that ran into the wall before it was the wall may answer it once, never twice', () => {
	const _both = strategy( 'both', { class: [ 'direct', 'ask_more' ] } );
	const _node = walled( 'group_too_small' );
	_node.tried.push( { strategy: 'both', wall: null, cause: 'group_too_small', outcome: 'wall' } );
	assert.equal( choose( _node, [ _both ] ).chosen.id, 'both' );
	_node.tried.push( { strategy: 'both', wall: 'group_too_small', cause: 'group_too_small', outcome: 'wall' } );
	assert.equal( scored( choose( _node, [ _both ] ), 'both' ).reason, 'it already hit this wall' );
} );

attack( SUBJECT, 'U3: a strategy that hit another wall may still answer this one', () => {
	const _node = walled( 'no_reaction', 'group_too_small' );
	_node.tried.push( { strategy: 'ask', wall: 'no_reaction', cause: 'no_reaction', outcome: 'wall' }, { strategy: 'ask', wall: 'group_too_small', outcome: 'done', cause: null } );
	assert.equal( choose( _node, CLASSES ).chosen.id, 'ask' );
} );

attack( SUBJECT, 'U3: after a person asked to try once more (the judgment forgets the attempts) the ways are open again', () => {
	const _node = walled( 'group_too_small' );
	_node.tried.push( { strategy: 'ask', wall: 'group_too_small', cause: 'group_too_small' }, { strategy: 'widen', wall: 'group_too_small', cause: 'group_too_small' } );
	assert.equal( choose( _node, CLASSES ).chosen.id, 'decline' );
	_node.tried = [];
	assert.equal( choose( _node, CLASSES ).chosen.id, 'ask' );
} );

attack( SUBJECT, 'U3, R7: once a precondition is met, the strategy that stopped at it answers the wall before it again', () => {
	const _node = walled( 'group_too_small' );
	_node.hitWall( 'precondition_missing', [], { precondition: { id: 'p1', type: 'number_in_range', values: {} } } );
	_node.tried.push( { strategy: 'ask', wall: 'group_too_small', cause: 'group_too_small', outcome: 'wall' },
		{ strategy: 'widen', wall: 'group_too_small', cause: 'precondition_missing', outcome: 'wall' } );
	_node.addFact( { kind: 'precondition_met', evidenceClass: 'observation', source: 'child n-1', data: { id: 'p1' } } );
	// What the judgment does when a child met the precondition (R7): it forgets the attempts that stopped there.
	_node.tried = _node.tried.filter( item => item.cause !== 'precondition_missing' );
	const _result = choose( _node, CLASSES, { exclude: 'ask' } );
	assert.equal( _result.wall, 'group_too_small' );
	assert.equal( _result.chosen.id, 'widen' );
	assert.equal( scored( _result, 'ask' ).reason, 'just tried; another way means another strategy' );
} );

attack( SUBJECT, 'a decision learned for another kind of task does not read the wall here', () => {
	const _foreign = { kind: 'supplier-payments', cause: 'calendar_full', class: 'widen', by: 'x' };
	const _result = choose( walled( 'calendar_full' ), CLASSES, { diagnosis: new Diagnosis( {}, [ _foreign ] ) } );
	assert.deepEqual( [ _result.chosen, _result.undiagnosed ], [ null, true ] );
	const _own = choose( walled( 'calendar_full' ), CLASSES, { diagnosis: new Diagnosis( {}, [ { ..._foreign, kind: 'hr-survey' } ] ) } );
	assert.equal( _own.chosen.id, 'widen' );
} );

// --- 5.6: a person's decision at a wall chooses the class (use cases: the organiser's "the week after") ---

const memory = () => {
	const _learned = [];
	return { learned: _learned, learnDiagnosis: ( node, entry ) => _learned.push( entry ) };
};

attack( SUBJECT, 'decide(): the person\'s class is the wall\'s diagnosis now: learned, signed in memory, and chosen first', () => {
	const _node = walled( 'group_too_small' );
	const _diagnosis = new Diagnosis( DIAGNOSIS.causes, [] );
	const _memory = memory();
	const _wall = Chooser.decide( _node, 'decline', 'lead', { strategies: CLASSES, kind: 'survey', memory: _memory, diagnosis: _diagnosis } );
	assert.deepEqual( _wall, { cause: 'group_too_small', reason: 'lead decided: decline', decided: 'decline' } );
	assert.deepEqual( _memory.learned, [ { kind: 'survey', cause: 'group_too_small', class: 'decline', by: 'lead' } ] );
	_node.hitWall( _wall.cause, [], { reason: _wall.reason, decided: _wall.decided } );
	assert.equal( choose( _node, CLASSES, { diagnosis: _diagnosis } ).chosen.id, 'decline' );
} );

attack( SUBJECT, 'decide(): without a wall there is nothing to decide about; the answer is just the answer', () => {
	assert.equal( Chooser.decide( nodeOf(), 'decline', 'lead', { strategies: CLASSES } ), null );
} );

attack( SUBJECT, 'decide(): a class no strategy of this goal has decides nothing (and is not learned)', () => {
	const _memory = memory();
	assert.equal( Chooser.decide( walled( 'group_too_small' ), 'teleport', 'lead', { strategies: CLASSES, memory: _memory } ), null );
	assert.deepEqual( _memory.learned, [] );
} );

attack( SUBJECT, 'decided(): only the class decided for the current wall counts; a later wall makes it history', () => {
	const _node = walled( 'group_too_small' );
	_node.hitWall( 'group_too_small', [], { decided: 'decline' } );
	assert.equal( Chooser.decided( _node ), 'decline' );
	_node.hitWall( 'no_reaction', [] );
	assert.equal( Chooser.decided( _node ), null );
} );

attack( SUBJECT, 'a decided class orders the choice; it never makes a strategy eligible that is not (G-9)', () => {
	const _node = walled( 'group_too_small' );
	_node.hitWall( 'group_too_small', [], { decided: 'decline' } );
	const _result = choose( _node, CLASSES, { exclude: 'decline' } );
	assert.notEqual( _result.chosen?.id, 'decline', 'the strategy that just ended stays out' );
} );
