// zusage_erhalten (14.1, B5): a commitment came in and was not withdrawn until the criterion's deadline. Not: that
// it still holds on the day. Evidence is the party's claim, with its fixed fields read the same by a parser
// (B4), plus the system's own observation that no contradiction arrived on the matched channel until the deadline.
// A counter-proposal for a time outside the window, or any withdrawal of the party before the deadline (the
// committed slot included), makes it impossible, even next to an observation of "no contradiction". A withdrawal
// after the deadline changes nothing: evidence() leaves out what arrived after it.

app.define( 'Core.Criteria.CommitmentReceived', [ 'Core.Criteria.Criterion' ], Criterion => class CommitmentReceived extends Criterion {

	static TYPE = 'commitment_received';
	static KIND = 'outcome';
	static DESCRIBE = 'a commitment from the party came in and was not withdrawn (zusage_erhalten)';
	static PARAMS = {
		from: { type: 'string', describe: 'the party, e.g. contact:4711' },
		subject: { type: 'string', describe: 'what is committed, e.g. meeting' },
		window: { type: 'window', describe: 'the window the commitment must lie in' },
	};

	static EVIDENCE = [ 'commitment', 'no_contradiction' ];
	static WINDOW_AFTER_DEADLINE = true;

	check( facts, now = Date.now() ) {
		const _facts = this.evidence( facts, now );
		const _refused = this._refused( _facts );
		const _claim = this._claim( _facts );
		if ( !_claim ) {
			return { met: false, evidence: [], reason: 'no matched commitment of the party', impossible: _refused };
		}
		if ( _refused ) {
			return { met: false, evidence: [ _claim.id ], reason: 'the party withdrew it or proposed a time outside the window', impossible: true };
		}
		const _quiet = _facts.find( fact => fact.kind === 'no_contradiction' && fact.evidenceClass === 'observation' && fact.data?.commitment === _claim.id );
		return { met: Boolean( _quiet ), evidence: _quiet ? [ _claim.id, _quiet.id ] : [ _claim.id ], reason: _quiet ? '' : 'not yet without contradiction until the deadline' };
	}

	// B5: at its deadline the system itself observes that no contradiction came in on the matched channel. It names a
	// claim as check() matches it (fixed fields, inside the window); one that came in only after the deadline may be
	// named too, what was observed stays true, and check() still does not count the late claim. A deadline it cannot
	// read gives no point to observe at.
	observe( facts, now ) {
		const _deadline = Criterion.time( this.deadline );
		if ( Number.isNaN( _deadline ) || now < _deadline || this._refused( this.evidence( facts, now ) ) ) { return null; }
		const _claim = this._claim( ( Array.isArray( facts ) ? facts : [] ).filter( fact => fact && typeof fact === 'object' && !fact.superseded ) );
		// The observation is about the time up to the deadline, so it carries the deadline as its time.
		return _claim ? { kind: 'no_contradiction', time: new Date( _deadline ).toISOString(), data: { commitment: _claim.id } } : null;
	}

	// The party's claim with the fixed fields, for a time inside the window.
	_claim( facts ) {
		return facts.find( fact => fact.kind === 'commitment' && fact.evidenceClass === 'claim' && fact.data?.party === this.values.from
			&& fact.data.subject === this.values.subject && Criterion.inWindow( fact.data.at, this.values.window ) );
	}

	_refused( facts ) {
		return facts.some( fact => fact.data?.party === this.values.from && fact.data.subject === this.values.subject
			&& ( fact.kind === 'commitment_withdrawn' || ( fact.kind === 'counter_proposal' && !Criterion.inWindow( fact.data.at, this.values.window ) ) ) );
	}

} );
