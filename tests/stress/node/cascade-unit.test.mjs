// core/loop/cascade.js under attack with a runner of fakes (16.5): abort in every state, twice, of closed nodes, of deep
// and wide trees and of processes; withdrawal failures at the gate (O9); hand-over of unclear actions (O5); revoke (A3).
import assert from 'node:assert/strict';
import { attack, attacks, hostile, within } from '../hostile.mjs';
import { app, node, tree, bring, cascadeRunner, Cascade, STATES, tick } from './kit.mjs';

const S = 'core/loop/cascade.js';
const OPEN = STATES.filter( state => state !== 'closed' );

// Captures what app.fail would print while fn runs.
async function failures( fn ) {
	const _seen = [];
	const _fail = app.fail;
	app.fail = error => _seen.push( error );
	try {
		await fn();
		await tick( 5 );
	} finally {
		app.fail = _fail;
	}
	return _seen;
}

attack( S, '16.5: the abort marks the node with its own reason and everything below it as aborted from above', async () => {
	const { root, all } = tree( 2, 2 );
	const { cascade } = cascadeRunner();
	assert.equal( await cascade.abort( root, { reason: 'the client stopped', status: 'failed' } ), true );
	assert.deepEqual( [ root.stopping.reason, root.stopping.status ], [ 'the client stopped', 'failed' ] );
	for ( const item of all.slice( 1 ) ) {
		assert.deepEqual( [ item.stopping.reason, item.stopping.status ], [ 'aborted from above: the client stopped', 'aborted' ] );
		assert.ok( !Number.isNaN( Date.parse( item.stopping.at ) ) );
	}
} );

attack( S, 'Z6: the abort goes down the tree from the top, and each node hears it before anything else of the cascade', async () => {
	const { root, all, log } = tree( 3, 2 );
	const { cascade } = cascadeRunner();
	await cascade.abort( root, { reason: 'stop' } );
	const _received = log.events.filter( event => event.kind === 'abort_received' ).map( event => event.node );
	assert.equal( _received[ 0 ], root.id );
	assert.equal( _received.length, all.length );
	for ( const item of all.slice( 1 ) ) {
		assert.ok( _received.indexOf( item.parent.id ) < _received.indexOf( item.id ), 'a parent hears the abort before its child' );
	}
	for ( const item of all ) {
		const _own = log.events.filter( event => event.node === item.id ).map( event => event.kind );
		assert.deepEqual( _own, [ 'abort_received', 'outside_cleared' ] );
	}
} );

attack( S, 'Z6: a node that waits for its next event is woken by the abort at once, with priority', async () => {
	const { root, all } = tree( 1, 3 );
	const { cascade } = cascadeRunner();
	const _woken = all.map( item => item.nextEvent() );
	await cascade.abort( root, { reason: 'stop' } );
	const _events = await within( Promise.all( _woken ), 500 );
	assert.ok( _events.every( event => event.kind === 'abort_received' && event.priority === true ) );
} );

attack( S, '16.5: open tickets of the whole tree are withdrawn in one go and every sandbox is stopped', async () => {
	const { root, all } = tree( 2, 3 );
	const { cascade, calls } = cascadeRunner();
	await cascade.abort( root, { reason: 'stop' } );
	assert.deepEqual( calls.boardWithdrawn, [ all.map( item => item.id ) ] );
	assert.deepEqual( calls.stopped, all.map( item => item.id ) );
} );

attack( S, 'O9: every open outside action of every node is withdrawn at the gate, and the node records how each ended', async () => {
	const { root, all } = tree( 1, 2 );
	all.forEach( ( item, i ) => {
		item.deliveries = [ `dl-${i}-a`, `dl-${i}-b` ];
	} );
	const { cascade, calls } = cascadeRunner( { rows: { 'dl-0-a': 'not_sent', 'dl-1-b': 'executed', 'dl-2-a': 'unclear' } } );
	await cascade.abort( root, { reason: 'stop' } );
	assert.deepEqual( calls.withdrawn.sort(), all.flatMap( item => item.deliveries ).sort() );
	assert.deepEqual( all[ 2 ].unclear, [ 'dl-2-a' ] );
	assert.deepEqual( all[ 1 ].unclear, [] );
	const _cleared = all[ 1 ].log.events.find( event => event.kind === 'outside_cleared' && event.node === all[ 1 ].id ).data;
	assert.deepEqual( _cleared.deliveries, [ { delivery: 'dl-1-a', status: 'not_sent' }, { delivery: 'dl-1-b', status: 'executed' } ] );
} );

