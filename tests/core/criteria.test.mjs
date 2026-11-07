import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';

const [ Registry, Contract, ContractCheck, Catalog, Mission, Judge, Node, ConfirmedBy ] = await use(
	'Core.Criteria.Registry', 'Core.Contract.Contract', 'Core.Check.ContractCheck', 'Core.Move.Catalog', 'Core.Mission.Mission',
	'Core.Loop.Judge', 'Core.Node.Node', 'Core.Criteria.ConfirmedBy',
);
const registry = await Registry.load();
const at = text => new Date( text ).toISOString();
const fact = ( kind, data, evidenceClass = 'observation', extra = {} ) => ( { id: `f-${Math.random()}`, kind, evidenceClass, origin: 'system', data, time: at( '2026-11-05T10:00Z' ), ...extra } );
const one = spec => registry.create( { id: 'k1', ...spec } );

// 14.3: the first test of G1. One deadline on 06.11. and a meeting that must take place in week 46 contradict each other.
test( '14.3: a criterion due after the contract deadline is refused (K1)', () => {
	const _contract = new Contract( {
		id: 'a3f9', goal: 'Meeting with supplier X has taken place', deadline: at( '2026-11-06T12:00Z' ), budget: 30, value: 40,
		criteria: [
			{ id: 'k1', type: 'commitment_received', values: { from: 'contact:4711', subject: 'meeting', window: [ at( '2026-11-09T08:00Z' ), at( '2026-11-13T17:00Z' ) ] }, deadline: at( '2026-11-06T12:00Z' ) },
			{ id: 'k2', type: 'event_occurred', values: { event: 'meeting:k1', window: [ at( '2026-11-09T08:00Z' ), at( '2026-11-13T17:00Z' ) ], after: 'k1' }, deadline: at( '2026-11-13T17:00Z' ) },
		],
	}, registry );
	const _check = new ContractCheck().check( _contract, { now: Date.parse( '2026-11-03T16:00Z' ) } );
	assert.equal( _check.ok, false );
	assert.ok( _check.problems.some( item => /k2: deadline after the contract deadline/.test( item ) ) );
	assert.ok( !_check.problems.some( item => /k1/.test( item ) ), 'a commitment may be for a later window (K2)' );
} );

test( 'K8: a criterion whose deadline has passed, or is no time at all, is refused at G1', () => {
	const _contract = deadline => new Contract( {
		id: 'k8', goal: 'g', deadline: at( '2026-11-20T00:00Z' ), budget: 9,
		criteria: [ { id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'design' }, deadline } ],
	}, registry );
	const _now = { now: Date.parse( '2026-11-10T00:00Z' ) };
	assert.ok( new ContractCheck().check( _contract( at( '2026-11-09T00:00Z' ) ), _now ).problems.includes( 'k1: its deadline is in the past (K8)' ) );
	assert.ok( new ContractCheck().check( _contract( 'next week' ), _now ).problems.includes( 'k1: its deadline is invalid (K8)' ) );
	assert.ok( !new ContractCheck().check( _contract( at( '2026-11-12T00:00Z' ) ), _now ).problems.some( item => /K8/.test( item ) ) );
} );

test( 'K2 and K3: windows start before they end and end by their deadline; a dependent event leaves time for its commitment', () => {
	const _check = spec => new ContractCheck().check( new Contract( { id: 'c', goal: 'g', deadline: at( '2026-11-20T00:00Z' ), budget: 9, criteria: spec }, registry ),
		{ now: Date.parse( '2026-11-03T00:00Z' ) } ).problems.join();
	assert.match( _check( [ { id: 'k1', type: 'event_occurred', values: { event: 'e', window: [ at( '2026-11-12T00:00Z' ), at( '2026-11-10T00:00Z' ) ] } } ] ), /starts after it ends \(K2\)/ );
	assert.match( _check( [ { id: 'k1', type: 'event_occurred', values: { event: 'e', window: [ at( '2026-11-10T00:00Z' ), at( '2026-11-14T00:00Z' ) ] }, deadline: at( '2026-11-12T00:00Z' ) } ] ),
		/window ends after its own deadline \(K2\)/ );
	assert.match( _check( [
		{ id: 'k1', type: 'commitment_received', values: { from: 'p', subject: 's', window: [ at( '2026-11-10T00:00Z' ), at( '2026-11-14T00:00Z' ) ] }, deadline: at( '2026-11-15T00:00Z' ) },
		{ id: 'k2', type: 'event_occurred', values: { event: 'e', window: [ at( '2026-11-10T00:00Z' ), at( '2026-11-14T00:00Z' ) ], after: 'k1' } },
	] ), /k1 is due only after this window ends \(K3\)/ );
} );

