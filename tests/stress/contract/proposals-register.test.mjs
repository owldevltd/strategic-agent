// core/meta/proposals.js, part 2: the proposal's own process (6.1). Its goal uses only catalog types; trusted code
// checks exactly this version, a person says yes to exactly this question, and trusted code registers exactly the
// approved, green version. Nothing reaches the catalog without approval, a red check or a self-approval never
// registers, a replay changes nothing, and after a restart only what a person approved comes back, unchanged.
import assert from 'node:assert/strict';
import { attack } from '../hostile.mjs';
import { registry, Contract, ContractCheck, Node, Proposals, memoryDb, catalogOf, nodeOf, survey, inHours } from './fixtures.mjs';

const SUBJECT = 'core/meta/proposals.js';
const STRATEGY = { id: 'report-twice', serves: 'report_delivered', price: 2, steps: [ { move: 'report.draft' }, { move: 'report.send' } ] };
const RED = { id: 'leak-all', serves: 'report_delivered', price: 1, steps: [ { move: 'mail.everyone' } ] };
const CRITERION = { type: 'reported_and_counted', params: [ 'team' ], all: [
	{ type: 'report_delivered', values: { to: 'hr', topic: '{{team}}' } }, { type: 'number_in_range', values: { quantity: 'answers:{{team}}', min: 3 } },
] };
const ConfirmedBy = registry.types.confirmed_by;

// A runner of its own per test: the mission's strategies, a fresh catalog and a registry copy that can grow.
function runner( mission = 'survey' ) {
	const _registry = { types: { ...registry.types }, has: type => Boolean( _registry.types[ type ] ) };
	_registry.create = spec => registry.create.call( _registry, spec );
	return { mission: { id: mission, strategies: [ ...survey.strategies ] }, catalog: catalogOf( survey ), registry: _registry };
}

const fresh = () => new Proposals( memoryDb() );
const submit = ( proposals, body, kind = 'strategy', mission = 'survey' ) => proposals.submit( kind, body, { mission, by: 'node-requester' } );

// The process node of a proposal, with its contract; confirm() adds the person's answer to its question.
function processOf( proposals, version, kind = 'strategy' ) {
	const _body = proposals.get( version ).body;
	const _spec = Proposals.contract( kind, _body, version, { parent: nodeOf(), deadline: inHours( 20 ), budget: 4 } );
	const _node = new Node( { contract: new Contract( _spec, registry ) } );
	_node.confirm = ( choice = 'yes', question = _spec.criteria[ 1 ].values.question, source = 'person hr-lead' ) => _node.addFact( {
		kind: 'confirmation', evidenceClass: 'confirmation', source, data: { role: 'client', question: ConfirmedBy.key( question ), choice },
	} );
	return _node;
}

const ctx = ( node, run ) => ( { node, runner: run } );

attack( SUBJECT, 'nothing is registered without a person\'s yes', () => {
	const _proposals = fresh();
	const _version = submit( _proposals, STRATEGY );
	const _runner = runner();
	for ( const approved of [ null, undefined, '', 0, false ] ) {
		assert.equal( _proposals.register( _version, { approved, runner: _runner } ), false, String( approved ) );
	}
	assert.equal( _proposals.get( _version ).status, 'proposed' );
	assert.equal( _runner.mission.strategies.some( item => item.id === STRATEGY.id ), false );
} );

attack( SUBJECT, 'an approved strategy is registered with its version and approver', () => {
	const _proposals = fresh();
	const _version = submit( _proposals, STRATEGY );
	const _runner = runner();
	assert.equal( _proposals.register( _version, { approved: 'person hr-lead', runner: _runner } ), true );
	assert.deepEqual( _runner.mission.strategies.find( item => item.id === STRATEGY.id ).approved, { version: _version, by: 'person hr-lead' } );
	assert.deepEqual( [ _proposals.get( _version ).status, _proposals.get( _version ).approvedBy ], [ 'approved', 'person hr-lead' ] );
} );