attack( S, 'Z5: the abort of a closed node does nothing and says so', async () => {
	const _node = bring( node(), 'closed' );
	_node.deliveries = [ 'dl-1' ];
	const { cascade, calls } = cascadeRunner();
	const _events = _node.log.events.length;
	assert.equal( await cascade.abort( _node, { reason: 'late' } ), false );
	assert.deepEqual( [ calls.withdrawn, calls.boardWithdrawn, calls.stopped ], [ [], [], [] ] );
	assert.equal( _node.log.events.length, _events );
	assert.equal( _node.stopping, undefined );
} );

attack( S, 'Z5: under an open node only the open part of the tree is aborted; closed children stay untouched', async () => {
	const { root, all } = tree( 1, 3 );
	bring( all[ 1 ], 'closed' );
	all[ 1 ].deliveries = [ 'dl-closed' ];
	const { cascade, calls } = cascadeRunner();
	await cascade.abort( root, { reason: 'stop' } );
	assert.equal( all[ 1 ].stopping, undefined );
	assert.ok( !calls.withdrawn.includes( 'dl-closed' ) );
	assert.deepEqual( calls.boardWithdrawn[ 0 ], [ root.id, all[ 2 ].id, all[ 3 ].id ] );
} );

attack( S, 'a twice-sent abort is done once: the second answers false and changes nothing', async () => {
	const { root, all } = tree( 1, 2 );
	all.forEach( ( item ) => {
		item.deliveries = [ `dl-${item.id}` ];
	} );
	const { cascade, calls } = cascadeRunner();
	await cascade.abort( root, { reason: 'first', status: 'failed' } );
	assert.equal( await cascade.abort( root, { reason: 'second', status: 'aborted' } ), false );
	assert.deepEqual( [ root.stopping.reason, root.stopping.status ], [ 'first', 'failed' ] );
	assert.equal( calls.withdrawn.length, 3 );
	assert.equal( root.log.events.filter( event => event.kind === 'abort_received' ).length, 3 );
} );

attack( S, 'two aborts at the same moment: exactly one does the work, every action is withdrawn once', async () => {
	const { root, all } = tree( 2, 2 );
	all.forEach( ( item ) => {
		item.deliveries = [ `dl-${item.id}` ];
	} );
	const { cascade, calls } = cascadeRunner();
	const _answers = await Promise.all( [ cascade.abort( root, { reason: 'deadline', status: 'failed' } ), cascade.abort( root, { reason: 'client' } ) ] );
	assert.deepEqual( _answers.sort(), [ false, true ] );
	assert.equal( calls.withdrawn.length, all.length );
	assert.equal( new Set( calls.withdrawn ).size, all.length );
} );

attack( S, 'a child aborted on its own keeps its reason when the root is aborted later; the rest is marked from above', async () => {
	const { root, all } = tree( 1, 2 );
	const { cascade } = cascadeRunner();
	await cascade.abort( all[ 1 ], { reason: 'its own deadline', status: 'failed' } );
	await cascade.abort( root, { reason: 'the client stopped' } );
	assert.deepEqual( [ all[ 1 ].stopping.reason, all[ 1 ].stopping.status ], [ 'its own deadline', 'failed' ] );
	assert.equal( all[ 2 ].stopping.reason, 'aborted from above: the client stopped' );
	assert.equal( root.stopping.reason, 'the client stopped' );
} );

attacks( S, OPEN.map( state => ( { name: `16.5: an abort reaches a node that is ${state}: it is marked and told, the loop then closes it`, state } ) ), async ( { state } ) => {
	const _node = bring( node(), state );
	const { cascade } = cascadeRunner();
	assert.equal( await cascade.abort( _node, { reason: `stop while ${state}` } ), true );
	assert.equal( _node.stopping.reason, `stop while ${state}` );
	assert.equal( _node.state, state, 'the cascade marks; the node closes itself along table 16.1' );
	assert.equal( _node.log.events.at( -2 ).kind, 'abort_received' );
} );

