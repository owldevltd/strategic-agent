// The wait graph (R4): which node waits for which node or ticket, across the whole tree and between siblings.
// A plan that would close a cycle in it is refused at G2, so no node can end up waiting for itself.
// Ids compare as the Map does (SameValueZero): NaN is one id like any other, 1 and '1' are two, objects count by
// identity. Two waits of a on b share one edge, which stays until the last of them ended.

app.define( 'Core.Loop.WaitGraph', [], () => class WaitGraph {

	constructor() {
		this.edges = new Map();
		this._counts = new Map();
	}

	add( from, to ) {
		if ( this.wouldClose( from, to ) ) {
			throw new Error( `${WaitGraph.label( from )} waiting for ${WaitGraph.label( to )} would close a cycle (R4)` );
		}
		const _set = this.edges.get( from ) || new Set();
		const _counts = this._counts.get( from ) || new Map();
		_set.add( to );
		_counts.set( to, ( _counts.get( to ) || 0 ) + 1 );
		this.edges.set( from, _set );
		this._counts.set( from, _counts );
	}

	// One wait ended; the edge goes only with the last wait that needed it, and an empty set goes with its last edge.
	remove( from, to ) {
		const _counts = this._counts.get( from );
		if ( !_counts?.has( to ) ) { return; }
		const _left = _counts.get( to ) - 1;
		if ( _left > 0 ) {
			_counts.set( to, _left );
			return;
		}
		_counts.delete( to );
		this.edges.get( from )?.delete( to );
		if ( !_counts.size ) {
			this._counts.delete( from );
			this.edges.delete( from );
		}
	}

	// Would "from waits for to" close a cycle? It does when to already waits for from, directly or through others.
	// Iterative and one successor at a time: neither a deep chain nor a very wide fan-out can overflow anything.
	wouldClose( from, to ) {
		const _seen = new Set();
		const _stack = [ to ];
		while ( _stack.length ) {
			const _at = _stack.pop();
			if ( WaitGraph.same( _at, from ) ) { return true; }
			if ( _seen.has( _at ) ) { continue; }
			_seen.add( _at );
			for ( const next of this.edges.get( _at ) || [] ) {
				if ( !_seen.has( next ) ) { _stack.push( next ); }
			}
		}
		return false;
	}

	// SameValueZero, the equality of Map and Set: === except that NaN equals NaN.
	static same( a, b ) {
		return a === b || ( Number.isNaN( a ) && Number.isNaN( b ) );
	}

	static label( id ) {
		try {
			return String( id );
		} catch {
			return typeof id;
		}
	}

} );
