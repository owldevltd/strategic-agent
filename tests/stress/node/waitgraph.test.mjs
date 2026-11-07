// core/loop/waitgraph.js under attack (R4): self-waits, cycles of every length, hostile ids, removal races, very wide
// and very deep graphs, and random graphs checked against an independent cycle search.
import assert from 'node:assert/strict';
import { attack, attacks, hostile, random } from '../hostile.mjs';
import { WaitGraph } from './kit.mjs';

const S = 'core/loop/waitgraph.js';

// Independent check: does the graph contain a cycle? (three-colour depth-first search, iterative)
function cyclic( graph ) {
	const _colour = new Map();
	for ( const start of graph.edges.keys() ) {
		if ( _colour.get( start ) ) { continue; }
		const _stack = [ [ start, [ ...( graph.edges.get( start ) || [] ) ] ] ];
		_colour.set( start, 1 );
		while ( _stack.length ) {
			const [ at, next ] = _stack.at( -1 );
			if ( !next.length ) {
				_colour.set( at, 2 );
				_stack.pop();
				continue;
			}
			const _to = next.pop();
			if ( _colour.get( _to ) === 1 ) { return true; }
			if ( !_colour.get( _to ) ) {
				_colour.set( _to, 1 );
				_stack.push( [ _to, [ ...( graph.edges.get( _to ) || [] ) ] ] );
			}
		}
	}
	return false;
}

// Independent check: is there a path from → to?
function path( graph, from, to ) {
	const _seen = new Set( [ from ] );
	const _queue = [ from ];
	while ( _queue.length ) {
		const _at = _queue.shift();
		if ( _at === to ) { return true; }
		for ( const next of graph.edges.get( _at ) || [] ) {
			if ( !_seen.has( next ) ) {
				_seen.add( next );
				_queue.push( next );
			}
		}
	}
	return false;
}

const edges = graph => [ ...graph.edges ].flatMap( ( [ from, set ] ) => [ ...set ].map( to => [ from, to ] ) );

attacks( S, hostile( 'keys' ).map( item => ( { ...item, name: `R4: the node ${item.label} cannot wait for itself` } ) ), ( { value } ) => {
	const _graph = new WaitGraph();
	assert.throws( () => _graph.add( value, value ), /cycle \(R4\)/ );
	assert.equal( _graph.wouldClose( value, value ), true );
	assert.deepEqual( edges( _graph ), [] );
} );

attacks( S, [ 0, -1, null, undefined, false, { id: 'n' }, [ 'n' ], 10n ].map( value => ( {
	name: `R4: an id of type ${typeof value} (${String( value )}) cannot wait for itself either`, value,
} ) ), ( { value } ) => {
	const _graph = new WaitGraph();
	assert.throws( () => _graph.add( value, value ), /R4/ );
	assert.deepEqual( edges( _graph ), [] );
} );

attack( S, 'R4: NaN as an id cannot wait for itself', () => {
	const _graph = new WaitGraph();
	assert.throws( () => _graph.add( NaN, NaN ), /R4/ );
} );

attack( S, 'R4: a cycle back to a NaN id is found', () => {
	const _graph = new WaitGraph();
	_graph.add( 'x', NaN );
	assert.throws( () => _graph.add( NaN, 'x' ), /R4/ );
	assert.equal( cyclic( _graph ), false );
} );

attacks( S, [ 2, 3, 4, 5, 6, 7, 8, 16, 64, 256, 1024, 10000 ].map( length => ( {
	name: `R4: a cycle of length ${length} is refused at its last edge, every shorter wait is accepted`, length,
} ) ), ( { length } ) => {
	const _graph = new WaitGraph();
	for ( let i = 0; i < length - 1; i++ ) { _graph.add( `n${i}`, `n${i + 1}` ); }
	assert.equal( _graph.wouldClose( `n${length - 1}`, 'n0' ), true );
	assert.throws( () => _graph.add( `n${length - 1}`, 'n0' ), new RegExp( `n${length - 1} waiting for n0 would close a cycle \\(R4\\)` ) );
	assert.equal( _graph.wouldClose( `n${length - 1}`, 'elsewhere' ), false );
	_graph.add( 'n0', 'side' );
	assert.equal( cyclic( _graph ), false );
	assert.equal( edges( _graph ).length, length );
} );

attack( S, 'R4: in a diamond the way back is refused through either side, a way out is not', () => {
	const _graph = new WaitGraph();
	[ [ 'a', 'b' ], [ 'a', 'c' ], [ 'b', 'd' ], [ 'c', 'd' ] ].forEach( ( [ from, to ] ) => _graph.add( from, to ) );
	assert.throws( () => _graph.add( 'd', 'a' ), /R4/ );
	assert.throws( () => _graph.add( 'd', 'b' ), /R4/ );
	assert.throws( () => _graph.add( 'c', 'a' ), /R4/ );
	_graph.add( 'd', 'e' );
	_graph.add( 'b', 'c' );
	assert.equal( cyclic( _graph ), false );
} );

