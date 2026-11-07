// Hashes over canonical JSON: the same content always gives the same hash, whatever the key order. Approval
// tokens and frozen contracts are bound to these hashes, so two different contents must never share one (F1).

app.define( 'Lib.Hash', [], () => class Hash {

	static MAX_DEPTH = 100;

	// JSON with the keys of every object sorted. Only plain JSON is hashed; whatever JSON would drop or change
	// without a word is refused with an error, so it can never share a hash with something else: NaN and ±Infinity
	// (JSON writes null), functions, symbols and BigInt, undefined or a hole in a list (JSON writes null), Map, Set
	// and other objects that are not plain (JSON writes {} or calls their toJSON), and nesting deeper than
	// MAX_DEPTH. A property set to undefined counts as absent, as in JSON. A Date is its ISO time.
	static canonical( value ) {
		return Hash._canonical( value, 0, new Set() );
	}

	// open: the lists and objects being written, to tell a cycle from a value that is merely used twice.
	static _canonical( value, depth, open ) {
		if ( value === null || typeof value === 'string' || typeof value === 'boolean' ) {
			return JSON.stringify( value );
		}
		if ( typeof value === 'number' ) {
			if ( !Number.isFinite( value ) ) {
				throw new TypeError( `${value} has no JSON form` );
			}
			return JSON.stringify( value );
		}
		if ( typeof value !== 'object' ) {
			throw new TypeError( `A ${typeof value} has no JSON form` );
		}
		if ( value instanceof Date ) {
			if ( Number.isNaN( value.getTime() ) ) {
				throw new TypeError( 'An invalid Date has no JSON form' );
			}
			return JSON.stringify( value.toISOString() );
		}
		if ( depth >= Hash.MAX_DEPTH ) {
			throw new RangeError( `Nested deeper than ${Hash.MAX_DEPTH} levels` );
		}
		if ( open.has( value ) ) {
			throw new TypeError( 'A value that contains itself has no JSON form' );
		}
		open.add( value );
		try {
			return Array.isArray( value ) ? Hash._list( value, depth, open ) : Hash._object( value, depth, open );
		} finally {
			open.delete( value );
		}
	}

	static _list( list, depth, open ) {
		const _items = [];
		for ( let i = 0; i < list.length; i++ ) {
			if ( list[ i ] === undefined ) {
				throw new TypeError( `Item ${i} of a list is undefined or missing; JSON would write null` );
			}
			_items.push( Hash._canonical( list[ i ], depth + 1, open ) );
		}
		return `[${_items.join( ',' )}]`;
	}

	static _object( object, depth, open ) {
		const _tag = Object.prototype.toString.call( object );
		if ( _tag !== '[object Object]' || typeof object.toJSON === 'function' ) {
			throw new TypeError( `${_tag.slice( 8, -1 )} is no plain object and has no JSON form of its own` );
		}
		const _parts = [];
		for ( const key of Object.keys( object ).sort() ) {
			const _value = object[ key ];
			if ( _value !== undefined ) {
				_parts.push( `${JSON.stringify( key )}:${Hash._canonical( _value, depth + 1, open )}` );
			}
		}
		return `{${_parts.join( ',' )}}`;
	}

	// A string is hashed as its own text (callers rely on it), anything else as its canonical JSON. A lone
	// surrogate, which UTF-8 cannot hold, is written as its three bytes (WTF-8): no valid UTF-8 text has those, so
	// "\uD800" and "\uFFFD" never share a hash.
	static sha256( value ) {
		const _text = typeof value === 'string' ? value : Hash.canonical( value );
		return app.lib( 'node:crypto' ).createHash( 'sha256' ).update( Hash._bytes( _text ) ).digest( 'hex' );
	}

	static _bytes( text ) {
		if ( text.isWellFormed() ) { return text; }
		const _parts = text.split( /([\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/ );
		return Buffer.concat( _parts.map( ( part, i ) => {
			if ( i % 2 === 0 ) { return Buffer.from( part, 'utf8' ); }
			const _unit = part.charCodeAt( 0 );
			return Buffer.from( [ 0xE0 | ( _unit >> 12 ), 0x80 | ( ( _unit >> 6 ) & 0x3F ), 0x80 | ( _unit & 0x3F ) ] );
		} ) );
	}

	// 64 random bits: ids of nodes, deliveries and approvals must not collide by chance.
	static id( prefix ) {
		return `${prefix}-${app.lib( 'node:crypto' ).randomBytes( 8 ).toString( 'hex' )}`;
	}

	static secret() {
		return app.lib( 'node:crypto' ).randomBytes( 24 ).toString( 'base64url' );
	}

} );
