// Stress tests of closing (2.3, 4.4, 16.1, 16.3, G6, A5): what the goal no longer needs is cancelled, G6 checks six
// dimensions, a goal judged done that fails G6 goes back to judging, and all of it is bounded by the buffer Δ.
// Attacks: moves and outside actions that never end, a gate that is gone or hangs, children still running, an
// aborted node, a contract that changed under the node.
import assert from 'node:assert/strict';
import { attack, within } from '../hostile.mjs';
import { rig, placed, attempt, kinds, never, RECEIPT } from './kit.mjs';

const CLOSE = 'core/loop/closing.js';
const DELTA = ms => ms / 60000;

async function closer( { place = {}, ...options } = {} ) {
	const _rig = rig( options );
	const _node = await placed( _rig, 'closing', place );
	return { ..._rig, node: _node, closing: _rig.runner.closing };
}

const proven = ( node ) => {
	node.addFact( RECEIPT );
	return node;
};

attack( CLOSE, 'a proven goal closes fulfilled; G6 finds nothing in any of its six dimensions (2.3)', async () => {
	const { closing, node, log } = await closer();
	await closing.close( proven( node ) );
	assert.equal( node.state, 'closed' );
	assert.deepEqual( node.result, { status: 'fulfilled' } );
	const [ _closed ] = kinds( log, node, 'node_closed' );
	assert.ok( Object.values( _closed.dimensions ).every( list => !list.length ) );
} );

attack( CLOSE, 'a goal judged done that G6 finds unmet goes back to its judgment while Δ is left (16.1)', async () => {
	const { closing, node } = await closer();
	node.lessonWritten = true;
	await closing.close( node );
	assert.equal( node.state, 'judging' );
	assert.equal( node.lessonWritten, false, 'the lesson is written again on the next close' );
	assert.equal( node.result, null );
} );

attack( CLOSE, 'with Δ used up, an unmet predicate closes the goal as failed and is named in its result', async () => {
	const { closing, node } = await closer( { bufferMinutes: 0 } );
	await closing.close( node );
	assert.equal( node.state, 'closed' );
	assert.equal( node.result.status, 'failed' );
	assert.match( node.result.problems.join(), /k1 \(report_delivered\) not met/ );
} );

attack( CLOSE, 'an aborted node never goes back to judging: G6 checks the clean-up, not the predicates (16.3)', async () => {
	const { closing, node } = await closer();
	node.stopping = { reason: 'by the client', status: 'aborted' };
	await closing.close( node );
	assert.equal( node.state, 'closed' );
	assert.deepEqual( [ node.result.status, node.result.reason, node.result.problems ], [ 'aborted', 'by the client', undefined ] );
} );

attack( CLOSE, 'a node that failed on its way (no tokens, escalation) closes with that result, even if G6 would pass', async () => {
	const { closing, node } = await closer();
	proven( node );
	node.result = { status: 'failed', reason: 'no start tokens left (R1)' };
	await closing.close( node );
	assert.deepEqual( node.result, { status: 'failed', reason: 'no start tokens left (R1)' } );
} );

attack( CLOSE, 'an attempt still open on a proven goal takes back its reversible move, with the proving facts as evidence (E6)', async () => {
	let _withdrawn = null;
	const _board = { withdraw: ( ids ) => {
		_withdrawn = ids;
		return [ { id: 'tk-1' } ];
	}, list: () => [] };
	const _rig = await closer( { board: _board } );
	attempt( _rig, _rig.node, [ { move: 'stress.human' } ] );
	_rig.node.plan.pending = { index: 0, began: Date.now(), promise: Promise.resolve( {} ) };
	const _receipt = proven( _rig.node ).facts[ 0 ];
	await _rig.closing.close( _rig.node );
	const _cancelled = _rig.node.facts.find( fact => fact.kind === 'cancelled' );
	assert.deepEqual( _cancelled.data.evidence, [ _receipt.id ] );
	assert.deepEqual( _withdrawn, [ _rig.node.id ] );
	assert.equal( _rig.journal.get( _rig.node.plan.attempt ).outcome, 'done' );
	assert.equal( _rig.node.result.status, 'fulfilled' );
} );

