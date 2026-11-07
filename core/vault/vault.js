// The vault: the data a mission works on, one writable copy per run. Sandboxes read it (mounted read-only);
// only trusted code of the core writes to it, e.g. the inbound process storing an answer it extracted. No model
// and no sandbox ever writes here.

app.define( 'Core.Vault.Vault', [ 'Lib.Hash' ], Hash => class Vault {

	// How long the copy of a finished run is kept when VAULT_RETENTION_DAYS says nothing.
	static RETENTION_DAYS = 30;

	// A fresh copy of the mission's data below storageDir (or a temporary folder). The mission id becomes part of a
	// folder name, so it must be a plain name: an id with path parts would put the vault somewhere else. Links in the
	// mission's data are copied as the files they point to, so a run never writes through them into the original.
	static prepare( mission, storageDir = null ) {
		const _fs = app.lib( 'node:fs' );
		const _path = app.lib( 'node:path' );
		if ( !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test( String( mission?.id ) ) ) {
			throw new Error( `the mission id ${JSON.stringify( mission?.id )} is no plain name; it cannot name a vault` );
		}
		const _base = storageDir ? _path.join( storageDir, 'vault' ) : app.lib( 'node:os' ).tmpdir();
		_fs.mkdirSync( _base, { recursive: true } );
		const _dir = _fs.mkdtempSync( _path.join( _base, `${mission.id}-` ) );
		if ( mission.dataDir && _fs.existsSync( mission.dataDir ) ) {
			_fs.cpSync( mission.dataDir, _dir, { recursive: true, dereference: true } );
		}
		return new Vault( _dir );
	}

	constructor( dir ) {
		this.dir = dir;
	}

	// Retention: the copies of finished runs below storageDir go after days without a change; a run that is still open
	// (keep: its folders) keeps its copy however old. Only the vault's own run folders are removed, never anything else
	// that lies there. → the folders removed.
	static prune( storageDir, { days, keep = [], now = Date.now() } = {} ) {
		const _fs = app.lib( 'node:fs' );
		const _path = app.lib( 'node:path' );
		const _base = storageDir ? _path.join( _path.resolve( storageDir ), 'vault' ) : null;
		if ( !_base || !_fs.existsSync( _base ) || !( Number.isFinite( days ) && days > 0 ) ) { return []; }
		const _keep = new Set( keep.filter( item => typeof item === 'string' ).map( item => _path.resolve( item ) ) );
		const _limit = now - days * 86400000;
		const _removed = [];
		for ( const entry of _fs.readdirSync( _base, { withFileTypes: true } ) ) {
			const _dir = _path.join( _base, entry.name );
			// A run's folder as prepare() makes it: "<mission>-" and six characters; a link is never followed.
			if ( !entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}-[A-Za-z0-9]{6}$/.test( entry.name ) || _keep.has( _dir ) ) { continue; }
			if ( _fs.statSync( _dir ).mtimeMs >= _limit ) { continue; }
			_fs.rmSync( _dir, { recursive: true, force: true } );
			_removed.push( _dir );
		}
		return _removed;
	}

	rows( file ) {
		const _file = this._file( file );
		if ( !app.lib( 'node:fs' ).existsSync( _file ) ) { return []; }
		const { names, lines } = Vault._table( app.lib( 'node:fs' ).readFileSync( _file, 'utf8' ) );
		// A cell beyond the header belongs to no column; it is not read under a made-up name.
		return lines.map( line => Object.fromEntries( line.split( ',' ).slice( 0, names.length ).map( ( value, i ) => [ names[ i ], value ] ) ) );
	}

	// Inserts the row, or replaces the row with the same key: of two answers from the same origin the younger
	// one counts (E5). The key is compared as the cell it becomes, so a key with a comma or a line break, or a long
	// one, finds its row again. A key that is no column, or a row without a value for it, could never be found again
	// and would add a row at every call: it is refused.
	upsert( file, key, row ) {
		const _file = this._file( file );
		const _fs = app.lib( 'node:fs' );
		const { head, names, lines } = Vault._table( _fs.readFileSync( _file, 'utf8' ) );
		if ( !names.length ) { throw new Error( `${file} has no header; nothing is written` ); }
		const _column = names.indexOf( key );
		if ( _column < 0 ) { throw new Error( `${key} is no column of ${file}` ); }
		const _key = Vault.cell( row?.[ key ] );
		if ( !_key.trim() ) { throw new Error( `the row has no value for its key ${key}` ); }
		const _line = names.map( name => Vault.cell( row[ name ] ) ).join( ',' );
		const _at = lines.findIndex( line => line.split( ',' )[ _column ] === _key );
		if ( _at >= 0 ) {
			lines[ _at ] = _line;
		} else {
			lines.push( _line );
		}
		_fs.writeFileSync( _file, `${[ head, ...lines ].join( '\n' )}\n` );
		return { replaced: _at >= 0 };
	}

	// The header (without a byte-order mark a spreadsheet export may start with) and the lines that are not blank.
	static _table( text ) {
		const [ _head = '', ...lines ] = text.replace( /^\uFEFF/, '' ).split( /\r?\n/ ).filter( Boolean );
		return { head: _head, names: _head ? _head.split( ',' ) : [], lines };
	}

	// Inside the vault by its name and by its real path: a link inside the vault never leads a reader or a writer out.
	_file( file ) {
		const _path = app.lib( 'node:path' );
		const _fs = app.lib( 'node:fs' );
		const _file = _path.resolve( this.dir, file );
		if ( !_file.startsWith( _path.resolve( this.dir ) + _path.sep ) ) {
			throw new Error( `${file} is outside the vault` );
		}
		// The real path of the file, or of the nearest folder above it that exists.
		let _existing = _file;
		while ( !_fs.existsSync( _existing ) && _path.dirname( _existing ) !== _existing ) { _existing = _path.dirname( _existing ); }
		const _root = _fs.realpathSync( this.dir );
		const _real = _fs.realpathSync( _existing );
		if ( _real !== _root && !_real.startsWith( _root + _path.sep ) ) {
			throw new Error( `${file} is outside the vault` );
		}
		return _file;
	}

	static cell( value ) {
		return String( value ?? '' ).replace( /[,\r\n]/g, ' ' ).slice( 0, 200 );
	}

	static id( prefix ) {
		return Hash.id( prefix );
	}

} );
