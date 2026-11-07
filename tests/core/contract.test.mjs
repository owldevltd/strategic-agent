import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';

const [ Registry, Contract, ContractCheck ] = await use( 'Core.Criteria.Registry', 'Core.Contract.Contract', 'Core.Check.ContractCheck' );
const registry = await Registry.load();
const inHours = hours => new Date( Date.now() + hours * 3600000 ).toISOString();
const DEADLINE = inHours( 48 );

const survey = ( extra = {} ) => new Contract( {
	id: 'survey',
	goal: 'Find out why the design team is unhappy',
	deadline: DEADLINE,
	criteria: [
		{ id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'morale' } },
		{ id: 'k2', type: 'min_group', values: { k: 5 }, immutable: true },
		{ id: 'k3', type: 'no_difference', values: { k: 5 }, immutable: true },
	],
	...extra,
}, registry );

const invoices = () => new Contract( {
	id: 'invoices',
	goal: 'Prepare this week\'s supplier payments',
	deadline: inHours( 72 ),
	criteria: [
		{ id: 'k1', type: 'items_resolved', values: { collection: 'invoices', items: [ 'R-1186', 'R-1187' ], outcomes: [ 'paid', 'escalated' ] } },
		{ id: 'k2', type: 'exactly_once', values: { key: 'invoiceId', action: 'payment' }, immutable: true },
		{ id: 'k3', type: 'account_from_master', values: { param: 'iban' }, immutable: true },
		{ id: 'k4', type: 'sum_max', values: { max: 48000 }, immutable: true },
		{ id: 'k5', type: 'human_approval', values: { actions: [ 'payment' ] }, immutable: true },
	],
}, registry );

test( 'two different goals yield different rules from the same code', () => {
	const _survey = survey().rules();
	const _invoices = invoices().rules();
	assert.deepEqual( _survey.gate.map( rule => rule.rule ).sort(), [ 'expires', 'min_group', 'no_difference' ] );
	assert.deepEqual( _invoices.gate.map( rule => rule.rule ).sort(), [ 'exactly_once', 'expires', 'human_approval', 'known_account', 'sum_max' ] );
	assert.ok( _invoices.flow.some( rule => rule.param === 'iban' && rule.mustHave.includes( 'own' ) ), 'the account must be our own value' );
	assert.deepEqual( _survey.allow.map( rule => rule.label ), [ 'confidential' ], 'the survey allows confidential data only as a group' );
	assert.deepEqual( _invoices.allow, [], 'payments allow nothing confidential to leave' );
} );

test( 'G1 accepts a well-formed goal and binds it to a hash', () => {
	const _result = new ContractCheck().check( survey() );
	assert.equal( _result.ok, true, _result.problems.join( '; ' ) );
	assert.equal( survey().hash, survey().hash );
	assert.notEqual( survey().hash, survey( { goal: 'something else' } ).hash );
} );

test( 'G1 refuses unknown rules, bad values, past deadlines and goals without an outcome', () => {
	const _bad = new Contract( {
		id: 'x', goal: 'y', deadline: inHours( -1 ),
		criteria: [ { id: 'k1', type: 'min_group', values: { k: 1 } }, { id: 'k2', type: 'teleport', values: {} } ],
	}, registry );
	const _problems = new ContractCheck().check( _bad ).problems.join( '\n' );
	assert.match( _problems, /unknown criterion type: teleport/ );
	assert.match( _problems, /k1: k must be an integer >= 2/ );
	assert.match( _problems, /in the past/ );
	assert.match( _problems, /no outcome criterion/ );
} );

test( 'a child must keep every invariant of its ancestors', () => {
	const _parent = survey();
	const _child = new Contract( {
		id: 'pulse', goal: 'Get enough answers from the design team', deadline: inHours( 24 ),
		serves: { criterion: 'k1', precondition: 'enough-answers' },
		criteria: [
			{ id: 'c1', type: 'report_delivered', values: { to: 'agent', topic: 'pulse answers' } },
			{ id: 'c2', type: 'min_group', values: { k: 5 } },
		],
	}, registry );
	const _problems = new ContractCheck().check( _child, { ancestors: [ _parent ] } ).problems;
	assert.deepEqual( _problems, [ 'child drops invariant no_difference of survey' ] );
} );

