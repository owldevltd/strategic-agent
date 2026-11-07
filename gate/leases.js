// Leases and fencing tokens (chapter 18.6). Every running move holds a lease from the gate with a maximum length
// from the catalog and renews it by heartbeat (A1). Each new lease of a node gets a higher fencing token; the gate
// accepts a new outside action only with a lease that is still running and carries the node's current token
// (A6), so a worker that wakes up after its lease ran out cannot start anything (A4). Every lease ends by itself,
// at the latest at the root deadline plus the buffer (A7); when in doubt the gate says no (A8).

app.define( 'Gate.Leases', [ 'Lib.Hash' ], Hash => class Leases {

	// A7: without a deadline to bound it, no lease runs longer than this.
	static MAX_MINUTES = 24 * 60;

	constructor( db, { now = () => Date.now(), bufferMinutes = 5 } = {} ) {
		Object.assign( this, { db, now, bufferMinutes } );
		this.db.exec( `CREATE TABLE IF NOT EXISTS leases (
			id TEXT PRIMARY KEY, node TEXT NOT NULL, move TEXT NOT NULL, contract TEXT, fence INTEGER NOT NULL,
			maxUntil TEXT NOT NULL, expiresAt TEXT NOT NULL, minutes REAL NOT NULL, status TEXT NOT NULL, grantedAt TEXT NOT NULL
		)` );
	}

	// limit: the latest end any lease of this goal may have (root deadline plus buffer). → the lease, or null when the
	// request cannot be read (a node that is no text, minutes that are no number, a limit that is no time): A8.
	grant( { node, move = '', contract = null, minutes = 2, beatMinutes = minutes, limit = null } = {} ) {
		const _limit = limit === null || limit === undefined ? this.now() + Leases.MAX_MINUTES * 60000 : Date.parse( limit );
		const _readable = typeof node === 'string' && ( contract === null || typeof contract === 'string' )
			&& typeof minutes === 'number' && !Number.isNaN( minutes ) && typeof beatMinutes === 'number' && !Number.isNaN( beatMinutes )
			&& Number.isFinite( _limit ) && ( limit === null || limit === undefined || typeof limit === 'string' );
		if ( !_readable ) {
			return null;
		}
		return this.db.transaction( () => {
			const _fence = ( this.db.get( 'SELECT MAX( fence ) AS f FROM leases WHERE node = :node', { node } ).f || 0 ) + 1;
			// Huge minutes overflow to Infinity and are cut at the limit; the end is always a time.
			const _end = Math.min( this.now() + minutes * 60000, _limit );
			const _row = {
				id: Hash.id( 'ls' ), node, move: typeof move === 'string' ? move : '', contract, fence: _fence, minutes: beatMinutes, status: 'active',
				maxUntil: new Date( _end ).toISOString(),
				expiresAt: new Date( Math.min( _end, this.now() + beatMinutes * 60000 ) ).toISOString(),
				grantedAt: new Date( this.now() ).toISOString(),
			};
			this.db.run( `UPDATE leases SET status = 'superseded' WHERE node = :node AND status = 'active'`, { node } );
			this.db.run( `INSERT INTO leases ( id, node, move, contract, fence, maxUntil, expiresAt, minutes, status, grantedAt )
				VALUES ( :id, :node, :move, :contract, :fence, :maxUntil, :expiresAt, :minutes, :status, :grantedAt )`, _row );
			return { id: _row.id, fence: _fence, expiresAt: _row.expiresAt, maxUntil: _row.maxUntil };
		} );
	}

	// A heartbeat moves the end forward, never beyond the lease's maximum.
	beat( id, fence ) {
		const _lease = this.valid( id, fence );
		if ( !_lease ) {
			return { ok: false };
		}
		const _until = new Date( Math.min( Date.parse( _lease.maxUntil ), this.now() + _lease.minutes * 60000 ) ).toISOString();
		this.db.run( 'UPDATE leases SET expiresAt = :until WHERE id = :id', { id, until: _until } );
		return { ok: true, expiresAt: _until };
	}

	// A4: every write carries the fencing token of the lease; the id alone (it is in the gate's public log) ends nothing.
	release( id, fence ) {
		if ( !this.valid( id, fence ) ) {
			return { ok: false };
		}
		this.db.run( 'UPDATE leases SET status = \'released\' WHERE id = :id AND status = \'active\'', { id } );
		return { ok: true };
	}

	// Valid: active, not expired (valid while now <= expiresAt), and the newest token of its node. The id is a text and
	// the fencing token an integer; anything else names no lease.
	valid( id, fence ) {
		if ( typeof id !== 'string' || id === '' || !Number.isInteger( fence ) ) {
			return null;
		}
		const _lease = this.db.get( 'SELECT * FROM leases WHERE id = :id', { id } );
		if ( !_lease || _lease.status !== 'active' || fence !== _lease.fence || this.now() > Date.parse( _lease.expiresAt ) ) {
			return null;
		}
		const _newest = this.db.get( 'SELECT MAX( fence ) AS f FROM leases WHERE node = :node', { node: _lease.node } ).f;
		return _newest === _lease.fence ? _lease : null;
	}

} );
