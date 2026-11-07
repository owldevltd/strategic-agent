// G3: the only way from outside (and from execution) into judgment. A fact passes when it is of a kind its
// expectation names, carries an evidence class and an origin, belongs to the contract of the node it is for, and
// holds no text from the world: only ids, numbers and values from fixed lists (G-8). Anything else is dropped and
// goes to a person instead. Without an expected kind or contract nothing matches (fail closed).

app.define( 'Core.Check.FactCheck', [], () => class FactCheck {

	static GATE = 'G3';
	static CLASSES = [ 'observation', 'confirmation', 'claim', 'derivation' ];

	// The fields a fact carries on its way in (8.3): what it is, where it came from, how sure and how long it holds,
	// and the plain data. A field outside this list is no part of a fact and could carry anything.
	static FIELDS = [ 'id', 'kind', 'evidenceClass', 'origin', 'source', 'contract', 'data', 'attempt', 'provenance', 'parserMatch',
		'validUntil', 'time', 'claimedTime', 'labels', 'late' ];

	// The rough order of 15, only for cascades and pre-filters: what is derived carries the weakest class of its inputs.
	static RANK = { observation: 4, confirmation: 3, claim: 2, derivation: 1 };

	static rank( item ) {
		return typeof item === 'string' && Object.hasOwn( FactCheck.RANK, item ) ? FactCheck.RANK[ item ] : 0;
	}

	static lowest( classes ) {
		const _known = classes.filter( item => FactCheck.rank( item ) );
		return _known.length ? _known.reduce( ( low, item ) => ( FactCheck.rank( item ) < FactCheck.rank( low ) ? item : low ) ) : 'derivation';
	}

	static ID = /^[A-Za-z0-9_.:-]{1,64}$/;

	// How deep a list may be nested in plain data; deeper is no plain value (and never overflows the stack).
	static DEPTH = 8;

	check( fact, { expectation, contract } ) {
		if ( !fact || typeof fact !== 'object' || Array.isArray( fact ) ) {
			return { gate: FactCheck.GATE, ok: false, problems: [ 'the fact is no object' ] };
		}
		const _problems = [];
		const _kind = expectation?.fact;
		if ( typeof _kind !== 'string' || !_kind ) {
			_problems.push( 'the expectation names no kind of fact, so nothing matches it' );
		} else if ( _kind !== fact.kind ) {
			_problems.push( `the expectation waits for ${_kind}, not ${fact.kind}` );
		}
		if ( !FactCheck.CLASSES.includes( fact.evidenceClass ) ) {
			_problems.push( 'no evidence class' );
		}
		if ( !fact.origin || !fact.source ) {
			_problems.push( 'no origin' );
		}
		if ( typeof contract !== 'string' || !contract ) {
			_problems.push( 'no contract to hold the fact against' );
		} else if ( fact.contract !== contract ) {
			_problems.push( 'the fact belongs to another contract' );
		}
		_problems.push( ...Object.keys( fact ).filter( name => !FactCheck.FIELDS.includes( name ) ).map( name => `${name.slice( 0, 40 )} is no field of a fact` ) );
		// Data is a record of plain values (or a list of them), or nothing; a text alone is free text.
		const _data = fact.data;
		if ( _data !== undefined && _data !== null && typeof _data !== 'object' ) {
			_problems.push( 'data carries free text' );
		} else {
			for ( const [ name, value ] of Object.entries( _data || {} ) ) {
				if ( !FactCheck.plain( value ) ) {
					_problems.push( `${name} carries free text` );
				}
			}
		}
		return { gate: FactCheck.GATE, ok: _problems.length === 0, problems: _problems };
	}

	static plain( value, depth = 0 ) {
		if ( typeof value === 'number' || typeof value === 'boolean' || value === null ) { return true; }
		if ( typeof value === 'string' ) { return FactCheck.ID.test( value ); }
		return Array.isArray( value ) && depth < FactCheck.DEPTH && value.every( item => FactCheck.plain( item, depth + 1 ) );
	}

} );