attack( CLOSE, 'an attempt still open on an aborted node ends as a wall "aborted"', async () => {
	const _rig = await closer();
	attempt( _rig, _rig.node, [ { move: 'stress.code' } ] );
	_rig.node.stopping = { reason: 'abort', status: 'aborted' };
	await _rig.closing.close( _rig.node );
	assert.deepEqual( [ _rig.journal.get( _rig.node.plan.attempt ).outcome, _rig.journal.get( _rig.node.plan.attempt ).cause ], [ 'wall', 'aborted' ] );
} );

attack( CLOSE, 'Δ: a move that cannot be taken back and never ends holds closing no longer than the buffer', async () => {
	const _rig = await closer( { bufferMinutes: DELTA( 60 ) } );
	attempt( _rig, _rig.node, [ { move: 'stress.code' } ] );
	_rig.node.plan.pending = { index: 0, began: Date.now(), promise: never() };
	proven( _rig.node );
	const _started = Date.now();
	await within( _rig.closing.close( _rig.node ), 2000 );
	assert.ok( Date.now() - _started < 600, `${Date.now() - _started} ms` );
	assert.equal( _rig.node.state, 'closed' );
	assert.equal( kinds( _rig.log, _rig.node, 'move_outlasts_close' ).length, 1 );
} );

attack( CLOSE, 'Δ: an outside action still open at the gate is checked again until Δ, then named; the goal is not "really done"', async () => {
	const _rig = await closer( { bufferMinutes: DELTA( 60 ) } );
	_rig.gate.deliveries[ 'dl-1' ] = { id: 'dl-1', status: 'open' };
	proven( _rig.node ).deliveries = [ 'dl-1' ];
	await within( _rig.closing.close( _rig.node ), 2000 );
	assert.equal( _rig.node.result.status, 'failed' );
	assert.deepEqual( _rig.node.result.problems, [ 'outside action dl-1 not in an end state' ] );
} );

attack( CLOSE, 'an outside action that becomes final within Δ lets the goal close fulfilled', async () => {
	const _rig = await closer( { bufferMinutes: DELTA( 500 ) } );
	_rig.gate.deliveries[ 'dl-1' ] = { id: 'dl-1', status: 'open' };
	proven( _rig.node ).deliveries = [ 'dl-1' ];
	setTimeout( () => {
		_rig.gate.deliveries[ 'dl-1' ].status = 'executed';
	}, 30 );
	await within( _rig.closing.close( _rig.node ), 2000 );
	assert.equal( _rig.node.result.status, 'fulfilled' );
} );

attack( CLOSE, 'an unclear outside action is listed for a person, it does not hold the goal open (O5)', async () => {
	const _rig = await closer( { bufferMinutes: DELTA( 60 ) } );
	_rig.gate.deliveries[ 'dl-1' ] = { id: 'dl-1', status: 'open' };
	proven( _rig.node ).deliveries = [ 'dl-1' ];
	_rig.node.unclear = [ 'dl-1' ];
	await _rig.closing.close( _rig.node );
	assert.equal( _rig.node.result.status, 'fulfilled' );
} );

attack( CLOSE, 'in doubt the action is open: a gate that cannot be asked never lets an outside action count as finished (A8)', async () => {
	const _rig = await closer( { bufferMinutes: DELTA( 60 ) } );
	_rig.gate.delivery = async () => {
		throw new Error( 'ECONNREFUSED' );
	};
	proven( _rig.node ).deliveries = [ 'dl-1' ];
	await within( _rig.closing.close( _rig.node ), 2000 );
	assert.notEqual( _rig.node.result.status, 'fulfilled', 'nobody knows whether dl-1 is still being delivered' );
} );

attack( CLOSE, 'Δ: a gate that never answers holds closing no longer than the buffer (16.3, G-1c)', async () => {
	const _rig = await closer( { bufferMinutes: DELTA( 60 ) } );
	_rig.gate.delivery = never;
	proven( _rig.node ).deliveries = [ 'dl-1' ];
	await within( _rig.closing.close( _rig.node ), 1500, 'closing' );
	assert.equal( _rig.node.state, 'closed' );
} );

attack( CLOSE, 'A5: open tickets of the node are withdrawn at closing; they never hold it beyond Δ', async () => {
	const _calls = [];
	const _board = { withdraw: ( ids, options ) => {
		_calls.push( [ ids, options ] );
		return [];
	}, list: () => [] };
	const { closing, node } = await closer( { board: _board } );
	await closing.close( proven( node ) );
	assert.deepEqual( _calls, [ [ [ node.id ], { reason: 'cancelled' } ] ] );
} );