attack( S, '16.5: a tree five levels deep is aborted down to the last level, top to bottom', async () => {
	const { root, all, log } = tree( 5, 1 );
	const { cascade } = cascadeRunner();
	await cascade.abort( root, { reason: 'deep' } );
	assert.equal( all.length, 6 );
	assert.ok( all.every( item => item.stopping ) );
	assert.deepEqual( log.events.filter( event => event.kind === 'abort_received' ).map( event => all.find( item => item.id === event.node ).depth ), [ 0, 1, 2, 3, 4, 5 ] );
} );

attack( S, '16.5: a node with fifty children aborts them all, withdrawing every child\'s actions', async () => {
	const { root, all } = tree( 1, 50 );
	all.slice( 1 ).forEach( ( item, i ) => {
		item.deliveries = [ `dl-${i}` ];
	} );
	const { cascade, calls } = cascadeRunner();
	const _started = Date.now();
	await cascade.abort( root, { reason: 'wide' } );
	assert.ok( Date.now() - _started < 5000 );
	assert.equal( all.filter( item => item.stopping ).length, 51 );
	assert.equal( calls.withdrawn.length, 50 );
	assert.equal( calls.boardWithdrawn[ 0 ].length, 51 );
} );

attack( S, '16.5: processes a node owns are aborted with it, also those owned by its children, with what is below them', async () => {
	const { root, all, log } = tree( 1, 1 );
	const _case = node( { log } );
	const _proposal = node( { log } );
	const _below = node( { log, parent: _proposal } );
	root.processes.push( _case );
	all[ 1 ].processes.push( _proposal );
	const { cascade } = cascadeRunner();
	await cascade.abort( root, { reason: 'stop' } );
	assert.ok( [ _case, _proposal, _below ].every( item => item.stopping?.reason === 'aborted from above: stop' ) );
	assert.deepEqual( Cascade.tree( root ).map( item => item.id ), [ root.id, all[ 1 ].id, _proposal.id, _below.id, _case.id ] );
} );

attack( S, 'a node reachable both as a child and as a process of the same owner is aborted once', async () => {
	const { root, all, log } = tree( 1, 1 );
	root.processes.push( all[ 1 ] );
	all[ 1 ].deliveries = [ 'dl-1' ];
	const { cascade, calls } = cascadeRunner();
	await cascade.abort( root, { reason: 'stop' } );
	assert.equal( log.events.filter( event => event.kind === 'abort_received' && event.node === all[ 1 ].id ).length, 1 );
	assert.deepEqual( calls.withdrawn, [ 'dl-1' ] );
} );

attacks( S, [
	{ name: 'O9: a withdrawal that ends as not sent leaves nothing unclear', answer: { status: 'not_sent' }, unclear: [] },
	{ name: 'O9: a withdrawal that finds the action executed leaves nothing unclear', answer: { status: 'executed' }, unclear: [ ] },
	{ name: 'O9: a withdrawal that ends unclear lists the action for a person', answer: { status: 'unclear' }, unclear: [ 'dl-1' ] },
	{ name: 'O9: a gate that refuses the withdrawal makes the action unknown, which is unclear', answer: new Error( 'gate 500' ), unclear: [ 'dl-1' ] },
], async ( { answer, unclear } ) => {
	const _node = node();
	_node.deliveries = [ 'dl-1' ];
	const { cascade } = cascadeRunner( { withdraw: () => ( answer instanceof Error ? Promise.reject( answer ) : { delivery: 'dl-1', ...answer } ) } );
	await cascade.abort( _node, { reason: 'stop' } );
	assert.deepEqual( _node.unclear, unclear );
	const _status = _node.log.of( 'outside_cleared' )[ 0 ].deliveries[ 0 ].status;
	assert.equal( _status, answer instanceof Error ? 'unknown' : answer.status );
} );

attack( S, 'O9: a withdrawal that loses the race to an attempt in flight is followed until the action is executed or unclear', async () => {
	const _node = node();
	_node.deliveries = [ 'dl-1' ];
	const { cascade, calls } = cascadeRunner( { rows: { 'dl-1': 'open' } } );
	await cascade.abort( _node, { reason: 'stop' } );
	assert.deepEqual( calls.followed, [ 'dl-1' ], 'otherwise its end (executed, or unclear for a person) never reaches anyone' );
} );

