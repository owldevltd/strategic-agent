import { test } from 'node:test';
import assert from 'node:assert/strict';
import { office } from '../office.mjs';

const until = async ( check, ms = 5000 ) => {
	for ( const end = Date.now() + ms; Date.now() < end; ) {
		const _value = check();
		if ( _value ) { return _value; }
		await new Promise( resolve => setTimeout( resolve, 5 ) );
	}
	throw new Error( 'timed out waiting' );
};

// The invitation waits long enough for the abort to land while the child waits for answers.
const slow = mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 10;

test( 'abort by the client while a child waits: down the tree, waiting released, nothing sent afterwards', async () => {
	const _o = await office( { edit: slow } );
	const _run = _o.run();
	const _waits = await until( () => _o.log.since( 0 ).find( event => event.kind === 'waiting_for' ) );
	const _child = _o.runner.nodes.get( _waits.node );
	const _root = _child.parent;
	await _o.runner.abort( _root, { reason: 'the client changed their mind', status: 'aborted' } );
	await _run;
	assert.deepEqual( _root.result.status, 'aborted' );
	assert.equal( _child.result.status, 'aborted' );
	assert.match( _child.result.reason, /aborted from above/ );
	// Processes of the root (a reply that arrived after its expectation closed is a new case, 8.1) close before it too.
	const _order = _o.log.since( 0 ).filter( event => event.kind === 'state_changed' && event.data.to === 'closed' ).map( event => event.node );
	assert.deepEqual( _order.filter( id => [ _child.id, _root.id ].includes( id ) ), [ _child.id, _root.id ], 'children close first, bottom-up' );
	assert.equal( _order.at( -1 ), _root.id, 'the root closes last' );
	assert.deepEqual( _o.outbox.messages( 'hr' ), [], 'no report after the abort' );
	assert.equal( _o.db.get( 'SELECT status FROM expectations' ).status, 'closed' );
} );

test( 'abort while an action waits for approval: the gate withdraws it, it is not sent (O9)', async () => {
	const _o = await office( { approve: approval => ( approval.summary.action === 'invite' ? null : true ) } );
	const _run = _o.run();
	const _waiting = await until( () => _o.egress.pendingApprovals().find( item => item.summary.action === 'invite' ) );
	const _root = [ ..._o.runner.nodes.values() ].find( node => node.depth === 0 );
	await _o.runner.abort( _root, { reason: 'stop', status: 'aborted' } );
	await _run;
	assert.equal( _o.egress.store.delivery( _waiting.delivery ).status, 'not_sent' );
	assert.deepEqual( _o.outbox.messages( 'design' ), [] );
	await assert.rejects( _o.egress.decide( _waiting.id, 'approve', 'late-person' ), /no pending approval/ );
	assert.deepEqual( _root.result.unclear, [] );
} );

test( 'the deadline of the root starts the cascade on its own, even while everything waits', async () => {
	const _waitHere = [ {
		id: 'invite-and-wait', serves: 'report_delivered', cost: 1, startCurve: { p0: 0.9, tauH: 0.0001 },
		steps: [ { move: 'followup.invite', target: 'design', params: { questions: 'workload' }, as: 'invite' }, { move: 'followup.wait', for: 'invite' } ],
	} ];
	const _o = await office( { edit: slow, strategies: _waitHere } );
	const _spec = _o.mission.contractSpec();
	_spec.deadline = new Date( Date.now() + 700 ).toISOString();
	const _root = await _o.run( _spec );
	assert.equal( _root.result.status, 'failed' );
	assert.match( _root.result.reason, /deadline/ );
	assert.ok( _root.children.every( child => child.state === 'closed' ) );
} );

test( 'an exhausted budget closes the goal as failed', async () => {
	// The first report fits the budget; the person's minutes for the escalation do not, and the goal stops there.
	const _o = await office( { edit: slow, person: ticket => ticket.options[ 0 ] } );
	const _spec = _o.mission.contractSpec();
	_spec.budget = 2;
	const _root = await _o.run( _spec );
	assert.equal( _root.result.status, 'failed', JSON.stringify( _root.result ) );
	assert.match( _root.result.reason, /budget/ );
} );

test( 'a move that runs past its lease is ended by the supervisor, and what it would still return is discarded (A3, A4)', async () => {
	const _hang = [ { id: 'hang', serves: 'report_delivered', cost: 1, startCurve: { p0: 0.9, tauH: 1 }, steps: [ { move: 'test.sleep', as: 'late' } ] } ];
	const _o = await office( {
		strategies: _hang,
		edit: ( mission ) => {
			mission.moves[ 'test.sleep' ] = { executor: 'code', tool: 'tests/fixtures/sleep.py', cost: 0.05, leaseMaxMin: 0.005 };
		},
	} );
	const _started = Date.now();
	const _root = await _o.run();
	assert.ok( Date.now() - _started < 3000, 'the supervisor did not wait for the move' );
	assert.equal( _root.walls[ 0 ].cause, 'lease_expired' );
	assert.ok( _o.events( _root, 'lease_expired' ).length );
	assert.ok( !_o.events( _root, 'value' ).some( value => value.name === 'late' ), 'nothing of the late move was written' );
} );

test( 'Z6: an abort comes before everything else; a node that waits for answers is woken for it at once', async () => {
	const _o = await office( { edit: ( mission ) => {
		mission.moves[ 'followup.invite' ].creates.expectation.minutes = 30;
		mission.world.people.forEach( ( person ) => {
			person.replies = [];
		} );
	} } );
	const _run = _o.run();
	let _child;
	for ( let i = 0; i < 400 && !_child; i++ ) {
		await new Promise( resolve => setTimeout( resolve, 5 ) );
		_child = [ ..._o.runner.nodes.values() ].find( node => node.depth === 1 && node.state === 'waiting' && node.waitingOn?.move === 'followup.wait' );
	}
	assert.ok( _child, 'the child waits for answers that do not come' );
	const _started = Date.now();
	await _o.runner.abort( _o.runner.root, { reason: 'aborted by the client', status: 'aborted' } );
	const _root = await _run;
	assert.ok( Date.now() - _started < 1500, `closed ${Date.now() - _started} ms after the abort` );
	assert.equal( _child.result.status, 'aborted' );
	assert.equal( _root.result.status, 'aborted' );
	const _after = _o.events( _child, 'state_changed' ).map( data => `${data.from}>${data.to}` );
	assert.ok( _after.includes( 'waiting>judging' ) && _after.at( -1 ) === 'closing>closed' );
} );
