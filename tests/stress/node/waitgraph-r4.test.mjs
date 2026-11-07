// core/loop/waitgraph.js in the running system (R4): the runner's wait graph while a child runs, G2 refusing plans that
// would close a cycle, and the executor's wait for another node, which must always take its edge back.
import assert from 'node:assert/strict';
import { attack, within } from '../hostile.mjs';
import { office } from '../../office.mjs';
import { app, registry, Contract, Node, WaitGraph, tick, until } from './kit.mjs';

const S = 'core/loop/waitgraph.js';
const [ Executor ] = await app.use( [ 'Core.Move.Executor' ] );
const quick = mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;

// One live run is watched by several tests: the edge of the parent to its running child, and its end.
const live = ( async () => {
	const _o = await office( { edit: quick } );
	const _seen = { during: null };
	const _run = _o.run();
	_seen.during = await until( () => {
		const _child = [ ..._o.runner.nodes.values() ].find( item => item.depth === 1 && item.state !== 'draft' );
		return _child && _o.runner.waits.edges.get( _child.parent.id )?.has( _child.id ) && {
			child: _child, closes: _o.runner.waits.wouldClose( _child.id, _child.parent.id ),
			refused: _o.runner.planCheck( _child, { steps: [ { move: 'followup.wait', params: { node: _child.parent.id } } ] }, 100 ),
		};
	}, 25000, 'a running child' );
	const _root = await _run;
	_o.stop();
	return { o: _o, root: _root, ..._seen };
} )();

const waitFor = ( graph, nodes, node, other, extra = {} ) => Executor.prototype._waitForNode.call( null,
	{ move: 'followup.wait', params: { node: other } }, { runner: { nodes, waits: graph, pollMs: 5 }, node, ...extra } );

attack( S, 'R4: while a child runs its parent waits for it in the graph, so the child may not wait for its parent', async () => {
	const { during } = await live;
	assert.equal( during.closes, true );
	assert.equal( during.refused.ok, false );
	assert.ok( during.refused.problems.some( text => /would close a cycle in the wait graph \(R4\)/.test( text ) ), during.refused.problems.join( '; ' ) );
}, { timeout: 40000 } );

attack( S, 'R4: when the child has ended, its edge is gone and the graph is empty again', async () => {
	const { o, root } = await live;
	assert.equal( root.result.status, 'fulfilled' );
	const _left = [ ...o.runner.waits.edges.values() ].reduce( ( sum, set ) => sum + set.size, 0 );
	assert.equal( _left, 0 );
	assert.equal( o.runner.waits.wouldClose( root.children[ 0 ].id, root.id ), false );
}, { timeout: 40000 } );

// G2 with the runner's own graph, on nodes made for the check.
const planned = async () => {
	const _o = await office( { edit: quick } );
	_o.stop();
	const _contract = new Contract( _o.mission.contractSpec(), registry );
	const _make = id => new Node( { contract: _contract, id } );
	const _check = ( item, other ) => _o.runner.planCheck( item, { steps: [ { move: 'followup.wait', params: { node: other } } ] }, 100 );
	const _r4 = result => result.problems.filter( text => /\(R4\)/.test( text ) );
	return { runner: _o.runner, make: _make, check: _check, r4: _r4 };
};

attack( S, 'G2 refuses a plan in which a node waits for itself', async () => {
	const { make, check, r4 } = await planned();
	const _node = make( 'n-self' );
	assert.equal( r4( check( _node, _node.id ) ).length, 1 );
} );

attack( S, 'G2 lets a node wait for a sibling nobody waits on, and refuses the sibling waiting back', async () => {
	const { runner, make, check, r4 } = await planned();
	const [ _a, _b ] = [ make( 'n-a' ), make( 'n-b' ) ];
	assert.deepEqual( r4( check( _a, _b.id ) ), [] );
	runner.waits.add( _a.id, _b.id );
	assert.equal( r4( check( _b, _a.id ) ).length, 1 );
	runner.waits.remove( _a.id, _b.id );
	assert.deepEqual( r4( check( _b, _a.id ) ), [], 'after the wait ended the way is free' );
} );

