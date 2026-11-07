// beleg_vorhanden (14.1): the document exists, unchanged. Evidence is an observation with a checksum; it must match
// the expected checksum, or, without one, the checksum the document had when it was first observed. Every
// observation needs its checksum: one without (missing, null, '') proves nothing about "unchanged", so it leaves the
// criterion open. First and latest go by the time of the observation, not by the order the facts arrived in.

app.define( 'Core.Criteria.DocumentPresent', [ 'Core.Criteria.Criterion' ], Criterion => class DocumentPresent extends Criterion {

	static TYPE = 'document_present';
	static KIND = 'outcome';
	static DESCRIBE = 'the document exists unchanged (beleg_vorhanden)';
	static PARAMS = {
		kind: { type: 'string', describe: 'e.g. delivery note' },
		ref: { type: 'string', describe: 'e.g. its number' },
		checksum: { type: 'string', optional: true, describe: 'the expected checksum' },
	};

	static EVIDENCE = [ 'document' ];

	check( facts, now = Date.now() ) {
		const _seen = Criterion.byTime( this.evidence( facts, now ).filter( fact => fact.kind === 'document' && fact.evidenceClass === 'observation'
			&& fact.data?.kind === this.values.kind && fact.data.ref === this.values.ref ) );
		if ( !_seen.length ) { return { met: false, evidence: [], reason: 'not observed' }; }
		if ( !_seen.every( fact => typeof fact.data.checksum === 'string' && fact.data.checksum !== '' ) ) {
			return { met: false, evidence: [], reason: 'observed without a checksum' };
		}
		const _expected = this.values.checksum || _seen[ 0 ].data.checksum;
		const _latest = _seen.at( -1 );
		const _met = _latest.data.checksum === _expected;
		return { met: _met, evidence: [ _latest.id ], reason: _met ? '' : 'the document has changed' };
	}

} );
