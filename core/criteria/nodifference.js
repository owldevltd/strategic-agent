// Two releases must not differ by fewer than k people; otherwise "the same without Anna" gives Anna away. The gate
// compares every new group with every group it has released in the same scope; the evidence is its receipts. The
// comparison is pairwise, as the paper says: each two releases at a time, not unions of several. People are counted
// as the gate counts them: distinct ids (4711 and '4711' are one person), so repeated, empty or retyped entries never
// inflate a difference past k; a group with an entry that is no id is a breach by itself (fail closed).

app.define( 'Core.Criteria.NoDifference', [ 'Core.Criteria.Criterion' ], Criterion => class NoDifference extends Criterion {

	static TYPE = 'no_difference';
	static KIND = 'invariant';
	static DESCRIBE = 'two releases must not differ by fewer than k people';
	static PARAMS = { k: { type: 'integer', min: 2, describe: 'smallest allowed difference' } };

	check( facts, now = Date.now() ) {
		const _releases = Criterion.releases( this.evidence( facts, now ) )
			.map( fact => ( { id: fact.id, people: Criterion.people( fact.data.cohort ) } ) );
		const _groups = _releases.filter( item => item.people );
		const _close = [];
		_groups.forEach( ( a, i ) => _groups.slice( i + 1 ).forEach( ( b ) => {
			const _only = ( x, y ) => [ ...x.people ].filter( id => !y.people.has( id ) ).length;
			const _diff = _only( a, b ) + _only( b, a );
			if ( _diff > 0 && _diff < this.values.k ) { _close.push( a.id, b.id ); }
		} ) );
		const _unreadable = _releases.filter( item => !item.people ).map( item => item.id );
		const _reason = [ _close.length ? 'two releases differ by too few people' : '', _unreadable.length ? 'a release whose group names someone who is no id' : '' ];
		return { met: !_close.length && !_unreadable.length, evidence: [ ..._close, ..._unreadable ], reason: _reason.filter( Boolean ).join( '; ' ) };
	}

	atLeastAsStrict( other ) {
		return this.type === other?.type && this.values.k >= other.values?.k;
	}

	gateRules() {
		return [ { rule: 'no_difference', actions: [ 'carries:data' ], k: this.values.k } ];
	}

} );
