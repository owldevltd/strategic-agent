// Thin layer over node:sqlite. JSON columns are stored as text; callers decide which ones. What goes in comes back
// exactly or is refused before anything is written: NaN (SQLite would keep NULL) is refused; an integer beyond
// 2^53 comes back as a BigInt; a text with a lone surrogate, which UTF-8 cannot hold, is kept in an escaped form.

app.define( 'Lib.Db', [], () => class Db {

	// The first character of an escaped text: a noncharacter, so no text from outside starts with it by chance.
	static MARK = '\uFDD0';

	constructor( file ) {
		const { DatabaseSync } = app.lib( 'node:sqlite' );
		if ( file !== ':memory:' ) {
			app.lib( 'node:fs' ).mkdirSync( app.lib( 'node:path' ).dirname( file ), { recursive: true } );
		}
		this.raw = new DatabaseSync( file );
		this.raw.exec( 'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;' );
		this._depth = 0;
		this._after = [];
	}

	exec( sql ) {
		this.raw.exec( sql );
	}

	run( sql, params = {} ) {
		return this.raw.prepare( sql ).run( Db._params( params ) );
	}

	get( sql, params = {} ) {
		return Db._row( this._read( sql ).get( Db._params( params ) ) );
	}

	all( sql, params = {} ) {
		return this._read( sql ).all( Db._params( params ) ).map( Db._row );
	}

	// One write transaction. BEGIN IMMEDIATE takes the write lock up front, so a check and the booking that depends
	// on it cannot be split by another writer. Nested calls join the outer one (no savepoints): an inner failure that
	// the outer fn catches undoes nothing by itself, and only the outermost call commits or rolls back. fn must be
	// synchronous: the writes after an await would run outside the transaction, so a promise is refused.
	transaction( fn ) {
		if ( typeof fn !== 'function' ) {
			throw new TypeError( 'transaction() needs a function' );
		}
		// An async fn is refused before it runs; any other fn that returns a promise is refused and rolled back.
		if ( Object.prototype.toString.call( fn ) === '[object AsyncFunction]' ) {
			throw new TypeError( 'transaction() got an async fn: its writes after an await would run outside the transaction' );
		}
		if ( this._depth > 0 ) {
			return Db._synchronous( fn() );
		}
		this.raw.exec( 'BEGIN IMMEDIATE' );
		this._depth++;
		let _result;
		try {
			_result = Db._synchronous( fn() );
			this.raw.exec( 'COMMIT' );
		} catch ( error ) {
			this._after = [];
			this._rollback();
			throw error;
		} finally {
			this._depth--;
		}
		const _after = this._after;
		this._after = [];
		for ( const cb of _after ) {
			try {
				cb();
			} catch ( error ) {
				app.fail( error );
			}
		}
		return _result;
	}

	// cb runs once what was written so far is committed: at once outside a transaction, after the outermost COMMIT
	// inside one, and never when it rolls back (so nobody hears of a write that did not happen).
	afterCommit( cb ) {
		if ( this._depth > 0 ) {
			this._after.push( cb );
		} else {
			cb();
		}
	}

	// Closing twice is harmless.
	close() {
		if ( this.raw.isOpen ) {
			this.raw.close();
		}
	}

	// SQLite may have ended the transaction itself (RAISE( ROLLBACK ), some I/O errors); a second ROLLBACK would
	// replace the caller's error with "no transaction is active".
	_rollback() {
		if ( !this.raw.isOpen || !this.raw.isTransaction ) { return; }
		try {
			this.raw.exec( 'ROLLBACK' );
		} catch ( error ) {
			app.fail( error );
		}
	}

	_read( sql ) {
		const _statement = this.raw.prepare( sql );
		_statement.setReadBigInts( true );
		return _statement;
	}

	static _synchronous( result ) {
		if ( result !== null && ( typeof result === 'object' || typeof result === 'function' ) && typeof result.then === 'function' ) {
			// Its rejection still has to be heard, or it would end the process as unhandled.
			Promise.resolve( result ).catch( error => app.fail( error ) );
			throw new TypeError( 'transaction() got a promise: an async fn would write outside the transaction; pass a synchronous fn' );
		}
		return result;
	}

	// Named parameters as node:sqlite would bind them, with NaN refused and texts escaped where needed. What is not
	// an object goes on unchanged; node:sqlite refuses it.
	static _params( params ) {
		if ( !params || typeof params !== 'object' || Array.isArray( params ) ) { return params; }
		let _copy = null;
		for ( const key of Object.keys( params ) ) {
			const _value = params[ key ];
			if ( typeof _value === 'number' && Number.isNaN( _value ) ) {
				throw new TypeError( `Parameter ${key} is NaN, which SQLite would store as NULL` );
			}
			if ( typeof _value === 'string' && ( !_value.isWellFormed() || _value.startsWith( Db.MARK ) ) ) {
				_copy ??= { ...params };
				_copy[ key ] = `${Db.MARK}${JSON.stringify( _value )}`;
			}
		}
		return _copy || params;
	}

	// An integer a Number holds exactly is a Number, as before; any other stays a BigInt. An escaped text is
	// unescaped.
	static _row( row ) {
		if ( !row ) { return row; }
		for ( const key of Object.keys( row ) ) {
			const _value = row[ key ];
			if ( typeof _value === 'bigint' && BigInt( Number( _value ) ) === _value ) {
				row[ key ] = Number( _value );
			} else if ( typeof _value === 'string' && _value.startsWith( Db.MARK ) ) {
				row[ key ] = Db._unescape( _value );
			}
		}
		return row;
	}

	static _unescape( text ) {
		try {
			const _value = JSON.parse( text.slice( Db.MARK.length ) );
			return typeof _value === 'string' ? _value : text;
		} catch {
			return text;
		}
	}

} );