attack( CLOSE, 'a ticket that is still listed at Δ is named as open organisation, and the goal is not fulfilled', async () => {
	const _board = { withdraw: () => [], list: () => [ { node: 'other' }, { node: null } ] };
	const _rig = await closer( { board: _board, bufferMinutes: DELTA( 40 ) } );
	_board.list = () => [ { node: _rig.node.id } ];
	await within( _rig.closing.close( proven( _rig.node ) ), 2000 );
	assert.deepEqual( _rig.node.result.problems, [ '1 ticket(s) still open' ] );
} );

attack( CLOSE, 'expectations of the node are closed when it closes', async () => {
	const _closed = [];
	const { closing, node } = await closer( { expectations: { closeFor: id => _closed.push( id ) } } );
	await closing.close( proven( node ) );
	assert.deepEqual( _closed, [ node.id ] );
} );

attack( CLOSE, 'a child still running at Δ is named; the parent does not close as fulfilled over it (4.4)', async () => {
	const _rig = await closer( { bufferMinutes: DELTA( 40 ) } );
	_rig.node.children.push( { id: 'node-c1', state: 'waiting' } );
	await within( _rig.closing.close( proven( _rig.node ) ), 2000 );
	assert.equal( _rig.node.result.status, 'failed' );
	assert.deepEqual( _rig.node.result.problems, [ 'child node-c1 still waiting' ] );
} );

attack( CLOSE, 'a child that closes within Δ lets its parent close fulfilled (bottom-up, 4.4)', async () => {
	const _rig = await closer( { bufferMinutes: DELTA( 500 ) } );
	const _child = { id: 'node-c1', state: 'closing' };
	_rig.node.children.push( _child );
	setTimeout( () => {
		_child.state = 'closed';
	}, 30 );
	await within( _rig.closing.close( proven( _rig.node ) ), 2000 );
	assert.equal( _rig.node.result.status, 'fulfilled' );
} );

attack( CLOSE, 'a contract that is not the one the person confirmed never closes fulfilled, and is not waited for', async () => {
	const _rig = await closer( { bufferMinutes: 5 } );
	_rig.node.confirmed = 'some-other-hash';
	const _started = Date.now();
	await within( _rig.closing.close( proven( _rig.node ) ), 2000 );
	assert.ok( Date.now() - _started < 500, 'a formal problem is not something time clears' );
	assert.deepEqual( _rig.node.result.problems, [ 'the contract is not the one the person confirmed' ] );
} );

attack( CLOSE, 'G-10: an immutable criterion that changed since the first confirmation fails G6', async () => {
	const { closing, node } = await closer();
	node.immutables = [ JSON.stringify( [ 'k2', 'min_group', { k: 5 } ] ) ];
	node.contract.criteria.find( item => item.id === 'k2' ).values = { k: 1 };
	await closing.close( proven( node ) );
	assert.equal( node.result.status, 'failed' );
	assert.match( node.result.problems.join(), /immutable criterion changed/ );
} );

attack( CLOSE, 'an attempt of the node still open in the journal is waited for until Δ, then named (commercial)', async () => {
	const _rig = await closer( { bufferMinutes: DELTA( 40 ) } );
	_rig.journal.start( _rig.node, { id: 'forgotten' } );
	await within( _rig.closing.close( proven( _rig.node ) ), 2000 );
	assert.deepEqual( _rig.node.result.problems, [ '1 attempt(s) not ended and booked' ] );
} );

attack( CLOSE, 'the closed node reports to its parent, with the precondition it served (2.3)', async () => {
	const _rig = rig();
	const _parent = await placed( _rig, 'waiting' );
	const _child = await placed( _rig, 'closing', { parent: _parent, over: { serves: { criterion: 'k1', precondition: 'roster' } } } );
	await _rig.runner.closing.close( proven( _child ) );
	assert.deepEqual( kinds( _rig.log, _parent, 'child_ended' ), [ { child: _child.id, result: 'fulfilled', precondition: 'roster' } ] );
} );

attack( CLOSE, 'an aborted node hands its unclear outside actions to a person after it closed (16.5, O5)', async () => {
	const _asked = [];
	const _board = { withdraw: () => [], list: () => [], ask: async ( of, spec ) => _asked.push( spec ) };
	const { closing, node } = await closer( { board: _board } );
	node.stopping = { reason: 'abort', status: 'aborted' };
	node.unclear = [ 'dl-3' ];
	await closing.close( node );
	assert.equal( node.state, 'closed' );
	assert.deepEqual( node.result.unclear, [ 'dl-3' ] );
	assert.equal( _asked.filter( spec => spec.kind === 'check' ).length, 1 );
} );

