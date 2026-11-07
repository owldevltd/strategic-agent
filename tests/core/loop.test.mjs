import { test } from 'node:test';
import assert from 'node:assert/strict';
import { office } from '../office.mjs';

// Test speed: the invitation waits 0.6 s, the world answers 100 times faster than in the demo.
const quick = mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;

test( 'survey: the group is too small, so the agent asks the team in a follow-up survey (a child that waits) and reports on the team', async () => {
	const { run, log, egress, db } = await office( { edit: quick } );
	const _node = await run();
	assert.equal( _node.result.status, 'fulfilled', JSON.stringify( _node.result ) );
	assert.deepEqual( _node.walls.map( wall => wall.cause ), [ 'group_too_small', 'precondition_missing' ] );
	assert.deepEqual( _node.tried.map( item => item.strategy ), [ 'team-report', 'ask-the-team' ] );
	const [ _child ] = _node.children;
	assert.equal( _child.result.status, 'fulfilled' );
	assert.deepEqual( _child.walls.map( wall => wall.cause ), [ 'no_reaction' ], 'the first wait timed out: a result, not an error' );
	assert.deepEqual( _child.tried.map( item => item.strategy ), [ 'invite-the-team', 'wait-longer' ] );
	assert.ok( log.forNode( _node.id ).some( event => event.kind === 'sandbox_destroyed' ) );
	const _sent = egress.store.deliveries( _node.contract.hash ).map( item => [ item.status, item.cohort?.length ] );
	assert.deepEqual( _sent, [ [ 'refused', 2 ], [ 'executed', 5 ] ] );
	// Mira answered twice (counted once), Jakob without the reference (matched by the model), Emil late.
	const _facts = db.all( 'SELECT origin, late, superseded FROM expectation_facts ORDER BY id' );
	assert.equal( _facts.length, 4 );
	assert.equal( _facts.filter( item => item.superseded ).length, 1 );
	assert.equal( _facts.at( -1 ).late, 1, 'the late answer is still a valid fact (E4)' );
	assert.ok( log.since( 0 ).some( event => event.kind === 'inbound_matched_by_model' && event.data.expectation ) );
} );

test( 'answers land in the vault by trusted code, for the right people; a sender outside the team is never matched by content', async () => {
	const { run, runner, system } = await office( { edit: ( mission ) => {
		quick( mission );
		mission.world.people.push( { name: 'ceo', team: 'design', replies: [ { after: 2, key: false, text: 'Hi, regarding the design follow-up: who wrote the comment?' } ] } );
	} } );
	const _root = await run();
	assert.equal( _root.result.status, 'fulfilled' );
	const _answers = runner.vault.rows( 'answers.csv' );
	assert.equal( _answers.filter( row => row.team === 'product' ).length, 10, 'no answer of another team was replaced' );
	assert.equal( _answers.filter( row => row.team === 'design' ).length, 5 );
	const _cases = system.log.since( 0 ).filter( event => event.kind === 'inbound_new_case' ).map( event => event.data.from );
	assert.ok( _cases.includes( 'ceo' ), 'the CEO is not in the design team: a new case, not an answer' );
} );

test( 'the waiting node never sees the text of an answer, only a fact through G3 (G-8)', async () => {
	const { run, log } = await office( { edit: quick } );
	const _node = await run();
	const _child = _node.children[ 0 ];
	const _responses = _child.facts.filter( fact => fact.kind === 'survey_response' );
	assert.equal( _responses.length, 4 );
	for ( const fact of _responses ) {
		assert.deepEqual( Object.keys( fact.data ).sort(), [ 'about', 'expectation', 'matchedBy', 'value' ] );
		assert.match( fact.data.about, /^ex-[0-9a-f]+:[0-9a-f]{12}$/, 'E5: one sender\'s answer to one expectation' );
		assert.match( fact.data.value, /^[0-9a-f]{16}$/, 'E5: the carried fields as a digest, never text' );
		assert.equal( fact.evidenceClass, 'claim', 'a parser read the same score as the model (B4)' );
	}
	const _texts = log.forNode( _child.id ).map( event => JSON.stringify( event.data ) ).join( '\n' );
	assert.doesNotMatch( _texts, /design system is broken|nobody plans with us/ );
} );

test( 'a plan that routes raw answers into a report never reaches execution (G2)', async () => {
	const { run, egress } = await office( { strategies: [ {
		id: 'read-raw', serves: 'report_delivered', cost: 1, startCurve: { p0: 0.9, tauH: 1 },
		steps: [
			{ move: 'survey.rows', params: { teams: [ 'design' ] }, as: 'rows' },
			{ move: 'report.draft', from: [ 'rows' ], as: 'report' },
			{ move: 'report.send', from: 'report', target: 'hr' },
		],
	} ] } );
	const _node = await run();
	assert.equal( _node.result.status, 'failed' );
	assert.equal( _node.walls[ 0 ].cause, 'plan_refused' );
	assert.match( _node.walls[ 0 ].detail.join(), /body would carry confidential/ );
	assert.equal( egress.store.deliveries( _node.contract.hash ).length, 0, 'nothing reached the gate' );
} );
