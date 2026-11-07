import { test } from 'node:test';
import assert from 'node:assert/strict';
import { office as build } from '../office.mjs';

const PROPOSAL = {
	when: '"moves"',
	answer: {
		rationale: 'report on the whole department instead of the team alone',
		steps: [
			{ move: 'survey.query', params: { teams: [ 'design', 'product' ] }, from: [], as: 'stats', target: '' },
			{ move: 'report.draft', params: {}, from: [ 'stats' ], as: 'report', target: '' },
			{ move: 'report.send', params: {}, from: [ 'report' ], as: '', target: 'hr' },
		],
	},
};

async function office( { strategies = null, decision = 'yes' } = {} ) {
	const _fill = { when: '"lastWall"', answer: { teams: [ 'design' ] } };
	const _choose = ticket => ( ticket.options.includes( decision ) ? decision : ticket.recommendation );
	const _office = await build( { strategies, answers: { strategist: [ PROPOSAL, _fill ] }, person: _choose, by: 'hr-lead' } );
	const _root = await _office.run();
	return { root: _root, log: _office.log, office: _office };
}

test( 'the model fills the slots of the chosen strategy; a value that breaks the slot falls back to the default', async () => {
	const { root, log } = await office( { strategies: [ 'team-report', 'widen-group' ] } );
	assert.equal( root.result.status, 'fulfilled' );
	const _filled = log.forNode( root.id ).filter( event => event.kind === 'slots_filled' ).map( event => event.data );
	assert.deepEqual( _filled[ 0 ], { strategy: 'team-report', slots: { teams: [ 'design' ] }, byModel: [ 'teams' ] } );
	assert.deepEqual( _filled[ 1 ].slots, { teams: [ 'design', 'product' ] }, '"widen" with the team alone is rejected' );
	const _rejected = log.forNode( root.id ).find( event => event.kind === 'slot_rejected' ).data;
	assert.equal( _rejected.reason, 'needs at least 2 values' );
	assert.deepEqual( root.tried.map( item => item.strategy ), [ 'team-report', 'widen-group' ] );
} );

test( '6.1, 19: with no known strategy left, a proposed strategy runs as its own process: checked, approved, in the catalog, then chosen', async () => {
	const { root, log, office: _o } = await office( { strategies: [ 'team-report' ] } );
	assert.equal( root.result.status, 'fulfilled', JSON.stringify( root.result ) );
	assert.ok( log.forNode( root.id ).some( event => event.kind === 'strategy_proposed' ) );
	const _started = log.forNode( root.id ).find( event => event.kind === 'process_started' ).data;
	const _process = _o.runner.nodes.get( _started.process );
	assert.equal( _process.parent, null, 'its own process, not a child for a precondition' );
	assert.equal( _process.contract.spec.kind, 'meta' );
	assert.deepEqual( _process.contract.criteria.slice( 0, 3 ).map( item => item.type ), [ 'test_green', 'confirmed_by', 'state_is' ] );
	assert.equal( _process.result.status, 'fulfilled' );
	assert.equal( _o.db.get( 'SELECT status, approvedBy FROM proposals' ).status, 'approved' );
	assert.ok( _o.mission.strategies.some( item => item.id === 'proposed-1' && item.approved ) );
	assert.deepEqual( root.tried.map( item => item.strategy ), [ 'team-report', 'proposed-1' ] );
} );

test( '6.1: a proposal the person declines never reaches the catalog and does not run', async () => {
	const { root, office: _o } = await office( { strategies: [ 'team-report' ], decision: 'no' } );
	assert.equal( root.result.status, 'failed' );
	assert.deepEqual( root.tried.map( item => item.strategy ), [ 'team-report' ] );
	assert.equal( _o.db.get( 'SELECT status FROM proposals' ).status, 'proposed' );
	assert.ok( !_o.mission.strategies.some( item => item.id === 'proposed-1' ) );
} );