attack( S, 'O9: a gate that answers a withdrawal with nothing does not break the cascade', async () => {
	const _node = node();
	_node.deliveries = [ 'dl-1' ];
	const { cascade } = cascadeRunner( { withdraw: () => null } );
	await assert.doesNotReject( cascade.abort( _node, { reason: 'stop' } ) );
	assert.deepEqual( _node.unclear, [ 'dl-1' ], 'an answer without a status is an unknown end' );
} );

attack( S, '16.5: a gate that never answers a withdrawal holds the cascade at most for Δ', async () => {
	const _node = node();
	_node.deliveries = [ 'dl-1' ];
	const { cascade, runner } = cascadeRunner( { withdraw: () => new Promise( () => {} ) } );
	runner.bufferMinutes = 0.002;
	await within( cascade.abort( _node, { reason: 'stop' } ), 1500, 'the abort' );
} );

attack( S, '16.5: a runtime that fails to stop a sandbox does not keep the outside actions from being withdrawn', async () => {
	const _node = node();
	_node.deliveries = [ 'dl-1' ];
	const { cascade, runner, calls } = cascadeRunner();
	runner.executor.runtime.stop = () => {
		throw new Error( 'docker: no such container' );
	};
	await cascade.abort( _node, { reason: 'stop' } ).catch( () => {} );
	assert.deepEqual( calls.withdrawn, [ 'dl-1' ] );
} );

attack( S, '16.5: a board that fails to withdraw tickets does not keep the outside actions from being withdrawn', async () => {
	const _node = node();
	_node.deliveries = [ 'dl-1' ];
	const { cascade, runner, calls } = cascadeRunner();
	runner.executor.board.withdraw = () => {
		throw new Error( 'board broken' );
	};
	await cascade.abort( _node, { reason: 'stop' } ).catch( () => {} );
	assert.deepEqual( calls.withdrawn, [ 'dl-1' ] );
} );

attack( S, 'a bare runner without board and runtime still aborts and withdraws', async () => {
	const _node = node();
	_node.deliveries = [ 'dl-1' ];
	const { cascade, calls } = cascadeRunner( { board: false, runtime: false } );
	assert.equal( await cascade.abort( _node, { reason: 'stop' } ), true );
	assert.deepEqual( calls.withdrawn, [ 'dl-1' ] );
} );

attack( S, 'the same delivery listed twice is withdrawn once, and unclear entries are never doubled', async () => {
	const _node = node();
	_node.deliveries = [ 'dl-1', 'dl-1', 'dl-2' ];
	_node.unclear = [ 'dl-2' ];
	const { cascade, calls } = cascadeRunner( { rows: { 'dl-1': 'unclear', 'dl-2': 'unclear' } } );
	await cascade.abort( _node, { reason: 'stop' } );
	assert.deepEqual( calls.withdrawn, [ 'dl-1', 'dl-2' ] );
	assert.deepEqual( _node.unclear.sort(), [ 'dl-1', 'dl-2' ] );
} );

attack( S, '16.3: an abort can only end as failed or aborted, never as fulfilled', async () => {
	const _node = node();
	const { cascade } = cascadeRunner();
	await cascade.abort( _node, { reason: 'stop', status: 'fulfilled' } );
	assert.ok( [ 'failed', 'aborted' ].includes( _node.stopping.status ), `status ${_node.stopping.status}` );
} );

attacks( S, hostile( 'strings' ).filter( item => typeof item.value === 'string' ).slice( 20, 30 ).map( item => ( {
	...item, name: `the abort reason ${item.label} is kept verbatim and passed down with its prefix`,
} ) ), async ( { value } ) => {
	const { root, all } = tree( 1, 1 );
	const { cascade } = cascadeRunner();
	await cascade.abort( root, { reason: value } );
	assert.equal( root.stopping.reason, value );
	assert.equal( all[ 1 ].stopping.reason, `aborted from above: ${value}` );
} );

attack( S, 'O5: unclear actions go to a person as one check ticket of their own; the closed node stays closed', async () => {
	const _node = bring( node(), 'closed' );
	_node.unclear = [ 'dl-1', 'dl-2' ];
	const { cascade, calls } = cascadeRunner();
	cascade.handOver( _node );
	assert.equal( calls.asked.length, 1 );
	const [ _ticket ] = calls.asked;
	assert.deepEqual( [ _ticket.kind, _ticket.options, _ticket.recommendation, _ticket.reason ], [ 'check', [ 'checked' ], 'checked', 'unclear outside actions (O5)' ] );
	assert.match( _ticket.question, /dl-1, dl-2/ );
	assert.match( _ticket.question, /new action with a new approval/ );
	assert.deepEqual( [ _node.state, _node.handedOver ], [ 'closed', [ 'dl-1', 'dl-2' ] ] );
} );

