// What a plan may need at the gate (AGENCY_PROPOSALS), seen from the core: the strategist names it beside its
// strategy (core/plan/planner.js), the node waits for the operator's decision at the gate (core/meta/proposals.js),
// an approved action is learned by the process (lib/actions.js) with the send move trusted code derives for it
// (core/move/catalog.js). The gate decides; the core can only ask and wait.
import assert from 'node:assert/strict';
import { attack, attacks, within } from '../hostile.mjs';
import { Planner, Spy, nodeOf, catalogOf, survey, app } from './fixtures.mjs';

const [ Proposals, Catalog, Actions ] = await app.use( [ 'Core.Meta.Proposals', 'Core.Move.Catalog', 'Lib.Actions' ] );
const PLANNER = 'core/plan/planner.js';
const META = 'core/meta/proposals.js';
const CATALOG = 'core/move/catalog.js';
const ACTIONS = 'lib/actions.js';
const NOTICE = { criticality: 'outward', carries: [ 'message' ], says: 'a short notice to a customer about their order' };
const STEPS = [ { move: 'report.draft', params: {}, from: [], as: 'note', target: '' }, { move: 'notice.send', params: {}, from: [ 'note' ], as: '', target: 'C104' } ];
const reset = () => [ 'notice', 'memo', 'deposit', 'bulletin' ].forEach( name => Actions.forget( name ) );

// The planner: what it asks for, and what it hands back beside the strategy.
async function propose( answer, needs ) {
	const _provider = new Spy( { strategist: answer } );
	const _strategy = await within( new Planner( { provider: _provider, catalog: catalogOf( survey ) } ).propose( nodeOf(), { id: 'proposed-1', needs } ), 3000 );
	return { strategy: _strategy, seen: _provider.seen.at( -1 ) };
}

attack( PLANNER, 'needs: with proposals on the strategist may name actions and master data, and is told never an account', async () => {
	const { seen } = await propose( { rationale: 'x', steps: STEPS }, true );
	assert.deepEqual( Object.keys( seen.contract.fields ).filter( key => [ 'actions', 'master' ].includes( key ) ), [ 'actions', 'master' ] );
	assert.match( seen.instructions, /under actions; its move is then "<name>\.send"/ );
	assert.match( seen.instructions, /Never an account, never a value from a message/ );
} );

attack( PLANNER, 'needs: with proposals off nothing of the kind is offered', async () => {
	const { seen, strategy } = await propose( { rationale: 'x', steps: STEPS }, false );
	assert.equal( 'actions' in seen.contract.fields, false );
	assert.equal( 'needs' in strategy, false );
} );

attack( PLANNER, 'needs: they travel beside the strategy, never in what the person approves as the strategy', async () => {
	const { strategy } = await propose( { rationale: 'x', steps: STEPS, actions: [ { name: 'notice', ...NOTICE } ] }, true );
	assert.deepEqual( strategy.needs, { actions: [ { name: 'notice', ...NOTICE } ], master: [] } );
	assert.deepEqual( strategy.steps.map( item => item.move ), [ 'report.draft', 'notice.send' ] );
} );

// The core waits for the gate.
function setup( { decide = () => 'approved', refuse = null, on = true, stopAt = null } = {} ) {
	const _asked = [];
	const _node = { id: 'n1', contract: { hash: 'h1', deadline: '2999-01-01T00:00:00Z', spec: { criteria: [ { values: { to: 'C104', topic: 'late' } } ] } },
		ancestors: () => [], events: [], stopping: null };
	_node.emit = ( kind, data ) => _node.events.push( [ kind, data ] );
	let _polls = 0;
	const _gate = {
		proposeAt: async ( request ) => {
			if ( refuse ) { throw new Error( refuse ); }
			_asked.push( request );
			return { id: `gp-${_asked.length}`, name: request.body.name || `${request.body.kind}:${request.body.value}`, status: 'proposed' };
		},
		gateProposal: async ( id ) => {
			_polls += 1;
			if ( stopAt && _polls >= stopAt ) { _node.stopping = { status: 'aborted' }; }
			const _status = decide( id, _polls );
			return { id, status: _status };
		},
	};
	const _runner = { proposals: on, gate: _gate, pollMs: 1, catalog: catalogOf( survey ) };
	return { node: _node, runner: _runner, asked: _asked };
}
const meta = () => Object.create( Proposals.prototype );

