// ereignis_eingetreten (14.1): the event took place within its window. Evidence is a confirmation by a participant
// in the named role, or an observation of a system that records the event itself (a call or conference log with
// participants). A calendar entry is an observation too, but it only proves that the event was planned, and a log
// whose participant list is empty only shows a room that was open. Without a named role, a confirmation in any role
// counts.

app.define( 'Core.Criteria.EventOccurred', [ 'Core.Criteria.Criterion' ], Criterion => class EventOccurred extends Criterion {

	static TYPE = 'event_occurred';
	static KIND = 'outcome';
	static DESCRIBE = 'the event took place within the window (ereignis_eingetreten)';
	static PARAMS = {
		event: { type: 'string', describe: 'which event, e.g. meeting:t-88' },
		window: { type: 'window', describe: 'from and to' },
		role: { type: 'string', optional: true, describe: 'the role of the participant who may confirm it' },
		after: { type: 'string', optional: true, describe: 'the id of a criterion this event depends on (K3)' },
	};

	static EVIDENCE = [ 'event_confirmed', 'event_recorded' ];

	check( facts, now = Date.now() ) {
		const _confirmed = fact => fact.kind === 'event_confirmed' && fact.evidenceClass === 'confirmation'
			&& ( !this.values.role || fact.data.role === this.values.role );
		const _recorded = fact => fact.kind === 'event_recorded' && fact.evidenceClass === 'observation' && EventOccurred.attended( fact.data.participants );
		const _proof = this.evidence( facts, now ).find( fact => fact.data?.event === this.values.event
			&& Criterion.inWindow( fact.data.at, this.values.window ) && ( _confirmed( fact ) || _recorded( fact ) ) );
		return { met: Boolean( _proof ), evidence: _proof ? [ _proof.id ] : [], reason: _proof ? '' : 'no confirmation or record of the event' };
	}

	// A record that lists its participants lists at least one, each of them named; an empty list ([]) shows a room that
	// was open. A record that carries no list at all is still read as the recorder's own observation.
	static attended( participants ) {
		if ( participants === undefined ) { return true; }
		return Array.isArray( participants ) && participants.length > 0 && participants.every( item => item !== null && item !== undefined && item !== '' );
	}

} );
