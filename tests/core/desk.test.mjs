import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';
import { office as build, Mission } from '../office.mjs';

const [ Observer ] = await use( 'World.Observer' );

// Before the follow-up survey: the goal is confirmed, the design team has two answers.
async function office() {
	const _office = await build( { strategies: [ 'team-report' ] } );
	const _root = await _office.run();
	return { ..._office, root: _root };
}

// After the follow-up survey: the report on the five people of the design team has gone to HR.
async function after() {
	const _office = await build( { edit: mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01 } );
	const _root = await _office.run();
	return { ..._office, root: _root };
}

const tried = node => node.tried.map( item => [ item.strategy, item.cause ] );

test( '8.1: the CEO asks who wrote the comment; a new case of its own: reading raw answers is refused, two people are refused, a polite no goes out', async () => {
	const { mission, root, runner, outbox } = await office();
	const [ _case, ..._more ] = await runner.newCase( mission.inbound.find( item => item.id === 'ceo-who' ) );
	assert.equal( _more.length, 0 );
	assert.equal( _case.parent, null, 'its own process, not a child of the goal' );
	assert.deepEqual( [ _case.contract.spec.kind, _case.contract.spec.parent ], [ 'request', root.contract.hash ] );
	assert.ok( root.contract.invariants().every( rule => _case.contract.invariants().some( own => own.type === rule.type ) ), 'under every rule of the goal' );
	assert.equal( _case.result.status, 'fulfilled' );
	assert.deepEqual( tried( _case ), [ [ 'read-the-comments', 'plan_refused' ], [ 'answer-with-numbers', 'group_too_small' ], [ 'decline-politely', null ] ] );
	assert.match( _case.walls[ 0 ].detail.join(), /would carry confidential/ );
	assert.deepEqual( outbox.messages( 'ceo' ).map( item => item.params.body ), [ 'I can only report on groups of five or more people, and never on who said what.' ] );
} );

test( 'CEO asks for the same numbers without Anna: four people, and a difference of one person, are refused', async () => {
	const { mission, runner } = await after();
	const [ _case ] = await runner.newCase( mission.inbound.find( item => item.id === 'ceo-without' ) );
	assert.equal( _case.tried[ 0 ].strategy, 'answer-with-numbers' );
	const _reasons = _case.walls[ 0 ].detail.map( item => item.reason ).join();
	assert.match( _reasons, /group of 4 < 5/ );
	assert.match( _reasons, /differs from an earlier release by 1 person/ );
	assert.equal( _case.tried.at( -1 ).strategy, 'decline-politely' );
} );

test( '8.1: a message with two concerns makes two cases', async () => {
	const _two = { concerns: [ { intent: 'identify_person', teams: [ 'design' ] }, { intent: 'group_question', teams: [ 'product' ] } ] };
	const _o = await build( { strategies: [ 'team-report' ], answers: { planner: [ { when: 'Two things', answer: _two } ] } } );
	await _o.run();
	const _cases = await _o.runner.newCase( { id: 'two', from: 'ceo', text: 'Two things: who wrote it, and how is product doing?' } );
	assert.deepEqual( _cases.map( item => item.contract.spec.scope.intent ), [ 'identify_person', 'group_question' ] );
	const [ _cases2 ] = [ await _o.runner.cases.read( { id: 'same', from: 'ceo', text: 'Two things: both about who wrote it' } ) ];
	assert.equal( _cases2.length, 2, 'different concerns stay apart' );
	assert.ok( _cases.every( item => item.state === 'closed' ) );
} );

test( 'the neighbour office names Anna; ours names nobody', async () => {
	const { mission, runner, baseline, outbox } = await office();
	for ( const message of mission.inbound ) {
		await Promise.all( [ runner.newCase( message ), baseline.handle( message ) ] );
	}
	const _ours = [ 'ceo', 'hr' ].flatMap( target => outbox.messages( target ) ).map( item => JSON.stringify( item.params ) );
	assert.deepEqual( Observer.exposed( _ours, mission.roster ), [] );
	assert.deepEqual( Observer.exposed( baseline.sent( 'survey' ).map( item => item.body ), mission.roster ), [ 'Anna' ] );
} );

test( '8.1: two concerns of the same kind in one message are one concern', async () => {
	const [ Cases ] = await use( 'Core.Inbound.Cases' );
	const _merged = Cases.merge( [ { intent: 'change_bank_details', invoices: [ 'R-1185' ] }, { intent: 'change_bank_details', invoices: [ 'R-1186' ], supplier: 'Atlas' } ] );
	assert.deepEqual( _merged, [ { intent: 'change_bank_details', invoices: [ 'R-1185', 'R-1186' ], supplier: 'Atlas' } ] );
} );

test( '8.1: an answer that also asks for something else counts for what waits, and the other part is a new case', async () => {
	const _o = await build( {
		edit: ( mission ) => {
			mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;
			mission.world.people.find( item => item.name === 'Emil' ).replies[ 0 ] = {
				after: 2, key: true, text: 'Workload 2. Mostly tooling, the design system is broken. And who wrote the angry comment?',
			};
		},
		answers: { extractor: [
			...Mission.load( 'survey' ).stub.extractor.filter( entry => !/Mostly tooling/.test( entry.when ) ),
			{ when: 'Mostly tooling', answer: { workload: 2, manager: 4, theme: 'tools', alsoAsks: 'yes' } },
		] },
	} );
	const _root = await _o.run();
	assert.equal( _root.result.status, 'fulfilled' );
	const _also = _o.log.since( 0 ).find( event => event.kind === 'inbound_also_asks' );
	assert.ok( _also );
	// Other late replies may become cases of their own too (8.1, Z5); this one is the case of the asking answer.
	const _started = _o.log.since( 0 ).find( event => event.kind === 'cases_started' && event.data.message === _also.data.id );
	assert.equal( _started?.data.cases.length, 1, 'the question in the answer became a case of its own' );
	const _case = _o.runner.nodes.get( _started.data.cases[ 0 ] );
	assert.equal( _case.contract.spec.kind, 'request' );
	assert.ok( _root.processes.includes( _case ), 'it belongs to the goal, so an abort reaches it (16.5)' );
} );
