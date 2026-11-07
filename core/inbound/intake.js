// "Something comes in" (chapter 8.1): every message from outside starts its own process, which asks "do we
// have something for this already?". It matches by the keys fixed before sending, in code; only if no key fits,
// by content through a model; and when that is ambiguous, a person decides. Either way only expectations the sender
// may answer at all are considered (the expectation says from whom, the directory in the vault who belongs where).
// What matches is read into the fields of its expectation (a derivation; a claim when a parser without a model reads
// the same fixed fields, B4), checked as a fact through G3, and only then stored by trusted code where the
// expectation says and handed to the waiting node. The waiting node never sees the text (G-8). What matches nothing
// is a new case. The identity of a sender stays in the vault: the core's log and every fact name a pseudonym.

app.define( 'Core.Inbound.Intake', [ 'Core.Check.FactCheck', 'Lib.Hash', 'Core.Inbound.Expectations', 'Core.Ticket.Board' ], ( FactCheck, Hash, Expectations, Board ) => class Intake {

	// Z2: a model's part has a time limit, like planning and judging.
	static MODEL_MINUTES = 3;
	// What a model reads of a message (22).
	static TEXT = 2000;
	// The types of an extraction as the step contract knows them; Intake.ranges checks the rest.
	static CONTRACT = { integer: 'number', number: 'number', enum: 'enum', string: 'string', date: 'string', id: 'string' };

	// directory: the file in the vault that says who belongs to which team, if the mission has one.
	constructor( { expectations, provider, board = null, vault = null, runner, log, directory = null } ) {
		Object.assign( this, { expectations, provider, board, vault, runner, log, directory } );
		// E2: the ids of the messages that arrived, kept in the core's store, so a replay after a restart is known too.
		this.expectations.db.exec( `CREATE TABLE IF NOT EXISTS inbound_seen (
			scope TEXT NOT NULL, id TEXT NOT NULL, time TEXT NOT NULL, PRIMARY KEY ( scope, id )
		)` );
	}

	async handle( message ) {
		const _refused = this._admit( message );
		if ( _refused ) { return _refused; }
		const _candidates = this.expectations.listening().filter( ( item ) => {
			const _node = this.runner.nodes.get( item.node );
			return _node && _node.state !== 'closed';
		} );
		const _match = await this._match( message, _candidates );
		if ( !_match ) {
			return this._newCase( message );
		}
		const _expectation = _match.expectation;
		const _node = this.runner.nodes.get( _expectation.node );
		const _read = await this._read( message, _expectation, _node );
		if ( !_read || _read.unreadable ) {
			// 7.2 (G3): a reading outside the expectation's schema is dropped, and a person is told, with the message (8.4).
			if ( _read?.unreadable ) { this._tell( message, _node, _read.unreadable, 'could not be read' ); }
			return { case: 'unreadable', expectation: _expectation.id };
		}
		const _fact = this._fact( message, _match, _read );
		// G3 comes first: what it drops is neither stored nor delivered.
		const _check = new FactCheck().check( _fact, { expectation: _expectation, contract: _node.contract.hash } );
		this.log.append( 'check', { ..._check, message: message.id, expectation: _expectation.id }, { node: _node.id } );
		if ( !_check.ok ) {
			return this._reject( message, _node, _check.problems, 'was dropped at G3' );
		}
		// Z5: the node closed while the message was read; the reply is a new case, and nothing is stored for it.
		if ( [ 'closed', 'dropped' ].includes( this.expectations.get( _expectation.id )?.status ) ) {
			return this._newCase( message );
		}
		try {
			this._store( message, _expectation, _read.fields );
		} catch ( error ) {
			return this._reject( message, _node, [ `the vault did not take it: ${error.message}` ], 'was not stored' );
		}
		const _recorded = this.expectations.record( _expectation.id, { origin: _fact.origin, fact: _fact.kind } );
		if ( !_recorded ) {
			return this._newCase( message );
		}
		this.runner.deliver( _node, { ..._fact, late: _recorded.late } );
		// 8.1: an answer that also asks for something else is, for that part, a new case of its own.
		const _also = Boolean( _read.alsoAsks );
		if ( _also ) { this.log.append( 'inbound_also_asks', { id: message.id, from: this._who( message ) }, { node: _node.id } ); }
		return { case: 'matched', by: _match.by, expectation: _expectation.id, node: _node.id, alsoAsks: _also, ..._recorded };
	}

	// E2: a message without an id, or one that arrived before (the same id, as a number or as text), is not processed;
	// → the answer for it, or null for a message to process. What arrives is logged with a pseudonym, never the name.
	_admit( message ) {
		const _mission = this.runner.mission.id;
		const _id = Intake.messageId( message?.id );
		if ( _id === null ) {
			this.log.append( 'inbound_refused', { reason: 'no message id (E2)', labels: [ 'foreign' ], mission: _mission } );
			return { case: 'refused', reason: 'a message without an id cannot be told apart from its replay (E2)' };
		}
		if ( !this._first( _id ) ) {
			this.log.append( 'inbound_duplicate', { id: message.id, mission: _mission } );
			return { case: 'duplicate' };
		}
		const _received = { id: message.id, from: this._who( message ), subject: message.subject || '', labels: [ 'foreign' ], mission: _mission };
		this.log.append( 'inbound_received', _received );
		return null;
	}

	// The fact for the waiting node. 8.3: it names where it came from (the inbound message, the place in it, the label),
	// whether a parser read the same, and how long it is valid. Only fixed fields the expectation names travel with
	// it, never text. B1: one person is one origin, however they write their name: a digest under a secret of the core.
	// An expectation of a series (each: a field, e.g. the minute of a report) takes one answer per sender and value of
	// that field, so a monitoring system that reports twice gives two answers, not one that replaces the other.
	_fact( message, { expectation, by }, read ) {
		const _spec = expectation.spec;
		const _each = _spec.each ? `:${String( read.fields[ _spec.each ] ?? '' )}` : '';
		const _origin = this._digest( `origin:${expectation.id}:${Intake.sender( message.from )}${_each}` ).slice( 0, 12 );
		const _carried = Object.fromEntries( ( _spec.carry || [] ).map( name => [ name, read.fields[ name ] ] ) );
		// E5: what the fact is about (a field the expectation names, else one sender's answer to one expectation), and its
		// value as a digest of the carried fields: two answers about the same thing that differ contradict each other.
		const _about = _spec.about ? read.fields[ _spec.about ] : `${expectation.id}:${_origin}`;
		const _data = { expectation: expectation.id, matchedBy: by, ..._carried, about: _about,
			value: Hash.sha256( JSON.stringify( _carried ) ).slice( 0, 16 ) };
		return {
			kind: expectation.fact, evidenceClass: read.evidenceClass, source: `inbound ${message.id}`, origin: _origin,
			contract: expectation.contract, data: _data, attempt: _spec.attempt ?? null,
			provenance: { inbound: message.id, place: read.place || null, label: 'foreign' }, parserMatch: read.parserMatch,
			validUntil: _spec.validHours ? new Date( Date.now() + _spec.validHours * 3600000 ).toISOString() : null,
		};
	}

	_newCase( message ) {
		this._lateSignal( message );
		this.log.append( 'inbound_new_case', { id: message.id, from: this._who( message ), mission: this.runner.mission.id } );
		return { case: 'new' };
	}

	// G3 (7.2) or the vault refused the fact: it is dropped, and a person is told why.
	_reject( message, node, problems, what ) {
		this.log.append( 'fact_rejected', { message: message.id, problems }, { node: node.id } );
		this._tell( message, node, problems, what );
		return { case: 'rejected', problems };
	}

	// A message that leaves no fact does not vanish (7.2: a dropped fact goes with a ticket): a person is told why, with the
	// message cut short (8.4), so a dispute or a claim of payment is seen even when no field could be read from it.
	_tell( message, node, problems, what ) {
		this.board?.ask( node, {
			question: `A fact from a message of ${this._who( message )} ${what}: ${problems.join( '; ' )}.`,
			options: [ 'noted' ], recommendation: 'noted', minutes: 1, kind: 'help', reason: `the fact ${what} (7.2)`,
			excerpt: Board.message( message ),
		} ).catch( app.fail );
	}

	// E2 → true when this message id was not seen before in this run (also across a restart, which keeps the run).
	_first( id ) {
		const _scope = `${this.runner.mission.id}/${this.runner.id ?? ''}`;
		return this.expectations.db.run( 'INSERT OR IGNORE INTO inbound_seen ( scope, id, time ) VALUES ( :scope, :id, :at )', {
			scope: _scope, id, at: new Date().toISOString(),
		} ).changes === 1;
	}

	// A message id is text or a number, the same either way; anything else is no id.
	static messageId( id ) {
		if ( typeof id === 'number' && Number.isFinite( id ) ) { return String( id ); }
		return typeof id === 'string' && id.trim() !== '' ? id.slice( 0, 500 ) : null;
	}

	// L2: the observation of an attempt runs until its horizon, also after its node closed. An answer to it (by key, in
	// code, from someone who may answer it) is still recorded as its signal; the message itself is a new case.
	_lateSignal( message ) {
		const _closed = this.expectations.closedByKey( Intake.text( message ) );
		if ( !_closed?.spec.attempt || !this._from( message, [ _closed ] ).length ) { return; }
		const _change = this.runner.journal.signal( _closed.spec.attempt );
		if ( _change ) { this.log.append( 'late_signal', { attempt: _closed.spec.attempt, ..._change }, { node: _closed.node } ); }
	}

	async _match( message, candidates ) {
		// A key says which expectation a message names, not that its sender may answer it: the directory check applies.
		const _keyed = candidates.filter( item => Expectations.keyed( item, Intake.text( message ) ) );
		const _byKey = this._from( message, _keyed );
		if ( _byKey.length < _keyed.length ) {
			const _refused = _keyed.filter( item => !_byKey.includes( item ) ).map( item => item.id );
			this.log.append( 'inbound_key_refused', { id: message.id, from: this._who( message ), expectations: _refused, mission: this.runner.mission.id } );
		}
		if ( _byKey.length === 1 ) {
			return { expectation: _byKey[ 0 ], by: 'key' };
		}
		if ( _byKey.length > 1 ) {
			return this._ask( message, _byKey );
		}
		// Without a key, only expectations the sender may answer at all are considered: the expectation says from whom
		// (8.1), and the company directory in the vault says who belongs where.
		candidates = this._from( message, candidates );
		if ( !candidates.length || !this.provider ) {
			return null;
		}
		// The model sees what each expectation is about, not internal ids; two with the same description go to a person.
		const _label = item => `${item.origin} ${item.fact}`;
		const _answer = await Intake.bounded( this.provider.complete( {
			role: 'correlator',
			instructions: 'A message came in. Decide which of the open expectations it answers, or none. Answer none when unsure.',
			input: {
				message: { from: message.from, subject: message.subject || '', text: Intake.cut( message.text ) },
				expectations: [ ...new Set( candidates.map( _label ) ) ],
			},
			contract: { fields: { expectation: { type: 'enum', values: [ 'none', ...new Set( candidates.map( _label ) ) ] } } },
		} ) ).catch( () => null );
		// An answer that is no object, or names no description as text, is "none".
		const _picked = _answer && typeof _answer === 'object' && typeof _answer.expectation === 'string' ? _answer.expectation : 'none';
		const _found = candidates.filter( item => _label( item ) === _picked );
		const _matched = { id: message.id, expectation: _found.length === 1 ? _found[ 0 ].id : null, candidates: _found.length };
		this.log.append( 'inbound_matched_by_model', { ..._matched, mission: this.runner.mission.id } );
		if ( _found.length > 1 ) {
			return this._ask( message, _found );
		}
		return _found.length ? { expectation: _found[ 0 ], by: 'model' } : null;
	}

	// The expectations this sender may answer: those that wait for the sender, or for the sender's team in the
	// directory. Without a directory nothing restricts; a directory that cannot be read lets only the sender's own
	// expectations through.
	_from( message, candidates ) {
		if ( !this.directory || !this.vault ) { return candidates; }
		let _rows = null;
		try {
			_rows = this.vault.rows( this.directory );
		} catch ( error ) {
			this.log.append( 'directory_unreadable', { file: this.directory, problem: error.message, mission: this.runner.mission.id } );
		}
		if ( _rows && !_rows.length ) { return candidates; }
		const _sender = Intake.sender( message.from );
		if ( !_sender ) { return []; }
		const _team = ( _rows || [] ).find( row => Intake.sender( row?.name ) === _sender )?.team;
		return candidates.filter( item => Intake.sender( item.origin ) === _sender || ( _team && item.origin === _team ) );
	}

	// More than one expectation fits: a person decides.
	async _ask( message, candidates ) {
		if ( !this.board ) { return null; }
		const _node = this.runner.nodes.get( candidates[ 0 ].node );
		const _answer = await this.board.ask( _node, {
			question: `A message from ${this._who( message )} fits more than one open expectation. Which one does it answer?`,
			options: [ ...candidates.map( item => item.id ), 'none' ], recommendation: 'none', minutes: 1,
		} );
		const _found = candidates.find( item => item.id === _answer.choice );
		return _found ? { expectation: _found, by: 'person' } : null;
	}

	// The model reads the fields; a parser without a model reads the same fields where it can; critical fields are read
	// a second time, independently (10.4). The reading becomes a claim only when the parser read every fixed field (a
	// number, a date, an id; a field may say otherwise) the same; otherwise it stays a derivation. Any difference goes to
	// a person; an answer that breaks the schema, or a critical field that could not be read twice, is unreadable (B4).
	async _read( message, expectation, node ) {
		const _extract = expectation.spec.extract || {};
		if ( !Object.keys( _extract ).length ) {
			return { fields: {}, evidenceClass: 'claim', parserMatch: 'none' };
		}
		const _first = await this._extract( message, _extract, node, 'first' );
		const _critical = Object.keys( _extract ).filter( name => _extract[ name ].critical );
		const _second = _critical.length && !_first.error ? await this._extract( message, _extract, node, 'second' ) : null;
		const _parsed = Intake.parse( message.text, expectation.spec.parser || {} );
		const _problems = _first.error ? [ _first.error ] : [
			...Intake.ranges( _first.fields, _extract ),
			...( _second?.error ? [ `the second reading of ${_critical.join( ', ' )} failed: ${_second.error}` ] : [] ),
		];
		const _differs = _problems.length ? [] : [
			...Object.entries( _parsed ).filter( ( [ name, value ] ) => !Intake.agree( value, _first.fields[ name ] ) )
				.map( ( [ name ] ) => `${name}: the parser read ${_parsed[ name ]}, the model ${Intake.shown( _first.fields[ name ] )}` ),
			..._critical.filter( name => _second.fields[ name ] !== _first.fields[ name ] )
				.map( name => `${name}: a second reading gave ${_second.fields[ name ]}, the first ${Intake.shown( _first.fields[ name ] )}` ),
		];
		if ( _problems.length || _differs.length ) {
			const _covered = Intake.covered( _extract, _parsed );
			const _read = { fields: _first.fields, parsed: _parsed, problems: _problems, differs: _differs, covered: _covered };
			const _decided = await this._dispute( message, node, _read );
			// A reading that breaks the schema is no question of which reading holds: nobody was asked, a person is told.
			if ( _problems.length ) { return { unreadable: _problems }; }
			// What the person chose is checked like any reading: a parser's value outside its field's type is no reading.
			if ( !_decided || Intake.ranges( _decided.fields, _extract ).length ) { return null; }
			return { ..._decided, alsoAsks: _first.alsoAsks };
		}
		const _class = Intake.covered( _extract, _parsed ) ? 'claim' : 'derivation';
		const _match = !Object.keys( _parsed ).length ? 'none' : _class === 'claim' ? 'equal' : 'partial';
		this.log.append( 'inbound_read', { message: message.id, fields: Object.keys( _first.fields ), evidenceClass: _class }, { node: node.id } );
		return { fields: _first.fields, evidenceClass: _class, parserMatch: _match, place: _first.place, alsoAsks: _first.alsoAsks };
	}

	// Two readings of a field agree when they are the same value; text also when only its letter case differs (the
	// parser reads text in lower case, a model writes an IBAN or an id as the message does).
	static agree( parsed, read ) {
		if ( typeof parsed === 'string' && typeof read === 'string' ) { return parsed.trim().toLowerCase() === read.trim().toLowerCase(); }
		return parsed === read;
	}

	// A read value as a ticket names it: short, and "nothing" when there was none.
	static shown( value ) {
		return value === undefined || value === null || value === '' ? 'nothing' : String( value ).slice( 0, 60 );
	}

	// B4: the fixed fields of an extraction (a number, a date, an id, unless the field says fixed: false), and whether a
	// parser read every one of them.
	static covered( extract, parsed ) {
		const _fixed = Object.keys( extract ).filter( name => extract[ name ].fixed ?? [ 'integer', 'number', 'date', 'id' ].includes( extract[ name ].type ) );
		return _fixed.length > 0 && _fixed.every( name => name in parsed );
	}

	// One reading by the extractor, within Z2. Only the fields of the expectation are kept; the place is a paragraph
	// number or nothing.
	async _extract( message, extract, node, round ) {
		const _contract = { fields: {
			...Object.fromEntries( Object.entries( extract ).map( ( [ name, field ] ) => [ name, {
				type: Intake.CONTRACT[ field.type ] || field.type, values: field.values, required: field.required,
			} ] ) ),
			paragraph: { type: 'number', required: false },
			alsoAsks: { type: 'enum', values: [ 'yes', 'no' ], required: false },
		} };
		const _fields = Object.entries( extract ).map( ( [ name, field ] ) => `${name}: ${field.describe || ''}` ).join( ' ' );
		try {
			const _answer = await Intake.bounded( this.provider.complete( {
				role: 'extractor',
				instructions: `Read the answer into the fields. ${_fields} paragraph: the number of the paragraph you read them from. alsoAsks: yes if the message also asks for something else.${round === 'second' ? ' Read it on your own, from the start.' : ''}`,
				input: { text: Intake.cut( message.text ) },
				contract: _contract,
				node: node.id,
			} ) );
			if ( !_answer || typeof _answer !== 'object' || Array.isArray( _answer ) ) { return { fields: {}, error: 'the reading is no object' }; }
			const _named = Object.keys( extract ).filter( name => Object.hasOwn( _answer, name ) );
			const _read = Object.fromEntries( _named.map( name => [ name, _answer[ name ] ] ) );
			const _paragraph = Number.isInteger( _answer.paragraph ) && _answer.paragraph > 0 ? _answer.paragraph : null;
			return { fields: _read, place: _paragraph ? { paragraph: _paragraph } : null, alsoAsks: _answer.alsoAsks === 'yes' };
		} catch ( error ) {
			return { fields: {}, error: error.message };
		}
	}

	async _dispute( message, node, { fields, parsed, problems, differs, covered } ) {
		this.log.append( 'reading_disputed', { message: message.id, problems, differs }, { node: node.id } );
		if ( !this.board || problems.length ) {
			return null;
		}
		// B4: a person decides, and 8.4: with the message itself, so they can read which reading holds.
		const _answer = await this.board.ask( node, {
			question: `Two readings of a message from ${this._who( message )} differ: ${differs.join( '; ' )}. Which one holds?`,
			options: [ 'the parser', 'the model', 'neither, discard it' ], recommendation: 'the parser', minutes: 2,
			kind: 'question', reason: 'two readings differ (B4)', excerpt: Board.message( message ),
		} );
		if ( _answer.choice === 'the parser' ) {
			return { fields: { ...fields, ...parsed }, evidenceClass: covered ? 'claim' : 'derivation', parserMatch: 'decided', place: null };
		}
		if ( _answer.choice === 'the model' ) {
			return { fields, evidenceClass: 'derivation', parserMatch: 'decided', place: null };
		}
		return null;
	}

	// Trusted code writes what the expectation says where it says; the identity of the sender stays in the vault. A
	// known sender (by name, in any letter case) keeps their id and name; an unknown one gets a pseudonym under a
	// secret of the core, never a plain digest of the name.
	_store( message, expectation, fields ) {
		const _store = expectation.spec.store;
		if ( !_store || !this.vault ) { return; }
		const _identity = _store.identity;
		const _sender = Intake.sender( message.from );
		const _same = row => Intake.sender( row[ _identity.by ] ) === _sender;
		const _known = _identity && _sender ? this.vault.rows( _identity.file ).find( _same ) : null;
		const _id = _known?.[ _identity.id ] || `${_identity?.prefix || 'x'}-${this._digest( `vault:${_sender}` ).slice( 0, 6 )}`;
		const _values = { ...fields, from: _known?.[ _identity.by ] ?? message.from, team: expectation.origin, id: _id };
		for ( const target of _store.rows || [] ) {
			const _row = Object.fromEntries( Object.entries( target.row ).map( ( [ column, template ] ) => [ column,
				String( template ).replace( /\{\{(\w+)\}\}/g, ( _all, name ) => ( Object.hasOwn( _values, name ) ? _values[ name ] ?? '' : '' ) ) ] ) );
			this.vault.upsert( target.file, target.key, _row );
		}
	}

	// Every field in its type (B4): a whole number in its range, a number, one of its values, a date, an id, a text. A
	// field that may be missing (required: false) may be missing.
	static ranges( fields, extract ) {
		return Object.entries( extract ).flatMap( ( [ name, field ] ) => {
			const _value = fields[ name ];
			if ( ( _value === undefined || _value === null ) && field.required === false ) { return []; }
			const _within = value => value >= ( field.min ?? -Infinity ) && value <= ( field.max ?? Infinity );
			const _ok = {
				integer: () => Number.isInteger( _value ) && _within( _value ),
				number: () => Number.isFinite( _value ) && _within( _value ),
				enum: () => ( field.values || [] ).includes( _value ),
				date: () => typeof _value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test( _value ) && Intake.day( _value ),
				id: () => typeof _value === 'string' && FactCheck.ID.test( _value ),
				string: () => typeof _value === 'string' && _value.length <= Intake.TEXT,
			}[ field.type ];
			if ( !_ok ) { return [ `${name} has a type no reading knows` ]; }
			if ( _ok() ) { return []; }
			return [ [ 'integer', 'number' ].includes( field.type ) ? `${name} out of range` : `${name} is no valid ${field.type}` ];
		} );
	}

	// A calendar day that exists (no 30 February).
	static day( text ) {
		const _time = Date.parse( `${text}T00:00:00Z` );
		return !Number.isNaN( _time ) && new Date( _time ).toISOString().startsWith( text );
	}

	static parse( text, parser ) {
		const _out = {};
		for ( const [ name, pattern ] of Object.entries( parser ) ) {
			const _match = String( text ).match( new RegExp( pattern, 'i' ) );
			if ( _match ) {
				_out[ name ] = /^\d+$/.test( _match[ 1 ] ) ? Number( _match[ 1 ] ) : _match[ 1 ].toLowerCase();
			}
		}
		return _out;
	}

	// Where a key may be: the subject, the reply address, the text.
	static text( message ) {
		return [ message.subject, message.to, message.text ].filter( Boolean ).join( '\n' );
	}

	static cut( text ) {
		return String( text ).slice( 0, Intake.TEXT );
	}

	// One person, however the name is written: the sender as plain lower-case text.
	static sender( from ) {
		return typeof from === 'string' || typeof from === 'number' ? String( from ).normalize( 'NFKC' ).trim().toLowerCase() : '';
	}

	// Who sent it, as the core's log and the tickets name them: a role of the mission's own messages (ceo, supplier) by
	// its name, since a role is no identity of a respondent; everyone else by a pseudonym.
	// A sender the mission's own master data names (a recipient such as hr or ceo, a sender such as supplier) is a
	// role and is logged as it is; anyone else is a person and is logged under a pseudonym, never by name or address.
	_who( message ) {
		const _sender = Intake.sender( message.from );
		const _roles = Object.values( this.runner.mission.masterData || {} ).filter( Array.isArray ).flat();
		const _role = _sender && _roles.find( value => typeof value === 'string' && Intake.sender( value ) === _sender );
		return _role || `p-${this._digest( `who:${_sender}` ).slice( 0, 12 )}`;
	}

	// A keyed digest: the secret is derived from the memory key when the core has one (stable across restarts), else
	// it is a secret of this process.
	_digest( text ) {
		this._salt = this._salt || this.runner.memory?.sign?.( { purpose: 'inbound pseudonyms' } ) || Hash.secret();
		return app.lib( 'node:crypto' ).createHmac( 'sha256', this._salt ).update( text ).digest( 'hex' );
	}

	static bounded( promise, ms = Intake.MODEL_MINUTES * 60000 ) {
		let _timer;
		const _late = new Promise( ( _resolve, reject ) => {
			_timer = setTimeout( () => reject( new Error( `no answer of the model within ${ms / 60000} minutes (Z2)` ) ), ms );
			_timer.unref?.();
		} );
		return Promise.race( [ promise, _late ] ).finally( () => clearTimeout( _timer ) );
	}

} );
