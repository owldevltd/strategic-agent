// Deterministic answers per role, for tests and for running without an inference key. A mission can bring
// its own answers (stub.json): per role one answer, a list used in turn, or a list of { when, answer } where
// the first entry whose text occurs in the input wins. Otherwise a plain template is used. Every answer is handed
// out as a copy: a caller that changes it changes neither the next answer nor the mission's data.

app.define( 'Core.Ai.StubProvider', [ 'Core.Ai.Provider' ], Provider => class StubProvider extends Provider {

	static NAME = 'stub';

	constructor( { answers = {}, log = null } = {} ) {
		super( { log } );
		this.answers = answers && typeof answers === 'object' ? answers : {};
		// Role names come from the catalog; a role named like a key of every object ("__proto__") counts like any other.
		this._calls = Object.create( null );
	}

	async _complete( { role, input, contract } ) {
		const _given = Object.hasOwn( this.answers, role ) ? this.answers[ role ] : undefined;
		if ( Array.isArray( _given ) && _given.some( entry => typeof entry?.when === 'string' ) ) {
			const _texts = StubProvider.texts( input );
			const _match = _given.find( entry => typeof entry?.when === 'string' && _texts.some( text => text.includes( entry.when ) ) );
			return _match ? structuredClone( _match.answer ) : StubProvider.template( input, contract );
		}
		if ( Array.isArray( _given ) ) {
			this._calls[ role ] = ( this._calls[ role ] || 0 ) + 1;
			return structuredClone( _given[ Math.min( this._calls[ role ], _given.length ) - 1 ] );
		}
		if ( _given ) {
			return structuredClone( _given );
		}
		return StubProvider.template( input, contract );
	}

	// Where a when-text is looked for: every text in the input as it is (a quote or a line break is no JSON escape there),
	// every key, and the input as JSON.
	static texts( input ) {
		const _texts = [];
		const _seen = new Set();
		const _walk = ( value ) => {
			if ( typeof value === 'string' ) {
				_texts.push( value );
			} else if ( value && typeof value === 'object' && !_seen.has( value ) ) {
				_seen.add( value );
				Object.entries( value ).forEach( ( [ key, item ] ) => {
					_texts.push( key );
					_walk( item );
				} );
			}
		};
		_walk( input );
		return [ ..._texts, StubProvider.json( input ) ];
	}

	static json( input ) {
		try {
			return JSON.stringify( input ) ?? '';
		} catch {
			return String( input );
		}
	}

	static template( input, contract ) {
		const _text = typeof input === 'string' ? input : StubProvider.json( input );
		return Object.fromEntries( Object.entries( contract.fields ).map( ( [ name, field ] ) => {
			const _values = { string: _text.slice( 0, 400 ), number: 0, list: [], records: [], enum: field.values?.[ 0 ] };
			return [ name, Object.hasOwn( _values, field.type ) ? _values[ field.type ] : undefined ];
		} ) );
	}

} );
