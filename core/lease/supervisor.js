// The supervision of running moves (chapter 18.6, A1–A4). Every move runs under a lease from the gate, with the
// maximum length from the catalog (or by kind of move: code 2, model 3, outside action 5 minutes); a heartbeat
// renews it while the move runs. When the lease runs out, the supervisor ends the move: the sandbox is stopped and
// discarded, the move counts as aborted, and whatever it still returns is fenced off and never written. The gate
// checks the same lease itself before it starts any outside action, so a late worker cannot act either.

app.define( 'Core.Lease.Supervisor', [], () => class Supervisor {

	static MINUTES = { code: 2, ai: 3, action: 5 };

	constructor( { gate, runtime = null, beatMs = 15000 } ) {
		Object.assign( this, { gate, runtime, beatMs } );
	}

	// work( lease ) runs the move; → its output, or { leaseExpired: true } when the lease ran out first.
	async hold( node, step, move, work, { holder = node.id } = {} ) {
		if ( move?.executor === 'child' ) {
			return work( null );
		}
		const _left = Math.max( 0.01, ( Date.parse( node.contract.deadline ) - Date.now() ) / 60000 );
		const _kind = move?.action ? 'action' : move?.executor;
		const _minutes = Number( move?.leaseMaxMin ?? Supervisor.MINUTES[ _kind ] ?? _left );
		const _beatMinutes = Math.min( _minutes, ( this.beatMs * 4 ) / 60000 );
		const _request = { node: holder, move: step.move, contract: node.contract.hash, minutes: _minutes, beatMinutes: _beatMinutes };
		const _lease = await this.gate.lease( _request );
		let _lost = false;
		let _expire;
		const _expired = new Promise( ( resolve ) => {
			_expire = resolve;
		} );
		const _end = ( why ) => {
			if ( _lost ) { return; }
			_lost = true;
			this.runtime?.stop( node.id );
			node.emit( 'lease_expired', { move: step.move, lease: _lease.id, fence: _lease.fence, why } );
			_expire( { leaseExpired: true } );
		};
		const _timer = Supervisor.at( Date.parse( _lease.maxUntil ), () => _end( 'maximum reached' ) );
		const _beat = setInterval( () => {
			this.gate.beat( _lease.id, _lease.fence ).then( result => !result.ok && _end( 'heartbeat refused' ) ).catch( () => _end( 'gate unreachable' ) );
		}, this.beatMs );
		_beat.unref?.();
		try {
			const _out = await Promise.race( [ work( { id: _lease.id, fence: _lease.fence } ), _expired ] );
			return _lost ? { leaseExpired: true } : _out;
		} finally {
			_timer.clear();
			clearInterval( _beat );
			this.gate.release( _lease.id, _lease.fence ).catch( () => {} );
		}
	}

	// A timer for a moment that may lie further ahead than a Node timer can count (2^31-1 ms, about 24.8 days): when it
	// fires early, it is armed again for the rest. → { clear }
	static at( time, fn ) {
		const _timer = { handle: null, clear: () => clearTimeout( _timer.handle ) };
		const _arm = () => {
			const _wait = Math.min( Math.max( 0, time - Date.now() ), Supervisor.MAX_TIMER_MS );
			_timer.handle = setTimeout( () => ( time - Date.now() > 0 ? _arm() : fn() ), _wait );
			_timer.handle.unref?.();
		};
		_arm();
		return _timer;
	}

	static MAX_TIMER_MS = 2 ** 31 - 1;

} );