test( 'G2 (7.2): a plan for another contract, an unknown parameter or a commitment the goal does not admit never runs', async () => {
	const [ PlanCheck, Catalog, Mission ] = await use( 'Core.Check.PlanCheck', 'Core.Move.Catalog', 'Core.Mission.Mission' );
	const _catalog = Catalog.load( Mission.load( 'invoices' ) );
	const _goal = invoices();
	const _pay = { move: 'payment.send', params: { invoiceId: 'R-1186', iban: 'DE02', amount: 100 }, labels: { iban: [ 'own' ] }, target: 'bank' };
	assert.equal( new PlanCheck().check( { contract: _goal.hash, steps: [ _pay ] }, { catalog: _catalog, contract: _goal } ).ok, true );
	const _nobody = new PlanCheck().check( { contract: _goal.hash, steps: [ { ..._pay, target: '' } ] }, { catalog: _catalog, contract: _goal } );
	assert.match( _nobody.problems.join(), /payment.send: no recipient/ );
	const _other = new PlanCheck().check( { contract: 'abc', steps: [ _pay ] }, { catalog: _catalog, contract: _goal } );
	assert.match( _other.problems.join(), /made for another contract/ );
	const _unknown = new PlanCheck().check( { steps: [ { ..._pay, params: { ..._pay.params, priority: 'urgent' } } ] }, { catalog: _catalog, contract: _goal } );
	assert.match( _unknown.problems.join(), /unknown parameter priority/ );
	const _survey = survey();
	const _commit = new PlanCheck().check( { steps: [ _pay ] }, { catalog: _catalog, contract: _survey } );
	assert.match( _commit.problems.join(), /commits to payment, which this goal does not admit/ );
} );

const [ Node ] = await use( 'Core.Node.Node' );

test( 'R6: a child serves an open criterion, its precondition was unmet, and it expresses exactly that precondition', () => {
	const _parent = new Node( { contract: survey( { budget: 20 } ) } );
	const _pre = { id: 'answers-design', type: 'number_in_range', values: { quantity: 'answers:design', min: 5 } };
	_parent.hitWall( 'precondition_missing', [], { precondition: _pre } );
	const _child = criteria => new Contract( {
		id: 'survey/answers-design', goal: 'Precondition answers-design for k1', deadline: inHours( 40 ), budget: 5, parent: 'h',
		serves: { criterion: 'k1', precondition: 'answers-design' },
		criteria: [ ...criteria, { id: 'k2', type: 'min_group', values: { k: 5 }, immutable: true }, { id: 'k3', type: 'no_difference', values: { k: 5 }, immutable: true } ],
	}, registry );
	const _check = contract => new ContractCheck().check( contract, { ancestors: [ _parent.contract ], parent: _parent } );
	assert.equal( _check( _child( [ { id: 'c1', type: 'number_in_range', values: _pre.values, origin: 'client' } ] ) ).ok, true );
	const _other = _check( _child( [ { id: 'c1', type: 'number_in_range', values: { quantity: 'answers:design', min: 3 }, origin: 'client' } ] ) );
	assert.match( _other.problems.join(), /do not express exactly precondition answers-design \(R6\)/ );
	_parent.addFact( { kind: 'precondition_met', evidenceClass: 'observation', source: 'child x', data: { id: 'answers-design' } } );
	assert.match( _check( _child( [ { id: 'c1', type: 'number_in_range', values: _pre.values, origin: 'client' } ] ) ).problems.join(), /already met in the parent/ );
} );