attack( S, 'R4: two siblings may not wait for each other, nor three in a ring (between siblings too)', () => {
	const _graph = new WaitGraph();
	[ 'a', 'b', 'c' ].forEach( child => _graph.add( 'parent', child ) );
	_graph.add( 'a', 'b' );
	assert.throws( () => _graph.add( 'b', 'a' ), /R4/ );
	_graph.add( 'b', 'c' );
	assert.throws( () => _graph.add( 'c', 'a' ), /R4/ );
	assert.throws( () => _graph.add( 'c', 'parent' ), /R4/, 'a child waiting for its waiting parent' );
} );

attack( S, 'R4: a wait for a node that waits for others is fine as long as it does not lead back', () => {
	const _graph = new WaitGraph();
	_graph.add( 'b', 'c' );
	_graph.add( 'c', 'd' );
	_graph.add( 'a', 'b' );
	_graph.add( 'x', 'b' );
	_graph.add( 'x', 'a' );
	assert.equal( cyclic( _graph ), false );
	assert.equal( edges( _graph ).length, 5 );
} );

attack( S, 'a refused wait leaves the graph exactly as it was', () => {
	const _graph = new WaitGraph();
	_graph.add( 'a', 'b' );
	_graph.add( 'b', 'c' );
	const _before = JSON.stringify( edges( _graph ) );
	assert.throws( () => _graph.add( 'c', 'a' ) );
	assert.equal( JSON.stringify( edges( _graph ) ), _before );
	assert.equal( _graph.edges.has( 'c' ), false, 'no empty entry for the refused node' );
} );

attack( S, 'wouldClose only reads: a thousand questions change nothing', () => {
	const _graph = new WaitGraph();
	_graph.add( 'a', 'b' );
	const _rand = random( 3 );
	for ( let i = 0; i < 1000; i++ ) { _graph.wouldClose( _rand.pick( [ 'a', 'b', 'c' ] ), _rand.pick( [ 'a', 'b', 'c' ] ) ); }
	assert.deepEqual( edges( _graph ), [ [ 'a', 'b' ] ] );
} );

attack( S, 'nodes nobody knows close no cycle', () => {
	const _graph = new WaitGraph();
	assert.equal( _graph.wouldClose( 'x', 'y' ), false );
	_graph.add( 'x', 'y' );
	assert.equal( _graph.wouldClose( 'y', 'z' ), false );
	assert.equal( _graph.wouldClose( 'z', 'x' ), false );
} );

attack( S, 'adding the same wait twice keeps one edge, and the removal of the second wait clears it', () => {
	const _graph = new WaitGraph();
	_graph.add( 'a', 'b' );
	_graph.add( 'a', 'b' );
	assert.deepEqual( edges( _graph ), [ [ 'a', 'b' ] ] );
	_graph.remove( 'a', 'b' );
	assert.deepEqual( edges( _graph ), [ [ 'a', 'b' ] ], 'the second wait still runs' );
	_graph.remove( 'a', 'b' );
	assert.deepEqual( edges( _graph ), [] );
	assert.doesNotThrow( () => _graph.add( 'b', 'a' ) );
} );

attack( S, 'removal race: while one of two waits of a on b still runs, b may not wait for a', () => {
	const _graph = new WaitGraph();
	_graph.add( 'a', 'b' );
	_graph.add( 'a', 'b' );
	_graph.remove( 'a', 'b' );
	assert.throws( () => _graph.add( 'b', 'a' ), /R4/, 'a still waits for b through its second wait' );
} );

attack( S, 'removing what is not there is quiet', () => {
	const _graph = new WaitGraph();
	assert.doesNotThrow( () => _graph.remove( 'nobody', 'nothing' ) );
	_graph.add( 'a', 'b' );
	assert.doesNotThrow( () => _graph.remove( 'a', 'c' ) );
	assert.doesNotThrow( () => _graph.remove( 'b', 'a' ) );
	assert.deepEqual( edges( _graph ), [ [ 'a', 'b' ] ] );
} );

attack( S, 'once a wait ends the reverse wait is allowed', () => {
	const _graph = new WaitGraph();
	_graph.add( 'parent', 'child' );
	assert.throws( () => _graph.add( 'child', 'parent' ) );
	_graph.remove( 'parent', 'child' );
	_graph.add( 'child', 'parent' );
	assert.deepEqual( edges( _graph ), [ [ 'child', 'parent' ] ] );
} );

attack( S, 'after every wait of a large graph ended, no wait closes a cycle any more', () => {
	const _graph = new WaitGraph();
	const _pairs = [];
	for ( let i = 0; i < 2000; i++ ) {
		_graph.add( `n${i}`, `n${i + 1}` );
		_pairs.push( [ `n${i}`, `n${i + 1}` ] );
	}
	_pairs.forEach( ( [ from, to ] ) => _graph.remove( from, to ) );
	assert.equal( _graph.wouldClose( 'n2000', 'n0' ), false );
	assert.deepEqual( edges( _graph ), [] );
} );

