// O1, O4, O5, O7: what the gate does with the operations it cannot simply finish. After a crash it rebuilds the open
// ones from its ledger: no attempt booked means nothing was sent and the first attempt may follow; an attempt without a
// result goes on with the service's guarantee (O7), otherwise the gate asks the world (O4), and anything but a clear
// "executed" makes it unclear, an end state for a person (O5). A "not there" never allows a repetition. An operation
// withdrawn while its attempt was in flight is only reconciled, never sent again (O9). One operation that fails to
// recover never stops the others.
//
// An unclear operation counts as if it went out (exactly once, sums, releases) until a person settles it: they checked
// outside and say it took effect (executed) or did not (not_sent). Settling sends nothing; it only books what the
// person found, once, and the ledger keeps what it said before.

app.define( 'Gate.Recovery', [ 'Gate.Rules', 'Gate.Channels' ], ( Rules, Channels ) => class Recovery {

	static RESULTS = [ 'executed', 'not_sent' ];
	static MAX_REASON = 500;

	static async recover( egress ) {
		egress._expire();
		// O1: an action booked as waiting without its approval (an older gate booked the two apart) can never be decided
		// and would block "exactly once" and sums forever; it ends refused.
		egress.store.refuseOrphans( [ { rule: 'token', reason: 'no approval was ever asked for this action (O1)' } ] );
		for ( const row of egress.db.all( 'SELECT id FROM deliveries WHERE status = \'open\' ORDER BY createdAt' ) ) {
			await Recovery._one( egress, row.id ).catch( ( error ) => {
				egress.log.append( 'recover_failed', { delivery: row.id, error: String( error?.message ).slice( 0, 300 ) } );
			} );
		}
		return Recovery.unclear( egress );
	}

	static async _one( egress, id ) {
		const _delivery = egress.store.delivery( id );
		const _last = egress.db.get( 'SELECT * FROM attempts WHERE delivery = :id ORDER BY nr DESC LIMIT 1', { id } );
		const _again = !_delivery.withdrawn && egress._idempotent( _delivery );
		if ( !_last ) {
			return _delivery.withdrawn ? egress.store.setStatus( id, 'not_sent' ) : egress._execute( id );
		}
		if ( _again ) {
			if ( !_last.result ) { egress._finishAttempt( id, _last.nr, 'open', { error: 'the gate stopped during this attempt' } ); }
			return egress._execute( id );
		}
		const _found = await Channels.lookup( egress._channel( _delivery ), _delivery, egress.sendMs );
		egress._finishAttempt( id, _last.nr, _found ? 'executed' : 'unclear', _found ? _found.receipt ?? null : { reconciled: 'not found' } );
		egress.log.append( 'reconciled', { delivery: id, found: Boolean( _found ) } );
		return null;
	}

	// O5: the operations nobody can say went out or not, in the order they were requested.
	static unclear( egress ) {
		return egress.db.all( 'SELECT id FROM deliveries WHERE status = \'unclear\' ORDER BY createdAt' ).map( row => egress.store.delivery( row.id ) );
	}

	// A person settles one unclear operation: { result: 'executed' | 'not_sent', by, reason }. Only an unclear one, and
	// only once; executed books its release like any confirmed action. → the delivery as it now stands.
	static settle( egress, id, decision ) {
		const { result, by = 'operator', reason = '' } = Rules.object( decision ) ? decision : {};
		if ( !Recovery.RESULTS.includes( result ) ) {
			throw Rules.refusal( `an unclear action is settled as ${Recovery.RESULTS.join( ' or ' )}` );
		}
		const _settled = egress.db.transaction( () => {
			const _delivery = egress.store.delivery( id );
			if ( !_delivery ) { throw Rules.refusal( 'no such action', 404 ); }
			if ( _delivery.status !== 'unclear' ) { throw Rules.refusal( `only an unclear action is settled; this one is ${_delivery.status}`, 409 ); }
			const _receipt = {
				settled: result, by: Recovery._text( by, 100 ) || 'operator', reason: Recovery._text( reason, Recovery.MAX_REASON ),
				at: egress._iso(), before: _delivery.receipt ?? null,
			};
			egress.db.run( 'UPDATE deliveries SET status = :status, receipt = :receipt WHERE id = :id AND status = \'unclear\'', {
				id, status: result, receipt: JSON.stringify( Rules.json( _receipt ) ) } );
			if ( result === 'executed' && Array.isArray( _delivery.cohort ) ) {
				egress.db.run( 'INSERT INTO releases ( contract, root, delivery, cohort ) VALUES ( :contract, :root, :id, :cohort )',
					{ contract: _delivery.contract, root: _delivery.root, id, cohort: JSON.stringify( [ ..._delivery.cohort ].sort() ) } );
			}
			return _receipt;
		} );
		egress.log.append( 'settled', { delivery: id, result, by: _settled.by } );
		return egress.store.delivery( id );
	}

	static _text( value, max ) {
		return typeof value === 'string' ? value.trim().slice( 0, max ) : '';
	}

} );
