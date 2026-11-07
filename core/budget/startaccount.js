// R1: the root goal has a start account of B tokens, kept in the core's own store. Every start of a round, a child,
// a new case or a proposal process burns one, at the start, atomically and irrevocably: the burn and the start event
// are one transaction in the same database as the event log, so neither exists without the other, also across a
// restart. Budget that flows back never adds a token.

app.define( 'Core.Budget.StartAccount', [], () => class StartAccount {

	constructor( db ) {
		this.db = db;
		this.db.exec( 'CREATE TABLE IF NOT EXISTS start_accounts ( root TEXT PRIMARY KEY, total INTEGER NOT NULL, used INTEGER NOT NULL )' );
	}

	// B is a whole number of starts: a fraction counts its whole starts, a number below zero none, and a total that is
	// no number (text, NaN, null) opens no account. A missing or an infinite total is refused, so nothing starts
	// without bound.
	open( root, total ) {
		if ( total === undefined ) { throw new Error( 'a start account needs its total of start tokens (R1)' ); }
		const _total = typeof total === 'number' || ( typeof total === 'string' && total.trim() !== '' ) ? Number( total ) : NaN;
		if ( _total === Infinity ) { throw new RangeError( 'an infinite start account is refused (R1)' ); }
		if ( Number.isNaN( _total ) ) { return; }
		const _tokens = _total > 0 ? Math.min( Math.floor( _total ), Number.MAX_SAFE_INTEGER ) : 0;
		this.db.run( 'INSERT OR IGNORE INTO start_accounts ( root, total, used ) VALUES ( :root, :total, 0 )', { root, total: _tokens } );
	}

	left( root ) {
		const _row = this.db.get( 'SELECT total - used AS left FROM start_accounts WHERE root = :root', { root } );
		return _row ? _row.left : 0;
	}

	// start(): writes the start event. → its result, or null when no token is left (then no event is written either).
	// The start's own result is handed back after the commit: a start that answers with a promise has burnt its token
	// at once (the booking never waits for it), and a later rejection never gives the token back (R1).
	burn( root, start ) {
		const _started = {};
		const _burnt = this.db.transaction( () => {
			const _done = this.db.run( 'UPDATE start_accounts SET used = used + 1 WHERE root = :root AND used < total', { root } ).changes;
			if ( _done ) { _started.result = start(); }
			return Boolean( _done );
		} );
		return _burnt ? _started.result || true : null;
	}

} );
