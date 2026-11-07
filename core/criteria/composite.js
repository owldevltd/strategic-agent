// A criterion type that a person approved through its own process (14, 6.1): it holds when all its parts hold. Each
// part is an existing type with values; {{name}} in a part names a parameter of the new type. It can never accept
// less than its parts: its predicate is the conjunction of theirs, its validation is theirs plus its own (a part
// alone would be refused, so is the composite), and its rules are the union of theirs, so the gate and the plan
// check enforce every part (G2). It combines at least two parts; a definition without any cannot be built.

app.define( 'Core.Criteria.Composite', [ 'Core.Criteria.Criterion', 'Core.Loop.Plan' ], ( Criterion, Plan ) => class Composite {

	// A definition that cannot be read at all (no list of parts, a part that is no object or names nothing the registry
	// has heard of) cannot be built. A name that is no type the registry owns (one of Object.prototype) is refused by
	// validate() and never met.
	static of( definition, registry ) {
		if ( !Array.isArray( definition.all ) || !definition.all.length ) { throw new Error( `${definition.type}: a criterion type needs a list of parts` ); }
		for ( const part of definition.all ) {
			if ( !part || typeof part !== 'object' || registry.types[ part.type ] === undefined ) {
				throw new Error( `${definition.type}: ${String( part?.type ).slice( 0, 40 )} is no criterion type` );
			}
		}
		const _names = Array.isArray( definition.params ) ? definition.params : [];
		const _params = Object.fromEntries( _names.map( name => [ name, { type: 'string', describe: name } ] ) );
		const _types = definition.all.map( part => ( registry.has( part.type ) ? registry.types[ part.type ] : null ) );
		return class extends Criterion {

			static TYPE = definition.type;
			static KIND = 'outcome';
			static DESCRIBE = definition.describe || `all of ${definition.all.map( part => part.type ).join( ', ' )}`;
			static PARAMS = _params;
			static EVIDENCE = [ ...new Set( _types.flatMap( Type => Type?.EVIDENCE || [] ) ) ];

			// K4: the union of the parts' kinds is not enough; every outcome part needs a channel of its own (a channel for a
			// report proves nothing about a count). Invariant and soft parts need none.
			static channelled( delivered ) {
				return _types.every( Type => Type && ( Type.KIND !== 'outcome' || Type.channelled( delivered ) ) );
			}

			// Only its declared parameters fill the parts: a value it does not declare never reaches one.
			parts() {
				const _given = _names.filter( name => Object.hasOwn( this.values, name ) );
				const _slots = Object.fromEntries( _given.map( name => [ name, this.values[ name ] ] ) );
				return definition.all.map( ( part, i ) => registry.create( {
					id: `${this.id}.${i + 1}`, type: part.type, values: Plan.fill( part.values || {}, _slots ), deadline: this.deadline,
				} ) );
			}

			validate() {
				const _problems = super.validate();
				if ( definition.all.length < 2 ) { _problems.push( `${this.id}: a criterion type combines at least two parts` ); }
				definition.all.forEach( ( part, i ) => {
					const _id = `${this.id}.${i + 1}`;
					if ( !_types[ i ] ) {
						_problems.push( `${_id}: ${String( part.type ).slice( 0, 40 )} is no criterion type` );
					} else if ( _types[ i ].INTERNAL ) {
						_problems.push( `${_id}: ${part.type} is set by the system, never part of a criterion type` );
					}
					for ( const name of Composite.placeholders( part.values ).filter( item => !_names.includes( item ) ) ) {
						_problems.push( `${_id}: {{${name.slice( 0, 40 )}}} names no parameter of ${this.type}` );
					}
				} );
				for ( const part of this.parts().filter( Boolean ) ) {
					_problems.push( ...part.validate() );
				}
				return _problems;
			}

			check( facts, now = Date.now() ) {
				const _results = this.parts().map( ( part, i ) => ( part ? part.check( facts, now )
					: { met: false, evidence: [], reason: `${String( definition.all[ i ].type ).slice( 0, 40 )} is no criterion type` } ) );
				const _open = _results.filter( result => !result.met );
				return { met: !_open.length, evidence: _results.flatMap( result => result.evidence || [] ), reason: _open.map( result => result.reason ).join( '; ' ) };
			}

			flowRules() {
				return this.parts().filter( Boolean ).flatMap( part => part.flowRules() );
			}

			gateRules() {
				return this.parts().filter( Boolean ).flatMap( part => part.gateRules() );
			}

			// What a part allows, it allows together with that part's own gate rules (a group of at least k), never more.
			allows() {
				return this.parts().filter( Boolean ).flatMap( part => part.allows() );
			}

		};
	}

	// The parameter names its {{placeholders}} use, in values, lists and nested objects alike ({{name|filter}} is name).
	static placeholders( value ) {
		if ( typeof value === 'string' ) { return [ ...value.matchAll( /\{\{([\w|]+)\}\}/g ) ].map( match => match[ 1 ].split( '|' )[ 0 ] ); }
		if ( Array.isArray( value ) ) { return value.flatMap( item => Composite.placeholders( item ) ); }
		return value && typeof value === 'object' ? Object.values( value ).flatMap( item => Composite.placeholders( item ) ) : [];
	}

} );