test( 'K6: an empty range and a negative tolerance are refused', () => {
	assert.match( one( { type: 'number_in_range', values: { quantity: 'q', min: 5, max: 2 } } ).validate().join(), /range is empty \(K6\)/ );
	assert.match( one( { type: 'count_matches', values: { source: 'a', target: 'b', tolerance: -1 } } ).validate().join(), /must be a number >= 0/ );
} );

test( 'K4: what no channel can prove gets a person as its channel, shown in the back-translation', () => {
	const _catalog = Catalog.load( Mission.load( 'survey' ) );
	const _contract = new Contract( { id: 'c', goal: 'The supplier meeting took place', deadline: at( '2026-12-01T00:00Z' ), budget: 9,
		criteria: [ { id: 'k1', type: 'event_occurred', values: { event: 'meeting', window: [ at( '2026-11-10T00:00Z' ), at( '2026-11-20T00:00Z' ) ] } } ],
		understood: { backTranslation: 'You want …', notCovered: [], coverage: [ { sentence: 'The supplier meeting took place', criteria: [ 'k1' ] } ] } }, registry );
	assert.deepEqual( ContractCheck.unchannelled( _contract, _catalog ), [ 'k1' ] );
	const _channelled = ContractCheck.channelled( _contract, _catalog, registry );
	assert.equal( _channelled.criteria[ 0 ].byPerson, true );
	assert.deepEqual( _channelled.understood.confirmedByYou, [ 'k1' ] );
	const _yes = fact( 'confirmation', { criterion: 'k1', choice: 'yes', role: 'client' }, 'confirmation' );
	assert.equal( _channelled.check( [ _yes ] )[ 0 ].met, true );
} );

test( '3.3: a criterion of the agent serves one of the client; a test of the agent must be red first and catch mutations', () => {
	const _goal = criteria => new ContractCheck().check( new Contract( { id: 'c', goal: 'Export all customers', deadline: at( '2026-12-01T00:00Z' ), budget: 9, criteria }, registry ),
		{ now: Date.parse( '2026-11-03T00:00Z' ) } ).problems.join();
	const _client = { id: 'k1', type: 'count_matches', values: { source: 'db:customers', target: 'export.csv', tolerance: 0 } };
	assert.match( _goal( [ _client, { id: 'a7', type: 'test_green', values: { test: 'umlauts', commit: 'c2' }, origin: 'agent' } ] ), /must serve a criterion of the client/ );
	assert.doesNotMatch( _goal( [ _client, { id: 'a7', type: 'test_green', values: { test: 'umlauts', commit: 'c2' }, origin: 'agent', serves: 'k1' } ] ), /a7/ );
	const _test = one( { type: 'test_green', values: { test: 'umlauts', commit: 'c2', firstRed: true, mutation: { caught: 9, of: 10 } }, origin: 'agent', serves: 'k1' } );
	const _green = fact( 'test_run', { test: 'umlauts', commit: 'c2', result: 'green' }, 'observation', { time: at( '2026-11-05T11:00Z' ) } );
	assert.match( _test.check( [ _green ] ).reason, /never red first/ );
	const _red = fact( 'test_run', { test: 'umlauts', commit: 'c1', result: 'red' }, 'observation', { time: at( '2026-11-05T09:00Z' ) } );
	assert.match( _test.check( [ _red, _green ] ).reason, /fewer than 9 of 10 mutations/ );
	assert.equal( _test.check( [ _red, _green, fact( 'mutation_run', { test: 'umlauts', commit: 'c2', caught: 9, of: 10 } ) ] ).met, true );
} );