attack( CLOSE, 'a fact that came in just before closing is taken over first and can still prove the goal', async () => {
	const { closing, node } = await closer();
	node.inbox = [ { ...RECEIPT } ];
	await closing.close( node );
	assert.equal( node.result.status, 'fulfilled' );
} );

attack( CLOSE, 'what the node spent is part of the transition to closed (P5)', async () => {
	const { closing, node, log } = await closer();
	node.spent = 3.25;
	await closing.close( proven( node ) );
	const _closed = kinds( log, node, 'state_changed' ).at( -1 );
	assert.deepEqual( [ _closed.to, _closed.spent ], [ 'closed', 3.25 ] );
} );

attack( CLOSE, 'G6 back to judging is the only way back: a second close after a new proof closes fulfilled', async () => {
	const { closing, node } = await closer();
	await closing.close( node );
	assert.equal( node.state, 'judging' );
	node.move( 'closing' );
	await closing.close( proven( node ) );
	assert.deepEqual( [ node.state, node.result.status ], [ 'closed', 'fulfilled' ] );
} );

attack( CLOSE, 'Δ is measured from the start of closing: a slow clean-up still ends at the buffer, not after it', async () => {
	const _rig = await closer( { bufferMinutes: DELTA( 80 ) } );
	_rig.gate.deliveries[ 'dl-1' ] = { id: 'dl-1', status: 'open' };
	attempt( _rig, _rig.node, [ { move: 'stress.code' } ] );
	_rig.node.plan.pending = { index: 0, began: Date.now(), promise: never() };
	proven( _rig.node ).deliveries = [ 'dl-1' ];
	const _started = Date.now();
	await within( _rig.closing.close( _rig.node ), 2000 );
	assert.ok( Date.now() - _started < 400, `move and delivery together took ${Date.now() - _started} ms of a Δ of 80 ms` );
} );

attack( CLOSE, 'E5: a contradiction that arrives at closing sends a goal judged done back to its judgment', async () => {
	const { closing, node } = await closer();
	proven( node );
	node.inbox = [
		{ kind: 'count', evidenceClass: 'observation', source: 'a', origin: 'gate', data: { about: 'R-1', value: 1 } },
		{ kind: 'count', evidenceClass: 'observation', source: 'b', origin: 'person', data: { about: 'R-1', value: 2 } },
	];
	await closing.close( node );
	assert.equal( node.state, 'judging' );
} );

attack( CLOSE, 'an aborted node still takes back its reversible question, naming the abort as the reason (E6, 16.5)', async () => {
	const _rig = await closer( { board: { withdraw: () => [ { id: 'tk-2' } ], list: () => [] } } );
	attempt( _rig, _rig.node, [ { move: 'stress.human' } ] );
	_rig.node.plan.pending = { index: 0, began: Date.now(), promise: Promise.resolve( {} ) };
	_rig.node.stopping = { reason: 'by the client', status: 'aborted' };
	await _rig.closing.close( _rig.node );
	assert.equal( _rig.node.facts.find( fact => fact.kind === 'cancelled' ).data.because, 'the goal is aborted' );
	assert.equal( _rig.node.result.status, 'aborted' );
} );

attack( CLOSE, 'a move left running without its attempt is named at Δ as organisation still open', async () => {
	const _rig = await closer( { bufferMinutes: DELTA( 40 ) } );
	_rig.node.plan = { open: false, pending: { index: 0, promise: never() }, steps: [] };
	await within( _rig.closing.close( proven( _rig.node ) ), 2000 );
	assert.deepEqual( _rig.node.result.problems, [ 'a move is still running' ] );
} );

attack( CLOSE, 'with a buffer of zero nothing is waited for: an open outside action is named at once', async () => {
	const _rig = await closer( { bufferMinutes: 0 } );
	_rig.gate.deliveries[ 'dl-1' ] = { id: 'dl-1', status: 'awaiting_approval' };
	proven( _rig.node ).deliveries = [ 'dl-1' ];
	const _started = Date.now();
	await _rig.closing.close( _rig.node );
	assert.ok( Date.now() - _started < 200 );
	assert.deepEqual( _rig.node.result.problems, [ 'outside action dl-1 not in an end state' ] );
} );
