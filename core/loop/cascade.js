// The abort cascade (chapter 16.5). Root deadline, an exhausted budget or an abort by the client (or from above)
// run this order: no new move starts (G-1a); the abort goes down to every child, top to bottom, before anything
// else (Z6); what is running ends (tickets withdrawn, sandboxes stopped, waiting released); open outside actions
// are withdrawn at the gate (O9), and an attempt already begun ends as executed or unclear there; the nodes close
// bottom-up as failed or aborted; unclear actions go to a person as a case of their own. A closed node stays
// final (Z5).

app.define( 'Core.Loop.Cascade', [], () => class Cascade {

	constructor( runner ) {
		this.runner = runner;
	}

	// 16.3: an abort ends as failed (deadline, budget, an error) or aborted (the client, from above); never as anything
	// G6 would have to prove.
	static STATUSES = [ 'failed', 'aborted' ];

	// Marks the node and everything below it; each loop sees the mark at its next step and closes. Every clean-up step
	// stands on its own: a board or a runtime that fails does not keep the open outside actions from being withdrawn.
	async abort( node, { reason, status = 'aborted' } ) {
		const _nodes = Cascade.tree( node ).filter( item => item.state !== 'closed' && !item.stopping );
		if ( !_nodes.length ) {
			return false;
		}
		const _status = Cascade.STATUSES.includes( status ) ? status : 'aborted';
		for ( const item of _nodes ) {
			const _own = item === node;
			item.stopping = { reason: _own ? reason : `aborted from above: ${reason}`, status: _own ? _status : 'aborted', at: new Date().toISOString() };
			item.emit( 'abort_received', item.stopping );
			// Z6: the abort comes before every other event of the node; a node that waits is woken for it at once.
			item.wake?.( { kind: 'abort_received', priority: true } );
			this._inherit( item );
		}
		const _ids = _nodes.map( item => item.id );
		Cascade.guarded( () => this.runner.executor.board?.withdraw( _ids ) );
		_ids.forEach( id => Cascade.guarded( () => this.runner.executor.runtime?.stop?.( id ) ) );
		for ( const item of _nodes ) {
			await this.clear( item ).catch( app.fail );
		}
		return true;
	}

	// O9: a withdrawal is a conditional booking at the gate that races with the start of an attempt. Each one waits at
	// most Δ (16.5): a gate that does not answer in time, or answers without a status, leaves the action unclear for a
	// person. An attempt in flight that won the race is followed to its end (executed, or unclear for a person, O8).
	async clear( node ) {
		const _ids = [ ...new Set( node.deliveries || [] ) ];
		const _states = await Promise.all( _ids.map( id => this._withdraw( id ) ) );
		for ( const item of _states.filter( entry => entry.status === 'open' ) ) {
			Cascade.guarded( () => this.runner.execution?.follow?.( node, item.delivery ) );
		}
		const _unclear = _states.filter( item => [ 'unclear', 'unknown' ].includes( item.status ) ).map( item => item.delivery );
		node.unclear = [ ...new Set( [ ...( node.unclear || [] ), ..._unclear ] ) ];
		node.emit( 'outside_cleared', { deliveries: _states, unclear: node.unclear } );
	}

	async _withdraw( id ) {
		let _timer;
		const _late = new Promise( ( resolve ) => {
			_timer = setTimeout( () => resolve( { status: 'unknown', late: true } ), this.delta() );
			_timer.unref?.();
		} );
		const _asked = Promise.resolve().then( () => this.runner.gate.withdraw( id ) ).catch( error => ( { status: 'unknown', error: error.message } ) );
		const _state = await Promise.race( [ _asked, _late ] );
		clearTimeout( _timer );
		return { delivery: id, status: typeof _state?.status === 'string' && _state.status ? _state.status : 'unknown' };
	}

	// G-1a, 16.5: what a node starts after its abort (a new case for a reply that arrives late, a child) is aborted from
	// above as soon as it exists, so no loop below an aborted node goes on, also after the node closed.
	_inherit( owner ) {
		for ( const list of [ owner.children, owner.processes ].filter( Array.isArray ) ) {
			if ( Object.hasOwn( list, 'push' ) ) { continue; }
			Object.defineProperty( list, 'push', { configurable: true, value: ( ...added ) => {
				const _length = Array.prototype.push.apply( list, added );
				// After the step that adds it, so the node is created (node_created) before it hears of the abort.
				queueMicrotask( () => added.filter( node => node && !node.stopping && node.state !== 'closed' ).forEach( ( node ) => {
					this.abort( node, { reason: `aborted from above: ${owner.stopping?.reason || 'the abort'}`, status: 'aborted' } ).catch( app.fail );
				} ) );
				return _length;
			} } );
		}
	}

	// Δ: the buffer every closing is bounded by (16.5), in ms.
	delta() {
		const _minutes = Number( this.runner.bufferMinutes );
		return Number.isFinite( _minutes ) && _minutes >= 0 ? _minutes * 60000 : 5 * 60000;
	}

	// A3: the requests of a move whose lease ran out lose their tokens; an operation the gate already opened runs on,
	// and its outcome still reaches the node (O8).
	async revoke( node ) {
		for ( const id of new Set( node.deliveries || [] ) ) {
			const _row = await this.runner.gate.delivery( id ).catch( () => null );
			const _withdrawn = [ 'awaiting_approval', 'approved' ].includes( _row?.status ) ? await this.runner.gate.withdraw( id ).catch( app.fail ) : null;
			// O9: an operation that is (or, after losing the race with the withdrawal, still is) open is followed.
			if ( _row?.status === 'open' || _withdrawn?.status === 'open' ) {
				this.runner.execution.follow( node, id );
			}
		}
	}

	// Unclear outside actions become a case of their own for a person (O5); the closed node does not wait for it. Sending
	// again would be a new action with a new approval.
	handOver( node ) {
		const _new = ( node.unclear || [] ).filter( id => !( node.handedOver || [] ).includes( id ) );
		if ( !_new.length || !this.runner.executor.board ) {
			return;
		}
		node.handedOver = [ ...( node.handedOver || [] ), ..._new ];
		this.runner.executor.board.ask( node, {
			question: `It is unclear whether these actions of "${node.contract.goal}" took effect: ${_new.join( ', ' )}. Please check them `
				+ 'outside and settle each at the gate (it took effect, or it did not); sending again would be a new action with a new approval.',
			options: [ 'checked' ], recommendation: 'checked', minutes: 5, kind: 'check', reason: 'unclear outside actions (O5)',
		} ).catch( app.fail );
	}

	// The node, its children and the processes it owns (new cases, proposals), each with everything below it, top to
	// bottom. A node reachable twice (a child that is also a process) is listed once, at its first place.
	static tree( node ) {
		const _seen = new Set();
		const _list = [];
		const _stack = [ node ];
		while ( _stack.length ) {
			const _at = _stack.pop();
			if ( !_at || _seen.has( _at ) ) { continue; }
			_seen.add( _at );
			_list.push( _at );
			const _below = [ ...( _at.children || [] ), ...( _at.processes || [] ) ];
			for ( let i = _below.length - 1; i >= 0; i-- ) { _stack.push( _below[ i ] ); }
		}
		return _list;
	}

	// One clean-up step whose failure is reported, never passed on to the next step.
	static guarded( step ) {
		try {
			step();
		} catch ( error ) {
			app.fail( error );
		}
	}

} );