attack( SUBJECT, 'a registered move always inherits labels and never acts outward', () => {
	const _proposals = fresh();
	const _runner = runner();
	const _ai = submit( _proposals, { id: 'summary.short', executor: 'ai', role: 'writer', contract: { fields: { text: { type: 'string' } } }, criticality: 'money_or_law' }, 'move' );
	const _wait = submit( _proposals, { id: 'pause.long', executor: 'wait', criticality: 'internal' }, 'move' );
	_proposals.register( _ai, { approved: 'p', runner: _runner } );
	_proposals.register( _wait, { approved: 'p', runner: _runner } );
	const [ _summary, _pause ] = [ _runner.catalog.get( 'summary.short' ), _runner.catalog.get( 'pause.long' ) ];
	assert.deepEqual( [ _summary.inherit, _summary.criticality, _pause.criticality ], [ true, 'internal', 'read' ] );
} );

attack( SUBJECT, 'a registered criterion type holds only when all its parts hold', () => {
	const _proposals = fresh();
	const _runner = runner();
	_proposals.register( submit( _proposals, CRITERION, 'criterion' ), { approved: 'p', runner: _runner } );
	const _criterion = _runner.registry.create( { id: 'k9', type: 'reported_and_counted', values: { team: 'design' } } );
	const _measured = { id: 'f1', kind: 'measured', evidenceClass: 'observation', data: { quantity: 'answers:design', value: 4 } };
	const _sent = { id: 'f2', kind: 'delivered', evidenceClass: 'observation', data: { action: 'report', to: 'hr' } };
	assert.deepEqual( [ _criterion.check( [ _measured ] ).met, _criterion.check( [ _measured, _sent ] ).met ], [ false, true ] );
	assert.equal( registry.has( 'reported_and_counted' ), false, 'the shared registry is untouched' );
} );

attack( SUBJECT, 'a red proposal is never registered, even with a yes', () => {
	const _proposals = fresh();
	const _version = submit( _proposals, RED );
	assert.equal( _proposals.check( _version, { catalog: catalogOf( survey ), registry, strategies: survey.strategies } ).result, 'red' );
	assert.equal( _proposals.register( _version, { approved: 'person hr-lead', runner: runner() } ), false );
} );

attack( SUBJECT, 'the node that proposed a strategy cannot approve it itself', () => {
	const _proposals = fresh();
	const _version = submit( _proposals, STRATEGY );
	assert.equal( _proposals.register( _version, { approved: _proposals.get( _version ).by, runner: runner() } ), false );
} );

attack( SUBJECT, 'registering the same version twice applies it once', () => {
	const _proposals = fresh();
	const _version = submit( _proposals, STRATEGY );
	const _runner = runner();
	_proposals.register( _version, { approved: 'p', runner: _runner } );
	_proposals.register( _version, { approved: 'p', runner: _runner } );
	assert.equal( _runner.mission.strategies.filter( item => item.id === STRATEGY.id ).length, 1 );
} );

attack( SUBJECT, 'a second version of an id already in the catalog does not replace the first', () => {
	const _proposals = fresh();
	const _runner = runner();
	_proposals.register( submit( _proposals, STRATEGY ), { approved: 'p', runner: _runner } );
	_proposals.register( submit( _proposals, { ...STRATEGY, steps: [ { move: 'report.send' } ] } ), { approved: 'p', runner: _runner } );
	assert.deepEqual( _runner.mission.strategies.find( item => item.id === STRATEGY.id ).steps, STRATEGY.steps );
} );

attack( SUBJECT, 'an approved strategy cannot replace a mission strategy of the same id', () => {
	const _proposals = fresh();
	const _runner = runner();
	_proposals.register( submit( _proposals, { ...STRATEGY, id: 'team-report' } ), { approved: 'p', runner: _runner } );
	assert.equal( _runner.mission.strategies.filter( item => item.id === 'team-report' ).length, 1 );
	assert.equal( _runner.mission.strategies.find( item => item.id === 'team-report' ).approved, undefined );
} );

attack( SUBJECT, 'an unknown version is never registered', () => {
	assert.equal( fresh().register( 'ffffffffffffffff', { approved: 'p', runner: runner() } ), false );
} );

