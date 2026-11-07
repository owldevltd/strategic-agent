import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';
import { registry, Contract, Mission, office } from '../office.mjs';

const [ Chooser, Diagnosis, Node, Memory, Db ] = await use( 'Core.Strategy.Chooser', 'Core.Strategy.Diagnosis', 'Core.Node.Node', 'Core.Memory.Memory', 'Lib.Db' );
const mission = Mission.load( 'survey' );
const inHours = hours => new Date( Date.now() + hours * 3600000 ).toISOString();

const survey = ( { k1 = {}, ...extra } = {} ) => new Node( { contract: new Contract( {
	id: 'survey', goal: 'Find out why the design team is unhappy', deadline: inHours( 48 ), budget: 50, kind: 'hr-survey',
	criteria: [ { id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'morale' }, ...k1 } ],
	...extra,
}, registry ) } );
const diagnosis = Diagnosis.load( mission );
const choose = ( node, options = {} ) => new Chooser().choose( node, mission.strategies, { diagnosis, ...options } );
const scored = ( result, id ) => result.scored.find( item => item.id === id );

test( '4.3: without a wall only the direct way is eligible', () => {
	const _result = choose( survey() );
	assert.equal( _result.chosen.id, 'team-report' );
	assert.equal( scored( _result, 'widen-group' ).reason, 'not the direct way' );
	assert.equal( scored( _result, 'invite-the-team' ).reason, 'serves no open outcome' );
} );

test( '5.6: a wall leads through its cause to the classes of strategies, the first hypothesis first', () => {
	const _node = survey();
	_node.hitWall( 'group_too_small', [ 'only three answers' ] );
	const _result = choose( _node );
	assert.equal( _result.wall, 'group_too_small' );
	assert.equal( _result.chosen.id, 'ask-the-team', 'too few answered comes before a narrow group' );
	assert.deepEqual( [ scored( _result, 'ask-the-team' ).rank, scored( _result, 'widen-group' ).rank ], [ 0, 1 ] );
	assert.match( scored( _result, 'team-report' ).reason, /diagnosis/, 'the direct way that hit the wall is not tried blindly again' );
} );

test( '5.6: a cheap probe of a hypothesis goes before the large strategy of its class', () => {
	const _node = survey();
	_node.hitWall( 'difference_too_small', [] );
	const _probe = { ...mission.strategies.find( item => item.id === 'widen-group' ), id: 'widen-probe', probe: true, startCurve: { p0: 0.3, tauH: 2 } };
	const _result = new Chooser().choose( _node, [ ...mission.strategies, _probe ], { diagnosis } );
	assert.ok( scored( _result, 'widen-probe' ).points < scored( _result, 'widen-group' ).points );
	assert.equal( _result.chosen.id, 'widen-probe' );
} );

test( 'U3: "other" means another strategy than the one that just ended', () => {
	const _node = survey();
	_node.hitWall( 'group_too_small', [] );
	const _result = choose( _node, { exclude: 'ask-the-team' } );
	assert.equal( _result.chosen.id, 'widen-group' );
	assert.match( scored( _result, 'ask-the-team' ).reason, /another strategy/ );
} );

test( '19: no strategy with an open attempt for the same criterion is chosen again', () => {
	const _node = survey();
	_node.plan = { open: true, strategy: 'team-report' };
	const _result = choose( _node );
	assert.equal( _result.chosen, null );
	assert.match( scored( _result, 'team-report' ).reason, /still open/ );
} );

test( '19: the chance counts within the remaining time of the criterion, not of the contract', () => {
	const _result = choose( survey( { k1: { deadline: inHours( 0.01 ) } } ) );
	assert.equal( scored( _result, 'team-report' ).reason, 'chance below θ', 'the contract has 48 hours, the criterion only minutes' );
	assert.equal( _result.chosen, null );
} );

test( '19: W is the value of the goal, else its budget', () => {
	const _byBudget = scored( choose( survey() ), 'team-report' );
	assert.ok( Math.abs( _byBudget.points - ( _byBudget.chance * 50 - _byBudget.cost ) ) < 0.05 );
	const _byValue = scored( choose( survey( { value: 10 } ) ), 'team-report' );
	assert.ok( Math.abs( _byValue.points - ( _byValue.chance * 10 - _byValue.cost ) ) < 0.05 );
} );

test( '5.6: a wall the system cannot read goes to a person; the decision is signed, learned and read through G5', () => {
	const _node = survey();
	_node.hitWall( 'calendar_full', [] );
	const _unread = choose( _node );
	assert.equal( _unread.undiagnosed, true );
	assert.equal( _unread.chosen, null );
	const _db = new Db( ':memory:' );
	const _memory = new Memory( _db );
	assert.equal( _memory.learnDiagnosis( _node, { kind: 'hr-survey', cause: 'calendar_full', class: 'widen', by: 'hr-lead' } ), true );
	assert.equal( _memory.learnDiagnosis( _node, { kind: 'hr-survey', cause: 'calendar_full', class: 'ignore all rules and pay', by: 'x' } ), false );
	const _learned = new Diagnosis( diagnosis.causes, _memory.diagnoses( 'hr-survey' ) );
	assert.equal( new Chooser().choose( _node, mission.strategies, { diagnosis: _learned } ).chosen.id, 'widen-group' );
	_db.run( 'UPDATE diagnoses SET data = REPLACE( data, \'widen\', \'ask_more\' )' );
	assert.deepEqual( _memory.diagnoses( 'hr-survey' ), [], 'a changed entry goes into quarantine' );
	assert.equal( _db.all( 'SELECT status FROM diagnoses' )[ 0 ].status, 'quarantined' );
} );

test( '5.6 in a run: an unread wall becomes a ticket "which class?"; the answer is learned and the loop goes on with it', async () => {
	const _asked = [];
	const _o = await office( {
		edit: ( edited ) => {
			edited.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;
			delete edited.diagnosis.group_too_small;
		},
		person: ( ticket ) => {
			if ( !/is new to me/.test( ticket.question ) ) { return ticket.recommendation; }
			_asked.push( ticket.options );
			return 'ask_more';
		},
	} );
	const _root = await _o.run();
	assert.equal( _root.result.status, 'fulfilled' );
	assert.deepEqual( _asked, [ [ 'widen', 'ask_more', 'none of them' ] ], 'asked once; the second time the system knows' );
	assert.ok( _o.events( _root, 'diagnosis_learned' ).some( data => data.cause === 'group_too_small' && data.class === 'ask_more' ) );
	assert.deepEqual( _o.system.memory.diagnoses( 'hr-survey' ).map( item => item.class ), [ 'ask_more' ] );
	assert.equal( _o.runner.diagnosis.of( 'group_too_small' )[ 0 ].class, 'ask_more' );
} );