attack( META, 'gate: nothing needed is nothing to wait for', async () => {
	const s = setup();
	assert.equal( await meta().gateSetUp( s.node, { actions: [], master: [] }, s.runner ), true );
	assert.deepEqual( s.asked, [] );
} );

attack( META, 'gate: with proposals off a plan that needs the gate cannot be set up', async () => {
	const s = setup( { on: false } );
	assert.equal( await meta().gateSetUp( s.node, { actions: [ { name: 'notice', ...NOTICE } ] }, s.runner ), false );
	assert.deepEqual( s.asked, [] );
} );

attack( META, 'gate: an approved action is learned with its send move; the node waited for the decision', async () => {
	reset();
	try {
		const s = setup( { decide: ( _id, polls ) => ( polls < 3 ? 'proposed' : 'approved' ) } );
		assert.equal( await meta().gateSetUp( s.node, { actions: [ { name: 'notice', ...NOTICE } ] }, s.runner ), true );
		assert.deepEqual( s.asked[ 0 ], { kind: 'action', body: { name: 'notice', entry: NOTICE }, contract: 'h1', node: 'n1' } );
		assert.equal( Actions.load().criticality( 'notice' ), 'outward' );
		assert.equal( s.runner.catalog.get( 'notice.send' ).action, 'notice' );
		assert.deepEqual( s.node.events.map( item => item[ 0 ] ), [ 'gate_proposal_submitted', 'gate_proposal_decided' ] );
	} finally {
		reset();
	}
} );

attacks( META, [
	{ name: 'gate: a rejected action ends the setup', options: { decide: () => 'rejected' }, event: 'gate_proposal_decided' },
	{ name: 'gate: a proposal the gate refuses ends the setup', options: { refuse: 'the action report exists already' }, event: 'gate_proposal_refused' },
	{ name: 'gate: a node that is stopped while it waits stops waiting', options: { decide: () => 'proposed', stopAt: 2 }, event: 'gate_proposal_decided' },
], async ( { options, event } ) => {
	reset();
	const s = setup( options );
	assert.equal( await meta().gateSetUp( s.node, { actions: [ { name: 'notice', ...NOTICE } ] }, s.runner ), false );
	assert.ok( s.node.events.some( item => item[ 0 ] === event ) );
	assert.equal( Actions.load().known( 'notice' ), false, 'nothing learned' );
} );

attacks( META, [
	{ name: 'gate: a value the confirmed goal names is labelled own', value: 'C104', labels: [ 'own' ] },
	{ name: 'gate: a value the goal does not name is labelled foreign, for the gate to refuse', value: 'DE89370400440532013000', labels: [ 'foreign' ] },
	{ name: 'gate: a contact pair with a part the goal does not name is foreign', value: 'C104 billing@c104.example', labels: [ 'foreign' ] },
], async ( { value, labels } ) => {
	const s = setup();
	await meta().gateSetUp( s.node, { master: [ { kind: 'contact', value } ] }, s.runner );
	assert.deepEqual( s.asked[ 0 ].labels, labels );
} );

attack( META, 'gate: at most two actions and five values are asked for at once', async () => {
	const s = setup( { decide: () => 'rejected' } );
	const _many = { actions: Array.from( { length: 5 }, ( _x, i ) => ( { name: `a${i}`, ...NOTICE } ) ) };
	await meta().gateSetUp( s.node, _many, s.runner );
	assert.equal( s.asked.length, 1, 'the first rejection ends it' );
	const s2 = setup();
	await meta().gateSetUp( s2.node, { master: Array.from( { length: 9 }, ( _x, i ) => ( { kind: 'recipient', value: `v${i}` } ) ) }, s2.runner );
	assert.equal( s2.asked.length, 5 );
} );