attack( S, 'O5: the same unclear action is handed over once; a new one gets its own ticket', async () => {
	const _node = node();
	_node.unclear = [ 'dl-1' ];
	const { cascade, calls } = cascadeRunner();
	cascade.handOver( _node );
	cascade.handOver( _node );
	_node.unclear.push( 'dl-2' );
	cascade.handOver( _node );
	assert.equal( calls.asked.length, 2 );
	assert.doesNotMatch( calls.asked[ 1 ].question, /dl-1/ );
	assert.match( calls.asked[ 1 ].question, /dl-2/ );
} );

attack( S, 'O5: without a board nothing is marked as handed over, so a later board still gets the ticket', async () => {
	const _node = node();
	_node.unclear = [ 'dl-1' ];
	const _bare = cascadeRunner( { board: false } );
	_bare.cascade.handOver( _node );
	assert.equal( _node.handedOver, undefined );
	const { cascade, calls } = cascadeRunner();
	cascade.handOver( _node );
	assert.equal( calls.asked.length, 1 );
} );

attack( S, 'O5: nothing unclear, no ticket; a board that fails to ask does not throw into the cascade', async () => {
	const _node = node();
	const { cascade, runner, calls } = cascadeRunner();
	cascade.handOver( _node );
	assert.equal( calls.asked.length, 0 );
	_node.unclear = [ 'dl-9' ];
	runner.executor.board.ask = async () => {
		throw new Error( 'board down' );
	};
	const _seen = await failures( () => cascade.handOver( _node ) );
	assert.equal( _seen.length, 1 );
	assert.match( _seen[ 0 ].message, /board down/ );
} );

attacks( S, [
	{ status: 'awaiting_approval', withdrawn: true, followed: false },
	{ status: 'approved', withdrawn: true, followed: false },
	{ status: 'open', withdrawn: false, followed: true },
	{ status: 'executed', withdrawn: false, followed: false },
	{ status: 'not_sent', withdrawn: false, followed: false },
	{ status: 'unclear', withdrawn: false, followed: false },
	{ status: 'refused', withdrawn: false, followed: false },
].map( item => ( { ...item, name: `A3: when a lease runs out, an action that is ${item.status} is ${item.withdrawn ? 'revoked' : item.followed ? 'followed' : 'left alone'}` } ) ), async ( { status, withdrawn, followed } ) => {
	const { cascade, calls } = cascadeRunner( { rows: { 'dl-1': status } } );
	await cascade.revoke( { deliveries: [ 'dl-1' ] } );
	assert.deepEqual( [ calls.withdrawn.length > 0, calls.followed.length > 0 ], [ withdrawn, followed ] );
} );

attack( S, 'A3: revoke asks the gate once per action and survives a gate that fails to answer or to withdraw', async () => {
	const { cascade, runner, calls } = cascadeRunner( { rows: { 'dl-1': 'approved' } } );
	runner.gate.delivery = async ( id ) => {
		if ( id === 'dl-2' ) { throw new Error( 'gate down' ); }
		return { id, status: 'approved' };
	};
	runner.gate.withdraw = async ( id ) => {
		calls.withdrawn.push( id );
		throw new Error( 'withdraw failed' );
	};
	const _seen = await failures( () => cascade.revoke( { deliveries: [ 'dl-1', 'dl-1', 'dl-2' ] } ) );
	assert.deepEqual( calls.withdrawn, [ 'dl-1' ] );
	assert.equal( _seen.length, 1 );
} );

attack( S, 'Cascade.tree of a lone node is the node; it never lists a node of another tree', () => {
	const _lone = node();
	assert.deepEqual( Cascade.tree( _lone ), [ _lone ] );
	const { root } = tree( 2, 2 );
	const _other = tree( 1, 1 );
	assert.ok( !Cascade.tree( root ).some( item => Cascade.tree( _other.root ).includes( item ) ) );
	assert.equal( Cascade.tree( { children: [], processes: undefined } ).length, 1 );
} );