test( 'R6: a child made from a template (one per item) expresses a part of the criterion it serves', () => {
	const _parent = new Node( { contract: invoices() } );
	const _child = values => new Contract( {
		id: 'invoices/R-1186', goal: 'Invoice R-1186', deadline: inHours( 20 ), budget: 5, parent: 'h', serves: { criterion: 'k1', precondition: 'R-1186' },
		criteria: [ { id: 'c1', type: 'items_resolved', values, origin: 'client' }, ...[ 'k2', 'k3', 'k4', 'k5' ].map( id => _parent.contract.criteria
			.find( item => item.id === id ).describe() ).map( ( { kind: _k, ...rest } ) => rest ) ],
	}, registry );
	const _part = { collection: 'invoices', items: [ 'R-1186' ], outcomes: [ 'paid', 'escalated' ] };
	const _r6 = values => ContractCheck.contribution( _child( values ), _parent ).filter( item => /R6/.test( item ) );
	assert.deepEqual( _r6( _part ), [] );
	assert.match( _r6( { ..._part, items: [ 'R-9999' ] } ).join(), /no part of k1 \(R6\)/, 'an item the parent does not have' );
	assert.match( _r6( { ..._part, outcomes: [ 'paid', 'written_off' ] } ).join(), /no part of k1/, 'an outcome the parent does not admit' );
} );

test( 'R5: a child that closely resembles an ancestor is a question to the parent, not a refusal', () => {
	const _parent = survey();
	const _close = new Contract( {
		id: 'survey/again', goal: 'Find out why the design team is unhappy', deadline: inHours( 40 ), budget: 5, parent: 'h', serves: { criterion: 'k1', precondition: 'x' },
		criteria: [ { id: 'c1', type: 'report_delivered', values: { to: 'hr', topic: 'morale today' }, origin: 'client' },
			{ id: 'k2', type: 'min_group', values: { k: 5 }, immutable: true }, { id: 'k3', type: 'no_difference', values: { k: 5 }, immutable: true } ],
	}, registry );
	const _check = new ContractCheck().check( _close, { ancestors: [ _parent ] } );
	assert.equal( _check.ok, true );
	assert.ok( _check.questions.some( question => /goal resembles/.test( question ) ) );
} );

const [ CloseCheck ] = await use( 'Core.Check.CloseCheck' );
const { office } = await import( '../office.mjs' );

test( '3.2, G-10: only the client changes a confirmed contract, by ticket; G1 checks it again and refuses any change of an immutable rule', async () => {
	let _tickets = 0;
	const _judge = { verdict: 'escalate', reason: 'the group is too small', amendment: [ { criterion: 'k1', values: { topic: 'morale of the design team, first findings' } } ] };
	const _o = await office( {
		strategies: [ 'team-report' ],
		answers: { judge: _judge },
		person: ( ticket ) => {
			if ( !ticket.options.includes( 'change the goal as suggested' ) ) { return ticket.recommendation; }
			return ++_tickets === 1 ? 'change the goal as suggested' : 'close as failed';
		},
	} );
	const _root = await _o.run();
	const _amended = _o.events( _root, 'contract_amended' );
	assert.equal( _amended.length, 1 );
	assert.equal( _amended[ 0 ].by, 'test-person' );
	assert.equal( _root.contract.spec.amends, _amended[ 0 ].from );
	assert.equal( _root.contract.criteria.find( item => item.id === 'k1' ).values.topic, 'morale of the design team, first findings' );
	assert.equal( _o.egress.store.contract( _root.contract.hash ).status, 'confirmed', 'a person confirmed the change at the gate' );
	assert.deepEqual( _root.immutables, _root.contract.immutables() );
	const _forbidden = await _o.runner.judgment.amend( _root, { criterion: 'k2', values: { k: 2 } }, { by: 'test-person' } );
	assert.equal( _forbidden, false );
	assert.ok( _o.events( _root, 'amendment_refused' ).some( data => /immutable criterion k2 would change \(G-10\)/.test( data.problems.join() ) ) );
	_root.contract = new Contract( _root.contract.amend( { criterion: 'k2', values: { k: 2 } } ), registry );
	assert.match( new CloseCheck().check( _root ).dimensions.formal.join(), /immutable criterion changed/, 'G6 checks it at every close' );
} );
