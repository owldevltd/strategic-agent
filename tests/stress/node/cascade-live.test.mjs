// core/loop/cascade.js in a whole office (16.5): an abort that lands at a chosen event of a real run, in every phase of
// the loop, for the root or only a child, twice at once, and while a person approves the very action being withdrawn.
import assert from 'node:assert/strict';
import { attack, within } from '../hostile.mjs';
import { office, Contract, registry } from '../../office.mjs';
import { chain, until } from './kit.mjs';

const S = 'core/loop/cascade.js';
const quick = mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;
const slow = mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 10;
const END = [ 'not_sent', 'executed', 'unclear', 'refused' ];

// The simulated world goes on writing while a test runs (replies, and messages that become new cases of their own) and
// the office's stop() ends only the person: when the goal has ended, the world stops, whatever it started is aborted and
// closes, so nothing polls on after the test.
async function settle( o ) {
	o.runner.world?.stop();
	const _open = () => [ ...o.runner.nodes.values() ].filter( item => item.state !== 'closed' );
	await Promise.all( _open().map( item => o.runner.abort( item, { reason: 'the test is over', status: 'aborted' } ) ) );
	await until( () => !_open().length, 10000, 'the open processes' ).catch( () => null );
	o.stop();
}

// A run whose node (the root unless pick() says otherwise) is aborted right when the log writes the event when() picks.
async function abortAt( when, { edit = quick, pick = o => o.runner.root, status = 'aborted', approve, setup = () => {} } = {} ) {
	const o = await office( { edit, ...( approve ? { approve } : {} ) } );
	setup( o );
	const hit = { event: null, answer: null, node: null };
	o.log.subscribe( ( event ) => {
		if ( hit.event || !o.runner.root || !when( event, o ) ) { return; }
		hit.event = event;
		hit.node = pick( o, event );
		hit.answer = o.runner.abort( hit.node, { reason: 'the client stopped', status } );
	} );
	const root = await within( o.run(), 25000, 'the run' ).finally( () => settle( o ) );
	const events = o.log.since( 0, 1e9 );
	return { o, root, hit, events, after: events.filter( event => event.id > ( hit.event?.id ?? Infinity ) ) };
}

const nodesOf = o => [ ...o.runner.nodes.values() ];
const closedOnce = ( events, item ) => events.filter( event => event.node === item.id && event.kind === 'state_changed' && event.data.to === 'closed' ).length;

attack( S, 'G-1a: a goal aborted before it ran closes as aborted without a single move or outside action', async () => {
	const _o = await office( { edit: quick } );
	const _root = await _o.runner.start( new Contract( _o.mission.contractSpec(), registry ) );
	_o.runner.root = _root;
	assert.equal( await _o.runner.abort( _root, { reason: 'changed my mind', status: 'aborted' } ), true );
	await within( _o.runner.run( _root ), 20000 ).finally( () => settle( _o ) );
	assert.equal( _root.result.status, 'aborted' );
	const _kinds = _o.log.forNode( _root.id ).map( event => event.kind );
	assert.ok( !_kinds.includes( 'plan_accepted' ) && !_kinds.includes( 'move_started' ) );
	assert.deepEqual( _o.outbox.messages( 'hr' ), [] );
}, { timeout: 30000 } );

attack( S, 'G-1a: an abort that lands while the model fills the plan lets no plan be accepted afterwards', async () => {
	const _setup = ( o ) => {
		o.runner.planner.fill = () => new Promise( () => {} );
		o.runner.stateMinutes = { planning: 0.004, judging: 3 };
	};
	const { root, hit, after } = await abortAt( event => event.kind === 'strategy_scored', { setup: _setup } );
	assert.ok( hit.event );
	assert.equal( root.result.status, 'aborted' );
	assert.ok( !after.some( event => event.kind === 'plan_accepted' ), 'no start after the abort (G-1a, Z6)' );
}, { timeout: 30000 } );

attack( S, '16.5: an abort while a sandbox move runs ends the goal; nothing is reported to anyone', async () => {
	const { o, root, hit } = await abortAt( event => event.kind === 'sandbox_started' );
	assert.ok( hit.event );
	assert.equal( root.result.status, 'aborted' );
	assert.deepEqual( o.outbox.messages( 'hr' ), [] );
	assert.ok( nodesOf( o ).every( item => item.state === 'closed' ) );
}, { timeout: 30000 } );

attack( S, '16.5: an abort at the very start of the child aborts the whole tree, children closing before the root', async () => {
	const { o, root, events } = await abortAt( event => event.kind === 'child_started' );
	assert.equal( root.result.status, 'aborted' );
	const _closed = events.filter( event => event.kind === 'state_changed' && event.data.to === 'closed' ).map( event => event.node );
	assert.equal( _closed.at( -1 ), root.id, 'the root closes last (bottom-up)' );
	for ( const item of nodesOf( o ) ) {
		assert.equal( closedOnce( events, item ), 1 );
		chain( events, item.id );
	}
}, { timeout: 30000 } );

