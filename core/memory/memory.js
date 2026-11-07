// Memory per node (chapter 9.2) and the lessons of the whole system (9.3). Three kinds of content with their own
// rules: the goal is the contract and changes only by ticket; the situation says where the node stands now and
// is replaced when it is outdated, every version kept so a change can be taken back; the history (events,
// measurements, lessons) is only ever added to. Writes happen only through these methods and are logged.
// Lessons pass the write gate G4 and are signed; reading them goes through G5 (ReadCheck). The signing key never
// reaches a model or a sandbox; a signature proves only that nothing was changed, not that it is true (9.1).

app.define( 'Core.Memory.Memory', [ 'Lib.Hash', 'Core.Check.WriteCheck' ], ( Hash, WriteCheck ) => class Memory {

	constructor( db, { key = null, log = null } = {} ) {
		this.db = db;
		this.log = log;
		this._key = key || app.lib( 'node:crypto' ).randomBytes( 32 ).toString( 'base64' );
		this.db.exec( `
			CREATE TABLE IF NOT EXISTS memory_situation (
				id INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
				active INTEGER NOT NULL, by TEXT NOT NULL, time TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS memory_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, time TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS diagnoses (
				id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, data TEXT NOT NULL, signature TEXT NOT NULL, status TEXT NOT NULL, time TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS lessons (
				id TEXT PRIMARY KEY, kind TEXT NOT NULL, strategy TEXT NOT NULL, data TEXT NOT NULL, signature TEXT NOT NULL,
				status TEXT NOT NULL, time TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS lesson_corrections (
				id INTEGER PRIMARY KEY AUTOINCREMENT, lesson TEXT NOT NULL, data TEXT NOT NULL, signature TEXT NOT NULL, status TEXT NOT NULL,
				time TEXT NOT NULL
			);
		` );
		if ( !this.db.all( 'PRAGMA table_info( lessons )' ).some( column => column.name === 'attempt' ) ) {
			this.db.exec( 'ALTER TABLE lessons ADD COLUMN attempt INTEGER' );
		}
	}

	// The key of a deployment: MEMORY_KEY, else a file next to the databases, created once. A key file that holds no
	// key (empty, or only blanks) gets one too: otherwise every start would sign with a new random key, and G5 would
	// quarantine everything signed before.
	static key( storageDir ) {
		if ( process.env.MEMORY_KEY ) { return process.env.MEMORY_KEY; }
		if ( !storageDir ) { return null; }
		const _fs = app.lib( 'node:fs' );
		const _file = app.lib( 'node:path' ).join( storageDir, 'memory.key' );
		if ( !_fs.existsSync( _file ) || !_fs.readFileSync( _file, 'utf8' ).trim() ) {
			_fs.mkdirSync( storageDir, { recursive: true } );
			_fs.writeFileSync( _file, app.lib( 'node:crypto' ).randomBytes( 32 ).toString( 'base64' ), { mode: 0o600 } );
			_fs.chmodSync( _file, 0o600 );
		}
		return _fs.readFileSync( _file, 'utf8' ).trim();
	}

	situation( node, key, value, by = 'system' ) {
		this.db.transaction( () => {
			this.db.run( 'UPDATE memory_situation SET active = 0 WHERE node = :node AND key = :key AND active = 1', { node: node.id, key } );
			this.db.run( `INSERT INTO memory_situation ( node, key, value, active, by, time ) VALUES ( :node, :key, :value, 1, :by, :at )`, {
				node: node.id, key, value: JSON.stringify( value ), by, at: new Date().toISOString(),
			} );
		} );
		node.emit( 'memory_written', { part: 'situation', key, value, by } );
	}

	// Takes the change that holds now back; the version before it holds again, and a second revert takes that one back
	// too. A version taken back is marked (active -1), so it never comes back by a later revert; the change and its
	// undoing both stay on record.
	revert( node, key ) {
		const _now = this.db.get( 'SELECT id FROM memory_situation WHERE node = :node AND key = :key AND active = 1 ORDER BY id DESC LIMIT 1', { node: node.id, key } );
		if ( !_now ) { return false; }
		const _before = this.db.get( `SELECT id FROM memory_situation WHERE node = :node AND key = :key AND active = 0 AND id < :id
			ORDER BY id DESC LIMIT 1`, { node: node.id, key, id: _now.id } );
		this.db.transaction( () => {
			this.db.run( 'UPDATE memory_situation SET active = -1 WHERE id = :id', { id: _now.id } );
			if ( _before ) { this.db.run( 'UPDATE memory_situation SET active = 1 WHERE id = :id', { id: _before.id } ); }
		} );
		node.emit( 'memory_reverted', { part: 'situation', key } );
		return true;
	}

	current( nodeId ) {
		const _rows = this.db.all( 'SELECT key, value FROM memory_situation WHERE node = :node AND active = 1 ORDER BY id', { node: nodeId } );
		return Object.fromEntries( _rows.map( row => [ row.key, JSON.parse( row.value ) ] ) );
	}

	record( node, kind, data ) {
		this.db.run( 'INSERT INTO memory_history ( node, kind, data, time ) VALUES ( :node, :kind, :data, :at )', {
			node: node.id, kind, data: JSON.stringify( data ), at: new Date().toISOString(),
		} );
		node.emit( 'memory_written', { part: 'history', kind } );
	}

	history( nodeId ) {
		return this.db.all( 'SELECT kind, data, time FROM memory_history WHERE node = :node ORDER BY id', { node: nodeId } )
			.map( row => ( { ...row, data: JSON.parse( row.data ) } ) );
	}

	// 5.6: which class of strategies a person chose for a wall; written in a fixed schema and signed, read through G5.
	// Every field is given, as text: a missing person or cause is no code (G4).
	learnDiagnosis( node, { kind, cause, class: strategyClass, by } = {} ) {
		const _entry = { kind, cause, class: strategyClass, by };
		const _codes = [ kind, cause, strategyClass ].every( value => typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/.test( value ) );
		const _plain = _codes && typeof by === 'string' && by.trim() !== '' && /^[A-Za-z0-9_.:@ -]{1,64}$/.test( by );
		if ( !_plain ) {
			node.emit( 'check', { gate: 'G4', ok: false, problems: [ 'a diagnosis carries only codes and ids' ] } );
			return false;
		}
		this.db.run( 'INSERT INTO diagnoses ( kind, data, signature, status, time ) VALUES ( :kind, :data, :signature, \'valid\', :at )', {
			kind, data: Hash.canonical( _entry ), signature: this.sign( _entry ), at: new Date().toISOString(),
		} );
		node.emit( 'diagnosis_learned', _entry );
		return true;
	}

	// G5 for diagnoses: a changed entry, or one moved by hand to another kind of task (the kind column is not signed;
	// the kind in the data is), goes into quarantine and is not used; a person is told when a board is at hand.
	diagnoses( kind, { board = null, node = null } = {} ) {
		const _out = [];
		const _quarantined = [];
		for ( const row of this.db.all( 'SELECT * FROM diagnoses WHERE kind = :kind AND status = \'valid\' ORDER BY id', { kind } ) ) {
			const _data = this.verify( row.data, row.signature ) ? JSON.parse( row.data ) : null;
			const _problem = !_data ? 'a diagnosis was changed outside the system'
				: _data.kind !== kind ? 'a diagnosis was moved to another kind of task outside the system' : null;
			if ( _problem ) {
				this.db.run( 'UPDATE diagnoses SET status = \'quarantined\' WHERE id = :id', { id: row.id } );
				_quarantined.push( { id: row.id, problem: _problem } );
				continue;
			}
			_out.push( _data );
		}
		if ( _quarantined.length ) {
			this.log?.append( 'lessons_quarantined', { gate: 'G5', lessons: _quarantined } );
		}
		if ( _quarantined.length && board && node ) {
			board.ask( node, {
				question: `${_quarantined.length} diagnosis(es) failed the read gate and were put into quarantine: ${_quarantined.map( item => item.problem ).join( '; ' )}.`,
				options: [ 'keep them in quarantine' ], recommendation: 'keep them in quarantine', minutes: 2, kind: 'check', reason: 'G5',
			} ).catch( app.fail );
		}
		return _out;
	}

	// Called only after G4 accepted the lesson.
	storeLesson( lesson ) {
		const _id = Hash.id( 'ls' );
		this.db.run( `INSERT INTO lessons ( id, kind, strategy, attempt, data, signature, status, time )
			VALUES ( :id, :kind, :strategy, :attempt, :data, :signature, 'valid', :at )`, {
			id: _id, kind: lesson.situation.task, strategy: lesson.strategy, attempt: lesson.attempt ?? null,
			data: Hash.canonical( lesson ), signature: this.sign( lesson ), at: new Date().toISOString(),
		} );
		return _id;
	}

	// 9.3: a lesson is never overwritten; a correction is kept as the change plus its reason, signed like the lesson.
	// Only what the journal itself observes later can change, never the strategy, the situation or the evidence, and
	// only to values G4 would store in a lesson (WriteCheck.change).
	correctLesson( attempt, change, reason ) {
		const _attempt = Memory.attempt( attempt );
		const _lesson = _attempt && this.db.get( 'SELECT id FROM lessons WHERE attempt = :attempt AND status = \'valid\'', { attempt: _attempt } );
		const _problems = WriteCheck.change( change );
		if ( _lesson && _problems.length ) {
			this.log?.append( 'correction_refused', { gate: WriteCheck.GATE, lesson: _lesson.id, problems: _problems } );
		}
		if ( !_lesson || _problems.length || typeof reason !== 'string' || !/^[a-z_]{1,32}$/.test( reason ) ) { return null; }
		const _entry = { lesson: _lesson.id, change, reason, at: new Date().toISOString() };
		this.db.run( 'INSERT INTO lesson_corrections ( lesson, data, signature, status, time ) VALUES ( :lesson, :data, :signature, \'valid\', :at )', {
			lesson: _lesson.id, data: Hash.canonical( _entry ), signature: this.sign( _entry ), at: _entry.at,
		} );
		this.log?.append( 'lesson_corrected', { lesson: _lesson.id, attempt: _attempt, change, reason } );
		return _entry;
	}

	corrections( lessonId ) {
		return this.db.all( 'SELECT * FROM lesson_corrections WHERE lesson = :lesson AND status = \'valid\' ORDER BY id', { lesson: lessonId } );
	}

	quarantineCorrection( id ) {
		this.db.run( 'UPDATE lesson_corrections SET status = \'quarantined\' WHERE id = :id', { id } );
	}

	hasLesson( attempt ) {
		const _attempt = Memory.attempt( attempt );
		return Boolean( _attempt && this.db.get( 'SELECT id FROM lessons WHERE attempt = :attempt', { attempt: _attempt } ) );
	}

	// An attempt id: a whole number, also given as its digits; anything else names no attempt.
	static attempt( value ) {
		const _number = typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test( value ) ? Number( value ) : value;
		return Number.isInteger( _number ) && _number > 0 ? _number : null;
	}

	// In the order they were stored (rowid breaks a tie of the same time).
	lessonRows( kind = null ) {
		return kind ? this.db.all( 'SELECT * FROM lessons WHERE kind = :kind ORDER BY time, rowid', { kind } )
			: this.db.all( 'SELECT * FROM lessons ORDER BY time, rowid' );
	}

	quarantine( id ) {
		this.db.run( 'UPDATE lessons SET status = \'quarantined\' WHERE id = :id', { id } );
	}

	sign( value ) {
		return app.lib( 'node:crypto' ).createHmac( 'sha256', this._key ).update( Hash.canonical( value ) ).digest( 'hex' );
	}

	// A signature is exactly what sign() writes, 64 lowercase hex digits; anything else (text appended, half a byte,
	// upper case) never verifies, even where decoding the hex would stop before it.
	verify( text, signature ) {
		if ( typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test( signature ) ) { return false; }
		let _value;
		try {
			_value = JSON.parse( text );
		} catch {
			return false;
		}
		const _expected = Buffer.from( this.sign( _value ), 'hex' );
		return app.lib( 'node:crypto' ).timingSafeEqual( Buffer.from( signature, 'hex' ), _expected );
	}

} );