attack( S, 'a node that waits for ten thousand others is checked quickly', () => {
	const _graph = new WaitGraph();
	for ( let i = 0; i < 10000; i++ ) { _graph.add( 'hub', `leaf${i}` ); }
	const _started = Date.now();
	assert.equal( _graph.wouldClose( 'leaf9999', 'hub' ), true );
	assert.equal( _graph.wouldClose( 'other', 'hub' ), false );
	assert.ok( Date.now() - _started < 5000 );
} );

attack( S, 'a node that waits for three hundred thousand others can still be asked about', () => {
	const _graph = new WaitGraph();
	for ( let i = 0; i < 300000; i++ ) { _graph.add( 'hub', i ); }
	assert.doesNotThrow( () => _graph.wouldClose( 'other', 'hub' ) );
} );

attack( S, 'ten thousand nodes waiting for one node is fan-in, not a cycle', () => {
	const _graph = new WaitGraph();
	for ( let i = 0; i < 10000; i++ ) { _graph.add( `w${i}`, 'shared' ); }
	assert.equal( _graph.wouldClose( 'shared', 'w5' ), true );
	assert.equal( _graph.wouldClose( 'w5', 'w6' ), false );
	assert.equal( cyclic( _graph ), false );
} );

attack( S, 'ids of different types are different nodes, and a cycle through both is still found', () => {
	const _graph = new WaitGraph();
	_graph.add( 1, '1' );
	assert.equal( _graph.wouldClose( 1, '2' ), false );
	assert.throws( () => _graph.add( '1', 1 ), /R4/ );
	const [ _a, _b ] = [ { id: 'same' }, { id: 'same' } ];
	_graph.add( _a, _b );
	assert.doesNotThrow( () => _graph.add( 'x', _a ) );
	assert.throws( () => _graph.add( _b, _a ), /R4/ );
	assert.equal( _graph.wouldClose( _b, { id: 'same' } ), false, 'objects are nodes by identity' );
} );

attack( S, 'a dense graph of two hundred nodes in one order refuses every edge against it', () => {
	const _graph = new WaitGraph();
	for ( let i = 0; i < 200; i++ ) {
		for ( let j = i + 1; j < 200; j += 7 ) { _graph.add( i, j ); }
	}
	const _started = Date.now();
	assert.throws( () => _graph.add( 199, 0 ), /R4/ );
	assert.throws( () => _graph.add( 150, 1 ), /R4/ );
	assert.ok( Date.now() - _started < 5000 );
	assert.equal( cyclic( _graph ), false );
} );

attack( S, 'the refusal names both nodes and the rule, for the wall report', () => {
	const _graph = new WaitGraph();
	_graph.add( 'node-a', 'node-b' );
	assert.throws( () => _graph.add( 'node-b', 'node-a' ), { message: 'node-b waiting for node-a would close a cycle (R4)' } );
} );

attacks( S, [ 1, 2, 3, 4, 5 ].map( seed => ( { name: `random waits (seed ${seed}): the graph never holds a cycle, and every refusal has a way back`, seed } ) ), ( { seed } ) => {
	const _rand = random( seed );
	const _graph = new WaitGraph();
	let _refused = 0;
	for ( let i = 0; i < 1500; i++ ) {
		const [ _from, _to ] = [ `n${_rand.int( 0, 60 )}`, `n${_rand.int( 0, 60 )}` ];
		const _back = _from === _to || path( _graph, _to, _from );
		assert.equal( _graph.wouldClose( _from, _to ), _back, `${_from} → ${_to}` );
		if ( _back ) {
			assert.throws( () => _graph.add( _from, _to ) );
			_refused += 1;
		} else {
			_graph.add( _from, _to );
		}
	}
	assert.equal( cyclic( _graph ), false );
	assert.ok( _refused > 0, 'the random graph got dense enough to refuse' );
} );

attacks( S, [ 6, 7, 8 ].map( seed => ( { name: `random waits that end again (seed ${seed}): adds and removals never leave a cycle`, seed } ) ), ( { seed } ) => {
	const _rand = random( seed );
	const _graph = new WaitGraph();
	const _live = [];
	for ( let i = 0; i < 3000; i++ ) {
		if ( _live.length && _rand() < 0.4 ) {
			const [ _from, _to ] = _live.splice( _rand.int( 0, _live.length - 1 ), 1 )[ 0 ];
			_graph.remove( _from, _to );
			continue;
		}
		const [ _from, _to ] = [ _rand.int( 0, 40 ), _rand.int( 0, 40 ) ];
		if ( _graph.wouldClose( _from, _to ) || _graph.edges.get( _from )?.has( _to ) ) { continue; }
		_graph.add( _from, _to );
		_live.push( [ _from, _to ] );
	}
	assert.equal( cyclic( _graph ), false );
	assert.equal( edges( _graph ).length, _live.length, 'the graph holds exactly the waits that still run' );
} );

attack( S, 'a deep chain of fifty thousand waits is walked without overflowing the stack', () => {
	const _graph = new WaitGraph();
	for ( let i = 0; i < 50000; i++ ) { _graph.add( i, i + 1 ); }
	assert.equal( _graph.wouldClose( 50000, 0 ), true );
	assert.equal( _graph.wouldClose( 0, 50000 ), false );
} );
