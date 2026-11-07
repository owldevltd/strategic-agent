// Knowledge (9.1): documents of a mission, and the files of a repository the same way, because a larger application
// never fits into a context: an index with a summary per file, and the retrieval of the parts probably concerned.
// Knowledge is checked like everything else: the index is signed by the core, and every retrieval goes through the
// read gate G5, so a file changed outside the system since it was indexed, or an index entry changed by hand, is not
// handed on; it goes into quarantine and a person is told. What comes out is an excerpt labelled own, for the model
// step that needs it (22: "the excerpt the plan names"), with the labels the mission gives its knowledge (own unless it
// says otherwise). An index run signs only files it has not seen; an entry it signed before is never signed again by
// an index run, so a file changed in between, or an entry in quarantine, stays with a person until they release it.

app.define( 'Core.Knowledge.Index', [], () => class Index {

	static FILES = /\.(md|txt|js|mjs|py|json)$/;
	static EXCERPT = 600;
	// Names the system gives itself; none of them is a person who could release an entry.
	static RESERVED = [ 'system', 'deadline', 'agent' ];

	// sign / verify: the core's signature (Core.Memory.Memory); the key never leaves the core.
	constructor( db, { sign, verify, log = null } ) {
		Object.assign( this, { db, sign, verify, log } );
		this.db.exec( `CREATE TABLE IF NOT EXISTS knowledge (
			path TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, hash TEXT NOT NULL,
			signature TEXT NOT NULL, status TEXT NOT NULL, time TEXT NOT NULL, labels TEXT NOT NULL DEFAULT '["own"]'
		)` );
		if ( !this.db.all( 'PRAGMA table_info( knowledge )' ).some( column => column.name === 'labels' ) ) {
			this.db.exec( 'ALTER TABLE knowledge ADD COLUMN labels TEXT NOT NULL DEFAULT \'["own"]\'' );
		}
	}

	// Trusted code indexes a folder: one entry per new file with its summary, the hash of its content and its labels. A
	// known entry is read through G5 instead; what fails goes into quarantine. One file that cannot be read stops only
	// itself, never the others.
	index( dir, { scope, labels = [ 'own' ] } ) {
		const _fs = app.lib( 'node:fs' );
		if ( !_fs.existsSync( dir ) ) { return 0; }
		const _files = Index.files( dir );
		let _new = 0;
		for ( const name of _files ) {
			const _file = app.lib( 'node:path' ).join( dir, name );
			const _known = this.db.get( 'SELECT * FROM knowledge WHERE path = :path', { path: _file } );
			const _problem = _known?.status === 'valid' && this._read( _known ).problem;
			if ( _problem ) { this._quarantine( _known, _problem, {} ); }
			if ( _known ) { continue; }
			const _signed = this._sign( _file, { scope, labels } );
			if ( _signed.problem ) {
				this.log?.append( 'knowledge_unreadable', { scope, path: _file, problem: _signed.problem } );
				continue;
			}
			_new += 1;
		}
		this.log?.append( 'knowledge_indexed', { scope, files: _files.length, new: _new } );
		return _files.length;
	}

	// The knowledge files below a folder, relative to it. Links are never followed: one could bring a file from outside
	// the folder in as own knowledge (10.4), or lead round in a circle. Only plain files count, never a folder named
	// like one; a subfolder that cannot be listed is left out.
	static files( dir ) {
		const _fs = app.lib( 'node:fs' );
		const _path = app.lib( 'node:path' );
		const _out = [];
		const _walk = ( sub ) => {
			let _entries;
			try {
				_entries = _fs.readdirSync( _path.join( dir, sub ), { withFileTypes: true } );
			} catch {
				return;
			}
			for ( const entry of _entries ) {
				const _name = sub ? _path.join( sub, entry.name ) : entry.name;
				if ( entry.isDirectory() ) {
					_walk( _name );
				} else if ( entry.isFile() && Index.FILES.test( entry.name ) ) {
					_out.push( _name );
				}
			}
		};
		_walk( '' );
		return _out;
	}

	// A person releases an entry from quarantine: the file as it is now is signed again. Only a person releases, named
	// by a plain, non-blank name; the names the system uses for itself are no person (9.1).
	release( path, { by } = {} ) {
		const _row = this.db.get( 'SELECT * FROM knowledge WHERE path = :path', { path } );
		if ( !_row || !Index.person( by ) ) { return false; }
		if ( this._sign( path, { scope: _row.scope, labels: JSON.parse( _row.labels ) } ).problem ) { return false; }
		this.log?.append( 'knowledge_released', { path, by } );
		return true;
	}

	static person( by ) {
		return typeof by === 'string' && by.trim() !== '' && !Index.RESERVED.includes( by.trim().toLowerCase() );
	}

	// The hash is over the bytes as they are on disk, so every changed byte is noticed, also where it is no valid text.
	_sign( path, { scope, labels } ) {
		const { bytes, problem } = Index.bytes( path );
		if ( problem ) { return { problem }; }
		const _text = bytes.toString( 'utf8' );
		const _kind = /\.(js|mjs|py)$/.test( path ) ? 'code' : 'document';
		const _entry = {
			path, scope, kind: _kind, summary: Index.summary( _text ), hash: Index.hash( bytes ), labels: JSON.stringify( labels ),
		};
		this.db.run( `INSERT OR REPLACE INTO knowledge ( path, scope, kind, summary, hash, labels, signature, status, time )
			VALUES ( :path, :scope, :kind, :summary, :hash, :labels, :signature, 'valid', :at )`,
		{ ..._entry, signature: this.sign( _entry ), at: new Date().toISOString() } );
		return {};
	}

	// The bytes of a knowledge file, or why there are none. A link is never read through, whatever it points at.
	static bytes( path ) {
		const _fs = app.lib( 'node:fs' );
		try {
			if ( !_fs.lstatSync( path ).isFile() ) { return { problem: 'the entry is no plain file' }; }
			return { bytes: _fs.readFileSync( path ) };
		} catch ( error ) {
			return { problem: error.code === 'ENOENT' ? 'the file changed since it was indexed' : `the file cannot be read (${error.code || error.message})` };
		}
	}

	static hash( bytes ) {
		return app.lib( 'node:crypto' ).createHash( 'sha256' ).update( bytes ).digest( 'hex' );
	}

	// The first heading and sentence of a document, the leading comment of code.
	static summary( text ) {
		const _comment = text.match( /^(?:\s*(?:\/\/|#)[^\n]*\n)+/ )?.[ 0 ];
		const _source = _comment || text;
		return _source.replace( /^\s*(\/\/|#+)\s?/gm, '' ).replace( /\s+/g, ' ' ).trim().slice( 0, 240 );
	}

	// The entries most probably concerned, through G5. Without a scope nothing is handed on: knowledge belongs to one
	// mission. The excerpt comes from the very bytes G5 checked. → [ { path, kind, summary, excerpt, labels } ]
	find( query, { scope, limit = 2, board = null, node = null } = {} ) {
		if ( typeof scope !== 'string' || !scope ) { return []; }
		const _words = Index.words( query );
		const _rows = this.db.all( 'SELECT * FROM knowledge WHERE status = \'valid\' AND scope = :scope', { scope } );
		const _ranked = _rows.map( row => ( { row, score: Index.overlap( _words, `${row.path} ${row.summary}` ) } ) )
			.filter( item => item.score > 0 ).sort( ( a, b ) => b.score - a.score ).slice( 0, limit );
		const _found = [];
		for ( const { row } of _ranked ) {
			const { problem, bytes } = this._read( row );
			if ( problem ) {
				this._quarantine( row, problem, { board, node } );
				continue;
			}
			const _excerpt = Index.excerpt( bytes.toString( 'utf8' ), _words );
			_found.push( { path: app.lib( 'node:path' ).basename( row.path ), kind: row.kind, summary: row.summary, excerpt: _excerpt, labels: JSON.parse( row.labels ) } );
		}
		return _found;
	}

	// G5: the entry is the one the core signed, and the file is still what was indexed. → { problem } or { bytes }
	_read( row ) {
		const { path, scope, kind, summary, hash, labels } = row;
		if ( !this.verify( JSON.stringify( { path, scope, kind, summary, hash, labels } ), row.signature ) ) {
			return { problem: 'the index entry was changed outside the system' };
		}
		const _read = Index.bytes( path );
		if ( _read.problem ) { return _read; }
		return Index.hash( _read.bytes ) === hash ? _read : { problem: 'the file changed since it was indexed' };
	}

	_quarantine( row, problem, { board, node } ) {
		this.db.run( 'UPDATE knowledge SET status = \'quarantined\' WHERE path = :path', { path: row.path } );
		this.log?.append( 'knowledge_quarantined', { gate: 'G5', path: row.path, problem } );
		if ( board && node ) {
			board.ask( node, {
				question: `A knowledge file failed the read gate and was put into quarantine: ${app.lib( 'node:path' ).basename( row.path )} (${problem}).`,
				options: [ 'keep it in quarantine' ], recommendation: 'keep it in quarantine', minutes: 1, kind: 'check', reason: 'G5',
			} ).catch( app.fail );
		}
	}

	// The paragraphs that share the most words with the query, up to the size of an excerpt.
	static excerpt( text, words ) {
		const _parts = text.split( /\n\s*\n/ ).map( part => ( { part: part.trim(), score: Index.overlap( words, part ) } ) ).filter( item => item.part );
		const _best = [ ..._parts ].sort( ( a, b ) => b.score - a.score );
		let _out = '';
		for ( const { part } of _best ) {
			if ( _out.length + part.length > Index.EXCERPT ) { break; }
			_out += `${_out ? '\n\n' : ''}${part}`;
		}
		return _out || text.slice( 0, Index.EXCERPT );
	}

	static words( text ) {
		return new Set( String( text ).toLowerCase().match( /[\p{L}\p{N}]{3,}/gu ) || [] );
	}

	static overlap( words, text ) {
		const _other = Index.words( text );
		return [ ...words ].filter( word => _other.has( word ) ).length;
	}

} );