attack( SUBJECT, 'after a restart only what a person approved for this mission comes back; criterion types for every mission', () => {
	const _proposals = fresh();
	const _approved = submit( _proposals, STRATEGY );
	submit( _proposals, { ...STRATEGY, id: 'only-proposed' } );
	const _other = submit( _proposals, { ...STRATEGY, id: 'other-mission' }, 'strategy', 'invoices' );
	const _type = submit( _proposals, CRITERION, 'criterion', 'invoices' );
	[ _approved, _other, _type ].forEach( version => _proposals.register( version, { approved: 'p', runner: runner() } ) );
	const _restarted = runner();
	_proposals.applyApproved( _restarted );
	const _added = _restarted.mission.strategies.filter( item => item.approved ).map( item => item.id );
	assert.deepEqual( _added, [ 'report-twice' ] );
	assert.equal( _restarted.registry.has( 'reported_and_counted' ), true );
} );

attack( SUBJECT, 'a body changed in the store after approval is not applied after a restart', () => {
	const _proposals = fresh();
	const _version = submit( _proposals, STRATEGY );
	_proposals.register( _version, { approved: 'p', runner: runner() } );
	_proposals.db.run( 'UPDATE proposals SET body = :body WHERE version = :version', {
		version: _version, body: JSON.stringify( { ...STRATEGY, steps: [ { move: 'meta.register' } ] } ),
	} );
	const _restarted = runner();
	_proposals.applyApproved( _restarted );
	assert.equal( _restarted.mission.strategies.some( item => item.id === STRATEGY.id ), false );
} );

attack( SUBJECT, 'a status set to approved in the store without an approver is not applied', () => {
	const _proposals = fresh();
	submit( _proposals, STRATEGY );
	_proposals.db.run( 'UPDATE proposals SET status = \'approved\'' );
	const _restarted = runner();
	_proposals.applyApproved( _restarted );
	assert.equal( _restarted.mission.strategies.some( item => item.id === STRATEGY.id ), false );
} );

// The two trusted code moves, run from the process.

attack( SUBJECT, 'only check and register are moves of a proposal', () => {
	const _proposals = fresh();
	for ( const name of [ 'apply', 'approve', '__proto__', '' ] ) {
		assert.throws( () => _proposals.run( name, { move: `meta.${name}`, params: {} }, {} ), /is no move of a proposal/ );
	}
} );

attack( SUBJECT, 'the trusted check records a green test run on exactly this version and no wall', () => {
	const _proposals = fresh();
	const _version = submit( _proposals, STRATEGY );
	const _out = _proposals.run( 'check', { move: 'meta.check', params: { version: _version } }, ctx( processOf( _proposals, _version ), runner() ) );
	assert.deepEqual( _out.facts.map( fact => [ fact.kind, fact.data ] ), [ [ 'test_run', { test: 'strategy_check', commit: _version, result: 'green' } ] ] );
	assert.equal( _out.wall, null );
} );

attack( SUBJECT, 'a red check records a red run and a wall that names the problems', () => {
	const _proposals = fresh();
	const _version = submit( _proposals, RED );
	const _out = _proposals.run( 'check', { move: 'meta.check', params: { version: _version } }, ctx( processOf( _proposals, _version ), runner() ) );
	assert.equal( _out.facts[ 0 ].data.result, 'red' );
	assert.deepEqual( [ _out.wall.cause, /mail.everyone is not in the catalog/.test( _out.wall.reason ) ], [ 'plan_refused', true ] );
} );

attack( SUBJECT, 'registering without the person\'s yes is a wall, and nothing is registered', () => {
	const _proposals = fresh();
	const _version = submit( _proposals, STRATEGY );
	const _runner = runner();
	const _node = processOf( _proposals, _version );
	_node.confirm( 'no' );
	const _out = _proposals.run( 'register', { move: 'meta.register', params: { version: _version } }, ctx( _node, _runner ) );
	assert.equal( _out.wall.cause, 'rejected_by_person' );
	assert.equal( _runner.mission.strategies.some( item => item.id === STRATEGY.id ), false );
} );

