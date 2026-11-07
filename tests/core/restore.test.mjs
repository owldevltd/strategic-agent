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
const quick = mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;

test( 'restart: a new core rebuilds the open goal from the log; the interrupted move counts as aborted and the goal still closes', async () => {
	// The first core stops while its child waits for the approval of the invitation.
	const _first = await office( { edit: quick, approve: approval => ( approval.summary.action === 'invite' ? null : true ) } );
	_first.run().catch( () => {} );
	const _pending = await until( () => _first.egress.pendingApprovals().find( item => item.summary.action === 'invite' ) );
	_first.crash();
	// The second core starts on the same log and the same gate.
	const _second = await office( { edit: quick, share: _first, resume: true } );
	const [ _root ] = await _second.resumed;
	assert.equal( _root.result.status, 'fulfilled', JSON.stringify( _root.result ) );
	const [ _child ] = _root.children;
	assert.equal( _child.walls[ 0 ].cause, 'interrupted' );
	assert.equal( _child.result.status, 'fulfilled' );
	assert.equal( _first.egress.store.delivery( _pending.delivery ).status, 'not_sent', 'what the dead core had pending was withdrawn (O9)' );
	const _kinds = _second.log.since( 0 ).map( event => event.kind );
	assert.ok( _kinds.includes( 'run_resumed' ) && _kinds.includes( 'resumed' ) );
	assert.deepEqual( _second.outbox.messages( 'hr' ).length, 1, 'exactly one report' );
} );

test( 'restart: an attempt the journal still has open while its node was judging is ended as interrupted, so the node can close', async () => {
	const _first = await office( { edit: quick, approve: approval => ( approval.summary.action === 'invite' ? null : true ) } );
	_first.run().catch( () => {} );
	const _pending = await until( () => _first.egress.pendingApprovals().find( item => item.summary.action === 'invite' ) );
	// The core stops just after the waiting child was woken for its judgment, with its attempt still open.
	const _waiting = await until( () => [ ..._first.runner.nodes.values() ].find( node => node.state === 'waiting' && node.parent ) );
	_waiting.move( 'judging', { event: 'test' } );
	_first.crash();
	const _second = await office( { edit: quick, share: _first, resume: true } );
	const [ _root ] = await _second.resumed;
	assert.equal( _root.result.status, 'fulfilled', JSON.stringify( _root.result ) );
	const _child = _root.children.find( node => node.id === _waiting.id );
	const _events = _second.log.forNode( _child.id );
	assert.ok( _events.some( event => event.kind === 'attempt_interrupted' ) );
	assert.deepEqual( _events.find( event => event.kind === 'node_closed' ).data.dimensions.commercial, [], 'every attempt ended and booked (G6)' );
	assert.equal( _first.egress.store.delivery( _pending.delivery ).status, 'not_sent', 'its unused token was revoked (A3)' );
	assert.equal( _child.result.status, 'fulfilled', JSON.stringify( _child.result ) );
} );
