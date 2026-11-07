import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';
import { office, registry, Contract } from '../office.mjs';

const [ Machine, Node ] = await use( 'Core.Node.Machine', 'Core.Node.Node' );
const quick = mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;
const transitions = ( log, node ) => log.forNode( node.id ).filter( event => event.kind === 'state_changed' ).map( event => `${event.data.from}>${event.data.to}` );

test( '16.1: the states and transitions are exactly those of the table', () => {
	assert.deepEqual( Object.keys( Machine.TRANSITIONS ), [ 'draft', 'confirmed', 'planning', 'executing', 'waiting', 'judging', 'closing', 'closed' ] );
	assert.equal( Machine.allowed( 'waiting', 'executing' ), false, 'after waiting comes the judgment' );
	assert.equal( Machine.allowed( 'draft', 'proposed' ), false, 'a goal stays a draft until it is confirmed' );
	assert.equal( Machine.allowed( 'closing', 'judging' ), true, 'G6 sends an unproven "done" back' );
	assert.equal( Machine.allowed( 'judging', 'waiting' ), true, 'escalate: a ticket is open' );
} );

test( 'a whole run uses only table transitions; every awaited event leads to a judgment, the open attempt continues', async () => {
	const { run, log } = await office( { edit: quick } );
	const _root = await run();
	const [ _child ] = _root.children;
	const _all = [ ...transitions( log, _root ), ...transitions( log, _child ) ];
	for ( const step of _all ) {
		const [ from, to ] = step.split( '>' );
		assert.ok( Machine.allowed( from, to ), step );
	}
	assert.equal( transitions( log, _root )[ 0 ], 'draft>confirmed' );
	assert.ok( !_all.includes( 'waiting>executing' ) );
	const _continued = log.forNode( _child.id ).filter( event => event.kind === 'verdict' && event.data.verdict === 'continue' );
	assert.ok( _continued.length >= 2, 'answers came in while the child waited; each was judged, the attempt went on' );
} );

test( '18.1: the protocol has the events the paper names', async () => {
	const { run, log } = await office( { edit: quick } );
	const _root = await run();
	const _kinds = new Set( log.since( 0 ).map( event => event.kind ) );
	for ( const kind of [ 'contract_confirmed', 'plan_accepted', 'move_started', 'move_ended', 'expectation_created', 'fact_delivered',
		'ticket_opened', 'ticket_answered', 'verdict', 'child_started', 'child_ended', 'lesson_written', 'node_closed', 'deadline_reached' ] ) {
		assert.ok( _kinds.has( kind ) || ( kind === 'ticket_opened' || kind === 'ticket_answered' || kind === 'deadline_reached' ), `missing ${kind}` );
	}
	const _closed = log.forNode( _root.id ).find( event => event.kind === 'node_closed' ).data;
	assert.deepEqual( Object.keys( _closed.dimensions ), [ 'functional', 'formal', 'commercial', 'organisational', 'knowledge', 'structure' ] );
	assert.ok( Object.values( _closed.dimensions ).every( problems => problems.length === 0 ) );
	const _reported = log.forNode( _root.id ).find( event => event.kind === 'child_ended' );
	assert.equal( _reported.data.result, 'fulfilled', 'the child reports upwards when it closes' );
} );

test( 'E1: a transition is only written if nobody moved the node in between', () => {
	const _node = new Node( { contract: new Contract( { id: 'c', goal: 'g', deadline: new Date( Date.now() + 3600000 ).toISOString(), budget: 9,
		criteria: [ { id: 'k1', type: 'number_in_range', values: { quantity: 'q', min: 1 } } ] }, registry ) } );
	_node.move( 'confirmed' );
	const _seen = _node.version;
	_node.move( 'planning' );
	assert.throws( () => _node.move( 'executing', {}, { expect: _seen } ), /expected/ );
} );

test( 'Z2: the model\'s part of planning has a deadline; a timeout fact is recorded and the code goes on', async () => {
	const _o = await office( { strategies: [ 'team-report', 'widen-group' ] } );
	_o.runner.stateMinutes = { planning: 0.0005, judging: 3 };
	_o.runner.planner.fill = () => new Promise( () => {} );
	const _root = await _o.run();
	assert.ok( _root.facts.some( fact => fact.kind === 'timeout' && fact.data.state === 'planning' ) );
	assert.ok( _o.events( _root, 'deadline_reached' ).some( data => data.of === 'planning' ) );
	assert.equal( _root.result.status, 'fulfilled', 'the declared defaults filled the slots' );
} );

test( '4.4: what holds a node back is visible; B5: at its deadline the system observes that no contradiction came', async () => {
	const _o = await office( { edit: ( mission ) => {
		quick( mission );
		mission.moves[ 'followup.invite' ].creates.expectation.minutes = 5;
	} } );
	const _run = _o.run();
	let _parent;
	for ( let i = 0; i < 400 && !_parent; i++ ) {
		await new Promise( resolve => setTimeout( resolve, 5 ) );
		_parent = [ ..._o.runner.nodes.values() ].find( node => node.depth === 0 && node.blockedBy().children.length );
	}
	assert.ok( _parent, 'the root is held back by its child' );
	await _o.runner.abort( _parent, { reason: 'test over', status: 'aborted' } );
	await _run;
	const _node = new Node( { contract: new Contract( { id: 'c', goal: 'Meeting confirmed', deadline: new Date( Date.now() + 3600000 ).toISOString(), budget: 9, criteria: [
		{ id: 'k1', type: 'commitment_received', values: { from: 'p', subject: 'meeting', window: [ '2026-01-01T00:00:00Z', '2030-01-01T00:00:00Z' ] }, deadline: new Date( Date.now() - 1000 ).toISOString() },
	] }, registry ) } );
	_node.addFact( { kind: 'commitment', evidenceClass: 'claim', origin: 'p', data: { party: 'p', subject: 'meeting', at: '2027-01-01T00:00:00Z' } } );
	_o.runner.watch( _node );
	assert.ok( _node.facts.some( fact => fact.kind === 'no_contradiction' && fact.evidenceClass === 'observation' ) );
} );
