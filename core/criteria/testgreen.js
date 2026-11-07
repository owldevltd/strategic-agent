// test_gruen (14.1, 3.3): the test passes on exactly this commit. Evidence is an observation of a test run in the
// sandbox on that commit. As a criterion of the agent (layer 2) it can demand more: the test was red first, and it
// catches enough mutations, so a test that cannot fail does not count. Times are compared as instants, whatever
// their zone offset; a mutation run counts only as an observation, and only with 0 <= caught <= of and of > 0.

app.define( 'Core.Criteria.TestGreen', [ 'Core.Criteria.Criterion' ], Criterion => class TestGreen extends Criterion {

	static TYPE = 'test_green';
	static KIND = 'outcome';
	static DESCRIBE = 'the test passes on this commit (test_gruen)';
	static PARAMS = {
		test: { type: 'string', describe: 'the test' },
		commit: { type: 'string', describe: 'the commit' },
		firstRed: { type: 'boolean', optional: true, describe: 'the test must have failed before the change' },
		mutation: { type: 'object', optional: true, describe: '{ caught, of }: mutations the test must catch' },
	};

	static EVIDENCE = [ 'test_run', 'mutation_run' ];

	validate() {
		const _problems = super.validate();
		const _need = this.values.mutation;
		if ( _need && typeof _need === 'object' && !Array.isArray( _need ) && !TestGreen.counted( _need ) ) {
			_problems.push( `${this.id}: mutation must be { caught, of }, whole numbers with 0 <= caught <= of and of > 0` );
		}
		return _problems;
	}

	check( facts, now = Date.now() ) {
		const _facts = this.evidence( facts, now );
		const _runs = _facts.filter( fact => fact.kind === 'test_run' && fact.evidenceClass === 'observation' && fact.data?.test === this.values.test );
		const _greens = _runs.filter( fact => fact.data.commit === this.values.commit && fact.data.result === 'green' );
		if ( !_greens.length ) { return { met: false, evidence: [], reason: 'no green run on this commit' }; }
		// Red first: a red run before the change (another commit) at or before a green run; a run without a time proves no order.
		const _redBefore = green => _runs.some( fact => fact.data.result === 'red' && fact.data.commit !== this.values.commit
			&& Criterion.time( fact.time ) <= Criterion.time( green.time ) );
		const _green = this.values.firstRed ? _greens.find( _redBefore ) : _greens[ 0 ];
		if ( !_green ) {
			return { met: false, evidence: [ _greens[ 0 ].id ], reason: 'it was never red first' };
		}
		const _need = this.values.mutation;
		if ( _need ) {
			if ( !TestGreen.counted( _need ) ) { return { met: false, evidence: [ _green.id ], reason: 'the mutation demand cannot be read' }; }
			const _mutants = _facts.find( fact => fact.kind === 'mutation_run' && fact.evidenceClass === 'observation'
				&& fact.data?.test === this.values.test && fact.data.commit === this.values.commit && TestGreen.counted( fact.data )
				&& fact.data.caught * _need.of >= _need.caught * fact.data.of );
			if ( !_mutants ) { return { met: false, evidence: [ _green.id ], reason: `catches fewer than ${_need.caught} of ${_need.of} mutations` }; }
			return { met: true, evidence: [ _green.id, _mutants.id ], reason: '' };
		}
		return { met: true, evidence: [ _green.id ], reason: '' };
	}

	// A mutation count that means something: whole numbers, of > 0 mutants, 0 <= caught <= of.
	static counted( data ) {
		const { caught, of } = data || {};
		return Number.isSafeInteger( caught ) && Number.isSafeInteger( of ) && of > 0 && caught >= 0 && caught <= of;
	}

} );
