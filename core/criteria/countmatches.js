// menge_erhalten (14.1): the number of records matches within the tolerance. Evidence is an observation of both
// counts in the same run; the latest run counts, latest by the time it counted. A count is a whole number of at
// least 0 (or text that is one): null, true, '' or -5 counted nothing real and prove nothing.

app.define( 'Core.Criteria.CountMatches', [ 'Core.Criteria.Criterion' ], Criterion => class CountMatches extends Criterion {

	static TYPE = 'count_matches';
	static KIND = 'outcome';
	static DESCRIBE = 'the number of records arrived complete within the tolerance (menge_erhalten)';
	static PARAMS = {
		source: { type: 'string', describe: 'e.g. db:customers' },
		target: { type: 'string', describe: 'e.g. export.csv' },
		tolerance: { type: 'number', min: 0, describe: 'allowed difference, never negative (K6)' },
	};

	static EVIDENCE = [ 'count' ];

	check( facts, now = Date.now() ) {
		const _count = Criterion.latest( this.evidence( facts, now ).filter( fact => fact.kind === 'count' && fact.evidenceClass === 'observation'
			&& fact.data?.source === this.values.source && fact.data.target === this.values.target ) );
		if ( !_count ) { return { met: false, evidence: [], reason: 'not counted' }; }
		const [ _source, _target ] = [ CountMatches.count( _count.data.sourceCount ), CountMatches.count( _count.data.targetCount ) ];
		if ( _source === null || _target === null ) { return { met: false, evidence: [ _count.id ], reason: 'the run counted no readable numbers' }; }
		const _met = Math.abs( _source - _target ) <= this.values.tolerance;
		return { met: _met, evidence: [ _count.id ], reason: `${_target} of ${_source}` };
	}

	// A whole number of records, at least 0: a number, or text of digits. → the count, or null.
	static count( value ) {
		const _number = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+\s*$/.test( value ) ? Number( value ) : NaN;
		return Number.isSafeInteger( _number ) && _number >= 0 ? _number : null;
	}

} );