attack( SUBJECT, 'a yes to another question does not approve this proposal', () => {
	const _proposals = fresh();
	const _version = submit( _proposals, STRATEGY );
	const _node = processOf( _proposals, _version );
	_node.confirm( 'yes', 'Add the strategy "something-else" to the catalog?' );
	assert.equal( _proposals.run( 'register', { move: 'meta.register', params: { version: _version } }, ctx( _node, runner() ) ).wall.cause, 'rejected_by_person' );
} );

attack( SUBJECT, 'with the person\'s yes exactly this version is registered and the catalog state is reported', () => {
	const _proposals = fresh();
	const _version = submit( _proposals, STRATEGY );
	const _runner = runner();
	const _node = processOf( _proposals, _version );
	_node.confirm();
	const _out = _proposals.run( 'register', { move: 'meta.register', params: { version: _version } }, ctx( _node, _runner ) );
	assert.deepEqual( _out.value, { registered: STRATEGY.id } );
	assert.deepEqual( _out.facts[ 0 ].data, { object: 'catalog', field: `strategy:${STRATEGY.id}`, value: _version } );
	assert.equal( _proposals.get( _version ).approvedBy, 'person hr-lead' );
} );

attack( SUBJECT, 'a yes does not register a version whose trusted check was red', () => {
	const _proposals = fresh();
	const _version = submit( _proposals, RED );
	const _runner = runner();
	const _node = processOf( _proposals, _version );
	_node.addFact( _proposals.run( 'check', { move: 'meta.check', params: { version: _version } }, ctx( _node, _runner ) ).facts[ 0 ] );
	_node.confirm();
	const _out = _proposals.run( 'register', { move: 'meta.register', params: { version: _version } }, ctx( _node, _runner ) );
	assert.ok( _out.wall );
	assert.equal( _runner.mission.strategies.some( item => item.id === RED.id ), false );
} );

// The goal of the process.

attack( SUBJECT, 'the process goal asks for a green check, the person\'s yes and the catalog state of exactly this version', () => {
	const _parent = nodeOf();
	const _spec = Proposals.contract( 'strategy', STRATEGY, 'abcdef0123456789', { parent: _parent, deadline: inHours( 20 ), budget: 4 } );
	assert.deepEqual( _spec.criteria.map( item => [ item.type, item.values.commit || item.values.value || item.values.role ] ), [
		[ 'test_green', 'abcdef0123456789' ], [ 'confirmed_by', 'client' ], [ 'state_is', 'abcdef0123456789' ],
	] );
	assert.deepEqual( [ _spec.kind, _spec.parent, _spec.id ], [ 'meta', _parent.contract.hash, 'survey-goal/strategy-abcdef' ] );
	assert.equal( _spec.value, 4 );
} );

attack( SUBJECT, 'the person\'s question names the proposal and what it does', () => {
	const _spec = Proposals.contract( 'strategy', STRATEGY, 'abcdef0123456789', { parent: nodeOf(), deadline: inHours( 20 ), budget: 4 } );
	assert.equal( _spec.criteria[ 1 ].values.question,
		'Add the strategy "report-twice" to the catalog? It serves report_delivered with report.draft → report.send.' );
	assert.equal( Proposals.summary( 'move', { executor: 'ai', describe: 'a short summary' } ), 'A ai move: a short summary' );
	assert.equal( Proposals.summary( 'criterion', CRITERION ), 'It holds when all of report_delivered, number_in_range hold.' );
} );

attack( SUBJECT, 'the process goal passes G1 as a goal of catalog types', () => {
	const _spec = Proposals.contract( 'strategy', STRATEGY, 'abcdef0123456789', { parent: nodeOf(), deadline: inHours( 20 ), budget: 4 } );
	const _contract = new Contract( _spec, registry );
	assert.deepEqual( _contract.unknown, [] );
	assert.deepEqual( new ContractCheck().check( _contract ).problems, [] );
} );