attack( S, '16.5: aborting only a child that waits for answers leaves its parent running; the parent hears of it and ends on its own', async () => {
	const _child = ( o, event ) => o.runner.nodes.get( event.node );
	const { o, root, hit, events } = await abortAt( ( event, office1 ) => event.kind === 'waiting_for' && office1.runner.nodes.get( event.node )?.depth === 1,
		{ pick: _child, edit: slow } );
	assert.equal( hit.node.result.status, 'aborted' );
	assert.equal( root.stopping, undefined, 'the abort does not go up' );
	assert.equal( root.state, 'closed' );
	const _ended = events.find( event => event.node === root.id && event.kind === 'child_ended' );
	assert.deepEqual( [ _ended.data.child, _ended.data.result ], [ hit.node.id, 'aborted' ] );
	assert.ok( nodesOf( o ).every( item => closedOnce( events, item ) === 1 ) );
}, { timeout: 30000 } );

attack( S, 'two aborts of the root at the same moment close every node exactly once', async () => {
	const _o = await office( { edit: slow } );
	const _run = _o.run();
	const _waits = await until( () => _o.log.since( 0, 1e9 ).find( event => event.kind === 'waiting_for' ), 20000, 'a waiting child' )
		.catch( error => settle( _o ).then( () => Promise.reject( error ) ) );
	assert.ok( _waits );
	// The world has done its part (the child waits for answers); messages of its own would only start new cases.
	_o.runner.world?.stop();
	const _answers = await Promise.all( [
		_o.runner.abort( _o.runner.root, { reason: 'deadline', status: 'failed' } ),
		_o.runner.abort( _o.runner.root, { reason: 'the client stopped', status: 'aborted' } ),
	] );
	const _root = await within( _run, 25000 ).finally( () => settle( _o ) );
	assert.deepEqual( _answers.sort(), [ false, true ] );
	assert.equal( _root.result.status, 'failed', 'the first abort decides' );
	const _events = _o.log.since( 0, 1e9 );
	assert.ok( nodesOf( _o ).every( item => closedOnce( _events, item ) === 1 ) );
	assert.equal( _events.filter( event => event.kind === 'node_closed' ).length, nodesOf( _o ).length );
}, { timeout: 30000 } );

attack( S, 'Z5: aborting a goal that has already closed answers false and writes nothing', async () => {
	const _o = await office( { edit: quick } );
	const _root = await within( _o.run(), 25000 ).finally( () => settle( _o ) );
	const _count = _o.log.since( 0, 1e9 ).length;
	assert.equal( await _o.runner.abort( _root, { reason: 'too late' } ), false );
	assert.equal( _o.log.since( 0, 1e9 ).length, _count );
	assert.equal( _root.result.status, 'fulfilled' );
}, { timeout: 30000 } );

attack( S, 'O9: an abort racing a person\'s approval leaves the invitation in an end state, never open', async () => {
	const _o = await office( { edit: slow, approve: approval => ( approval.summary.action === 'invite' ? null : true ) } );
	const _run = _o.run();
	const _pending = await until( () => _o.egress.pendingApprovals().find( item => item.summary.action === 'invite' ), 20000, 'the invitation approval' );
	const _late = _o.egress.decide( _pending.id, 'approve', 'fast-person', { reason: 'ok', explicit: true } ).catch( error => error );
	await _o.runner.abort( _o.runner.root, { reason: 'the client stopped', status: 'aborted' } );
	await _late;
	const _root = await within( _run, 25000 ).finally( () => settle( _o ) );
	assert.equal( _root.result.status, 'aborted' );
	const _status = _o.egress.store.delivery( _pending.delivery ).status;
	await until( () => END.includes( _o.egress.store.delivery( _pending.delivery ).status ), 10000, `an end state, not ${_status}` );
}, { timeout: 30000 } );

attack( S, '16.5: an abort during the judgment closes the node without a new plan', async () => {
	const { root, hit, after } = await abortAt( event => event.kind === 'state_changed' && event.data.to === 'judging' );
	assert.ok( hit.event );
	assert.equal( root.result.status, 'aborted' );
	assert.ok( !after.some( event => event.node === root.id && event.kind === 'plan_accepted' ) );
}, { timeout: 30000 } );

attack( S, '16.5: an abort that arrives while the goal is closing does not close it twice', async () => {
	const { o, root, events } = await abortAt( ( event, office1 ) => event.kind === 'state_changed' && event.data.to === 'closing' && event.node === office1.runner.root?.id );
	assert.ok( [ 'fulfilled', 'aborted' ].includes( root.result.status ), JSON.stringify( root.result ) );
	assert.ok( nodesOf( o ).every( item => closedOnce( events, item ) === 1 ) );
	chain( events, root.id );
}, { timeout: 30000 } );
