// The outside world's view, for the demo counters: of everything that actually arrived outside, how many
// people from the confidential roster can be recognised by name? It reads only what left (the gate's outbox and
// the neighbour office's outbox); the core never uses this.

app.define( 'World.Observer', [], () => class Observer {

	static exposed( texts, rosterFile ) {
		if ( !rosterFile ) { return []; }
		const _names = app.lib( 'node:fs' ).readFileSync( rosterFile, 'utf8' ).split( /\r?\n/ ).slice( 1 ).filter( Boolean ).map( line => line.split( ',' )[ 0 ] );
		const _found = new Set();
		for ( const text of texts ) {
			for ( const name of _names ) {
				if ( new RegExp( `\\b${name}\\b`, 'i' ).test( text ) ) { _found.add( name ); }
			}
		}
		return [ ..._found ];
	}

	// Money that left wrongly: payments to accounts outside the master data, and any second payment of an invoice
	// (counted against everything that was paid before, in either office).
	static lost( payments, accounts, paidBefore = [] ) {
		const _known = new Set( accounts );
		const _paid = new Set( paidBefore );
		let _lost = 0;
		for ( const payment of payments ) {
			if ( !_known.has( payment.iban ) || _paid.has( payment.invoiceId ) ) {
				_lost += Number( payment.amount || 0 );
			}
			_paid.add( payment.invoiceId );
		}
		return _lost;
	}

} );