attack( S, 'G2 refuses a grandchild that waits for the root while root and child wait for their children', async () => {
	const { runner, make, check, r4 } = await planned();
	runner.waits.add( 'n-root', 'n-child' );
	runner.waits.add( 'n-child', 'n-grandchild' );
	assert.equal( r4( check( make( 'n-grandchild' ), 'n-root' ) ).length, 1 );
	assert.deepEqual( r4( check( make( 'n-grandchild' ), 'n-uncle' ) ), [] );
} );

attack( S, 'G2 refuses a ring of three siblings at its last link', async () => {
	const { runner, make, check, r4 } = await planned();
	runner.waits.add( 's1', 's2' );
	runner.waits.add( 's2', 's3' );
	assert.equal( r4( check( make( 's3' ), 's1' ) ).length, 1 );
} );

attack( S, 'the executor\'s wait for another node holds its edge while it waits and gives it back when the other closes', async () => {
	const _graph = new WaitGraph();
	const _other = { id: 'other', state: 'executing', result: null };
	const _me = { id: 'me', stopping: null };
	const _done = waitFor( _graph, new Map( [ [ 'other', _other ] ] ), _me, 'other' );
	await tick( 20 );
	assert.equal( _graph.wouldClose( 'other', 'me' ), true );
	Object.assign( _other, { state: 'closed', result: { status: 'fulfilled' } } );
	const _out = await within( _done, 1000 );
	assert.deepEqual( _out.value, { node: 'other', result: 'fulfilled' } );
	assert.equal( _graph.wouldClose( 'other', 'me' ), false );
} );

attack( S, 'an abort ends the executor\'s wait for another node and takes its edge back (16.5)', async () => {
	const _graph = new WaitGraph();
	const _me = { id: 'me', stopping: null };
	const _done = waitFor( _graph, new Map( [ [ 'other', { id: 'other', state: 'waiting' } ] ] ), _me, 'other' );
	await tick( 20 );
	_me.stopping = { reason: 'aborted' };
	await within( _done, 1000 );
	assert.equal( _graph.wouldClose( 'other', 'me' ), false );
} );

attack( S, 'a wait for a node nobody knows fails at once and leaves no edge', async () => {
	const _graph = new WaitGraph();
	await assert.rejects( waitFor( _graph, new Map(), { id: 'me' }, 'ghost' ), /no node ghost/ );
	assert.equal( _graph.edges.size, 0 );
} );

attack( S, 'a wait that would close a cycle is refused before it starts waiting, so a plan past G2 cannot deadlock', async () => {
	const _graph = new WaitGraph();
	_graph.add( 'other', 'me' );
	const _nodes = new Map( [ [ 'other', { id: 'other', state: 'waiting' } ] ] );
	await assert.rejects( within( waitFor( _graph, _nodes, { id: 'me', stopping: null }, 'other' ), 500 ), /R4/ );
	assert.equal( _graph.edges.get( 'me' )?.size || 0, 0 );
} );

attack( S, 'two nodes that wait for each other through the executor: the second wait is refused, the first ends normally', async () => {
	const _graph = new WaitGraph();
	const [ _a, _b ] = [ { id: 'a', state: 'executing', stopping: null }, { id: 'b', state: 'executing', stopping: null } ];
	const _nodes = new Map( [ [ 'a', _a ], [ 'b', _b ] ] );
	const _first = waitFor( _graph, _nodes, _a, 'b' );
	await tick( 10 );
	await assert.rejects( waitFor( _graph, _nodes, _b, 'a' ), /R4/ );
	_b.state = 'closed';
	await within( _first, 1000 );
	assert.equal( _graph.wouldClose( 'b', 'a' ), false );
} );