attacks( META, [
	{ name: 'entry: only the fields of an action are passed on', item: { name: 'notice', ...NOTICE, channel: 'smtp', criticality: 'outward' }, keys: [ 'criticality', 'carries', 'says' ] },
	{ name: 'entry: empty fields are left out', item: { name: 'notice', criticality: 'outward', carries: [], says: 'x', recipient: '', params: null }, keys: [ 'criticality', 'carries', 'says' ] },
	{ name: 'entry: nothing is nothing', item: null, keys: [] },
], ( { item, keys } ) => {
	assert.deepEqual( Object.keys( Proposals.entry( item ) ), keys );
} );

// The send move trusted code derives for an approved action.
attacks( CATALOG, [
	{ name: 'send move: a message goes into body', entry: NOTICE, param: 'body' },
	{ name: 'send move: an action without a message takes the fields of its input', entry: { criticality: 'money_or_law', carries: [ 'money' ], says: 'x' }, param: undefined },
], ( { entry, param } ) => {
	const _move = Catalog.sendMove( 'notice', entry );
	assert.equal( _move.param, param );
	assert.deepEqual( [ _move.executor, _move.action, _move.evidence[ 0 ], _move.derived ], [ 'code', 'notice', 'delivered', true ] );
} );

attack( CATALOG, 'send move: declared parameters are optional parameters of the move, with their types', () => {
	assert.deepEqual( Catalog.sendMove( 'deposit', { ...NOTICE, params: { amount: 'number', ref: 'string' } } ).params,
		{ amount: { type: 'number', optional: true }, ref: { type: 'string', optional: true } } );
} );

attack( CATALOG, 'derive: every learned action gets its send move, with the criticality of the table; a move of that name stays', () => {
	reset();
	try {
		Actions.learn( { notice: NOTICE, deposit: { criticality: 'money_or_law', carries: [ 'money' ], says: 'a deposit' } } );
		const _catalog = catalogOf( survey );
		_catalog.moves[ 'deposit.send' ] = { executor: 'human', mine: true };
		Catalog.derive( _catalog );
		assert.equal( _catalog.get( 'notice.send' ).criticality, 'outward' );
		assert.equal( _catalog.get( 'deposit.send' ).mine, true );
	} finally {
		reset();
	}
} );

// The process learns what the gate approved.
attack( ACTIONS, 'learn: an approved action is in every table this process loads from then on, and forget takes it out', () => {
	reset();
	try {
		assert.deepEqual( Actions.learn( { notice: NOTICE } ), [ 'notice' ] );
		assert.equal( Actions.load().criticality( 'notice' ), 'outward' );
		assert.deepEqual( Object.keys( Actions.learned() ), [ 'notice' ] );
		Actions.forget( 'notice' );
		assert.equal( Actions.load().known( 'notice' ), false );
	} finally {
		reset();
	}
} );

attacks( ACTIONS, [
	{ name: 'learn: a name the files have is never replaced', table: { report: NOTICE }, said: /exists already/ },
	{ name: 'learn: an action below outward is refused', table: { memo: { ...NOTICE, criticality: 'internal' } }, said: /at least outward/ },
	{ name: 'learn: money below money_or_law is refused', table: { deposit: { ...NOTICE, carries: [ 'money' ] } }, said: /money_or_law/ },
	{ name: 'learn: a field the table does not have is refused', table: { bulletin: { ...NOTICE, channel: 'x' } }, said: /no field/ },
], ( { table, said } ) => {
	reset();
	assert.throws( () => Actions.learn( table ), said );
	assert.deepEqual( Actions.learned(), {} );
} );

attack( ACTIONS, 'learn: what is handed back is a copy; changing it changes nothing learned', () => {
	reset();
	try {
		Actions.learn( { notice: NOTICE } );
		Actions.learned().notice.criticality = 'read';
		assert.equal( Actions.load().criticality( 'notice' ), 'outward' );
	} finally {
		reset();
	}
} );

attack( ACTIONS, 'learn: a second learning of the same action changes nothing', () => {
	reset();
	try {
		Actions.learn( { notice: NOTICE } );
		assert.deepEqual( Actions.learn( { notice: { ...NOTICE, criticality: 'irreversible' } } ), [] );
		assert.equal( Actions.load().criticality( 'notice' ), 'outward' );
	} finally {
		reset();
	}
} );
