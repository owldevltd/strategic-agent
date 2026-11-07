import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';

const [ Registry, Drafter, StubProvider, Mission, StrategyGates, Db ] = await use( 'Core.Criteria.Registry', 'Core.Contract.Drafter',
	'Core.Ai.StubProvider', 'Core.Mission.Mission', 'Core.Gates.StrategyGates', 'Lib.Db' );
const registry = await Registry.load();

const draft = ( mission, change = {} ) => {
	const _answer = { ...mission.stub.contract, ...change };
	return new Drafter( { provider: new StubProvider( { answers: { contract: _answer } } ), registry } ).draft( mission, mission.task );
};

test( 'a task becomes layer 1 (client and catalog) plus the back-translation the person will confirm', async () => {
	const _mission = Mission.load( 'survey' );
	const _result = await draft( _mission );
	assert.equal( _result.ok, true, JSON.stringify( _result.problems ) );
	const _criteria = _result.contract.criteria.map( item => [ item.type, item.origin, item.immutable ] );
	assert.deepEqual( _criteria, [ [ 'report_delivered', 'client', false ], [ 'min_group', 'catalog', true ], [ 'no_difference', 'catalog', true ] ] );
	assert.match( _result.contract.understood.backTranslation, /^You want a report for HR/ );
	assert.equal( _result.contract.understood.task, _mission.task );
	assert.equal( _result.contract.canonical().understood.backTranslation, _result.contract.understood.backTranslation,
		'the back-translation is part of the hashed content the person confirms' );
} );

test( '7.3, 21: for a new kind of task the agent sets strategy gates as rule instances; the system gate refuses anything looser', async () => {
	const _mission = Mission.load( 'survey' );
	const _rule = { rule: 'restrict', move: 'followup.invite', param: 'need', min: 3 };
	const _drafted = await draft( _mission, { strategyGates: [ _rule ] } );
	assert.equal( _drafted.ok, true, JSON.stringify( _drafted.problems ) );
	assert.deepEqual( _drafted.gates, [ _rule ] );
	assert.ok( !_drafted.contract.criteria.some( item => item.origin === 'agent' ), 'strategy gates are not part of the contract' );
	const _store = new StrategyGates( new Db( ':memory:' ) );
	const _first = _store.propose( _drafted.gates[ 0 ], { scope: 'hr-survey', registry } );
	assert.equal( _first.ok, true );
	assert.equal( _store.propose( { ..._rule, min: 4 }, { scope: 'hr-survey', registry } ).ok, true, 'tightening is allowed' );
	const _looser = _store.propose( { ..._rule, min: 2 }, { scope: 'hr-survey', registry } );
	assert.equal( _looser.ok, false );
	assert.match( _looser.problems.join(), /lower or drop the lower bound.*the agent may only tighten/ );
	assert.equal( _store.lift( _store.active( 'hr-survey' )[ 0 ].id, { by: 'agent' } ), false, 'the agent never lifts a gate' );
	assert.deepEqual( _store.active( 'hr-survey' ).map( item => item.min ), [ 4 ] );
	assert.deepEqual( _store.active( 'invoices' ), [], 'every instance has its scope' );
	const [ Catalog ] = await use( 'Core.Move.Catalog' );
	const _invented = _store.propose( { rule: 'order', before: 'analyze_survey', after: 'send_report' }, { scope: 'hr-survey', registry, catalog: Catalog.load( _mission ) } );
	assert.match( _invented.problems.join(), /analyze_survey is not a move of the catalog/, 'an instance names moves that exist' );
	const _known = { scope: 'hr-survey', registry, catalog: Catalog.load( _mission ), strategies: _mission.strategies };
	const _backwards = _store.propose( { rule: 'order', before: 'analysis.run', after: 'analysis.write' }, _known );
	assert.match( _backwards.problems.join(), /would paralyse it from the start/ );
	assert.equal( _store.propose( { rule: 'order', before: 'report.draft', after: 'report.send' }, _known ).ok, true, 'an order the strategies keep is fine' );
} );

test( 'unknown types, missing outcomes and goals without any way are refused, after one repair round', async () => {
	const _mission = Mission.load( 'survey' );
	const _unknown = await draft( _mission, { outcomes: [ { type: 'teleport', values: {} } ] } );
	assert.equal( _unknown.ok, false );
	assert.match( _unknown.problems.join(), /unknown criterion type: teleport/ );
	const _noWay = await draft( _mission, { outcomes: [ { type: 'items_resolved', values: { collection: 'x', items: [ 'a' ], outcomes: [ 'done' ] } } ] } );
	assert.match( _noWay.problems.join(), /no strategy can achieve items_resolved/ );
} );

test( 'the catalog invariants of the process kind are always added (K7)', async () => {
	const _mission = Mission.load( 'invoices' );
	const _result = await draft( _mission );
	assert.equal( _result.ok, true, JSON.stringify( _result.problems ) );
	const _types = _result.contract.invariants().map( item => `${item.type}:${item.origin}` ).sort();
	assert.deepEqual( _types, [ 'account_from_master:catalog', 'exactly_once:catalog', 'human_approval:catalog', 'sum_max:client' ] );
} );

test( 'K5: a sentence of the goal that no criterion covers must be listed as not covered', async () => {
	const _mission = Mission.load( 'survey' );
	const _uncovered = await draft( _mission, { goal: 'Find out why the design team is unhappy. Fix their tools.', coverage: [
		{ sentence: 'Find out why the design team is unhappy', criteria: [ 'k1' ] },
	] } );
	assert.equal( _uncovered.ok, false );
	assert.match( _uncovered.problems.join(), /"Fix their tools" is neither covered/ );
	const _listed = await draft( _mission, { goal: 'Find out why the design team is unhappy. Fix their tools.', notCovered: [ 'Fix their tools: no criterion' ],
		coverage: [ { sentence: 'Find out why the design team is unhappy', criteria: [ 'k1' ] } ] } );
	assert.equal( _listed.ok, true, JSON.stringify( _listed.problems ) );
	const _clauses = await draft( _mission, { goal: 'Find out why the design team is unhappy, and report the reasons to HR.', coverage: [
		{ sentence: 'Find out why the design team is unhappy.', criteria: [ 'K1' ] }, { sentence: 'Report the reasons to HR.', criteria: [ '1' ] },
	] } );
	assert.equal( _clauses.ok, true, 'a sentence covered clause by clause, the ids written loosely' );
	const _half = await draft( _mission, { goal: 'Find out why the design team is unhappy, and fix their tools within a week.', coverage: [
		{ sentence: 'Find out why the design team is unhappy.', criteria: [ 'k1' ] }, { sentence: 'Fix their tools within a week.', criteria: [] },
	] } );
	assert.equal( _half.ok, false, 'one clause without a criterion leaves the sentence uncovered' );
} );

test( 'G1 feasibility: an outcome only a strategy that does not fit its values could serve has no way; the draft goes back for repair', async () => {
	const _mission = Mission.load( 'survey' );
	const _vague = await draft( _mission, { outcomes: [
		{ type: 'report_delivered', values: { to: 'hr', topic: 'morale' } },
		{ type: 'number_in_range', values: { quantity: 'identified reasons', min: 1 } },
	] } );
	assert.equal( _vague.ok, false );
	assert.match( _vague.problems.join(), /k2: no strategy can achieve number_in_range/ );
} );