test( 'the predicates of 14.1 accept exactly the evidence the paper names', () => {
	const _window = [ at( '2026-11-09T08:00Z' ), at( '2026-11-13T17:00Z' ) ];
	const _event = one( { type: 'event_occurred', values: { event: 'meeting', window: _window, role: 'participant' } } );
	assert.equal( _event.check( [ fact( 'calendar_entry', { event: 'meeting', at: at( '2026-11-11T10:00Z' ) } ) ] ).met, false, 'a calendar entry only plans it' );
	assert.equal( _event.check( [ fact( 'event_confirmed', { event: 'meeting', at: at( '2026-11-11T10:00Z' ), role: 'participant' }, 'confirmation' ) ] ).met, true );
	assert.equal( _event.check( [ fact( 'event_recorded', { event: 'meeting', at: at( '2026-11-11T10:00Z' ) } ) ] ).met, true );
	const _commit = one( { type: 'commitment_received', values: { from: 'contact:4711', subject: 'meeting', window: _window } } );
	const _claim = fact( 'commitment', { party: 'contact:4711', subject: 'meeting', at: at( '2026-11-11T10:00Z' ) }, 'claim' );
	assert.equal( _commit.check( [ _claim ] ).met, false, 'a claim alone does not prove that it was not withdrawn (B5)' );
	assert.equal( _commit.check( [ _claim, fact( 'no_contradiction', { commitment: _claim.id } ) ] ).met, true );
	const _counter = fact( 'counter_proposal', { party: 'contact:4711', subject: 'meeting', at: at( '2026-11-25T10:00Z' ) }, 'claim' );
	assert.equal( _commit.verdict( [ _counter ] ).impossible, true, 'week 48 instead: impossible (10.1)' );
	const _state = one( { type: 'state_is', values: { object: 'calendar', field: 'slot:11', value: 'free' } } );
	assert.equal( _state.check( [ fact( 'state_read', { object: 'calendar', field: 'slot:11', value: 'free' }, 'observation', { validUntil: at( '2020-01-01T00:00Z' ) } ) ] ).met, false, 'an expired reading does not count (B2)' );
	assert.equal( _state.check( [ fact( 'state_read', { object: 'calendar', field: 'slot:11', value: 'free' } ) ] ).met, true );
	const _number = one( { type: 'number_in_range', values: { quantity: 'answers:design', min: 5 } } );
	assert.equal( _number.check( [ fact( 'measured', { quantity: 'answers:design', value: 4 } ), fact( 'measured', { quantity: 'answers:design', value: 5 } ) ] ).met, true );
	const _doc = one( { type: 'document_present', values: { kind: 'note', ref: 'n1' } } );
	assert.equal( _doc.check( [ fact( 'document', { kind: 'note', ref: 'n1', checksum: 'a' } ), fact( 'document', { kind: 'note', ref: 'n1', checksum: 'b' } ) ] ).met, false );
	const _confirmed = one( { type: 'confirmed_by', values: { role: 'client', question: 'Is the delivery complete?' } } );
	const _answer = fact( 'confirmation', { role: 'client', question: ConfirmedBy.key( 'Is the delivery complete?' ), choice: 'yes' }, 'confirmation' );
	assert.equal( _confirmed.check( [ _answer ] ).met, true );
	assert.equal( _confirmed.check( [ { ..._answer, evidenceClass: 'claim' } ] ).met, false );
} );

test( 'evidence after a criterion\'s own deadline does not count; an open criterion past its deadline makes the verdict escalate (U4)', () => {
	const _late = one( { type: 'number_in_range', values: { quantity: 'q', min: 1 }, deadline: at( '2026-11-05T09:00Z' ) } );
	assert.equal( _late.check( [ fact( 'measured', { quantity: 'q', value: 3 } ) ] ).met, false );
	const _node = new Node( { contract: new Contract( {
		id: 'c', goal: 'g', deadline: at( '2026-12-01T00:00Z' ), budget: 9,
		criteria: [ { id: 'k1', type: 'number_in_range', values: { quantity: 'q', min: 1 }, deadline: at( '2026-11-01T00:00Z' ) } ],
	}, registry ) } );
	_node.hitWall( 'no_reaction' );
	assert.deepEqual( new Judge( { registry } ).decide( _node, { verdict: 'other' }, [ { id: 's', points: 10, reason: null } ] ), { verdict: 'escalate', rule: 'U4', overruled: true } );
} );

test( 'soft criteria are part of the confirmed goal but never of the hard core (14)', () => {
	const _contract = new Contract( { id: 'c', goal: 'g', deadline: at( '2026-12-01T00:00Z' ), budget: 9, soft: [ 'friendly and factual' ],
		criteria: [ { id: 'k1', type: 'number_in_range', values: { quantity: 'q', min: 1 } } ] }, registry );
	assert.deepEqual( _contract.softs().map( item => item.values.text ), [ 'friendly and factual' ] );
	assert.deepEqual( _contract.check( [] ).map( item => item.id ), [ 'k1' ] );
	assert.ok( _contract.canonical().soft, 'the person confirms them, the hash binds them' );
	const _onlySoft = new ContractCheck().check( new Contract( { id: 'c', goal: 'g', deadline: at( '2026-12-01T00:00Z' ), budget: 9, soft: [ 'nice' ], criteria: [] }, registry ),
		{ now: Date.parse( '2026-11-03T00:00Z' ) } );
	assert.match( _onlySoft.problems.join(), /no outcome criterion/ );
} );
