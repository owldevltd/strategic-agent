// The gate's own SQLite file. The core never writes here; the gate keeps its ledger even while the core is down.

app.define( 'Gate.Store', [], () => class Store {

	constructor( db ) {
		this.db = db;
		this.db.exec( `
			CREATE TABLE IF NOT EXISTS contracts (
				hash TEXT PRIMARY KEY, id TEXT NOT NULL, parent TEXT, root TEXT NOT NULL, spec TEXT NOT NULL, rules TEXT NOT NULL,
				status TEXT NOT NULL, proposedAt TEXT NOT NULL, confirmedAt TEXT, confirmedBy TEXT
			);
			CREATE TABLE IF NOT EXISTS deliveries (
				id TEXT PRIMARY KEY, contract TEXT NOT NULL, root TEXT NOT NULL, node TEXT, action TEXT NOT NULL, target TEXT,
				params TEXT NOT NULL, labels TEXT NOT NULL, cohort TEXT, actionHash TEXT NOT NULL,
				status TEXT NOT NULL, withdrawn INTEGER NOT NULL DEFAULT 0, reasons TEXT, receipt TEXT, flags TEXT,
				expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL, lease TEXT, fence INTEGER, address TEXT
			);
			CREATE TABLE IF NOT EXISTS attempts (
				id INTEGER PRIMARY KEY AUTOINCREMENT, delivery TEXT NOT NULL, nr INTEGER NOT NULL,
				begunAt TEXT NOT NULL, result TEXT
			);
			CREATE TABLE IF NOT EXISTS approvals (
				id TEXT PRIMARY KEY, delivery TEXT NOT NULL, actionHash TEXT NOT NULL, status TEXT NOT NULL,
				summary TEXT NOT NULL, requestedAt TEXT NOT NULL, decidedAt TEXT, decidedBy TEXT, reason TEXT, expiresAt TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS releases (
				id INTEGER PRIMARY KEY AUTOINCREMENT, contract TEXT NOT NULL, root TEXT NOT NULL, delivery TEXT NOT NULL, cohort TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS master (
				kind TEXT NOT NULL, value TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '*', source TEXT NOT NULL DEFAULT 'operator',
				PRIMARY KEY ( kind, value, scope )
			);
		` );
		this._scopeMaster();
		// Older ledgers lack the lease columns and the resolved address; each one is added on its own, so a migration that
		// stopped half-way is completed on the next start instead of breaking every new booking.
		this.db.transaction( () => {
			const _have = new Set( this.db.all( 'PRAGMA table_info( deliveries )' ).map( column => column.name ) );
			for ( const [ name, type ] of [ [ 'lease', 'TEXT' ], [ 'fence', 'INTEGER' ], [ 'address', 'TEXT' ] ] ) {
				if ( !_have.has( name ) ) { this.db.exec( `ALTER TABLE deliveries ADD COLUMN ${name} ${type}` ); }
			}
		} );
	}

	// An older ledger keeps its master data without a scope: rebuilt once with every value for every mission ('*'), as
	// the operator had added it, so nothing it held is lost and nothing it did not hold is added.
	_scopeMaster() {
		const _have = new Set( this.db.all( 'PRAGMA table_info( master )' ).map( column => column.name ) );
		if ( _have.has( 'scope' ) ) { return; }
		this.db.transaction( () => {
			this.db.exec( `ALTER TABLE master RENAME TO master_unscoped;
				CREATE TABLE master (
					kind TEXT NOT NULL, value TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '*', source TEXT NOT NULL DEFAULT 'operator',
					PRIMARY KEY ( kind, value, scope )
				);
				INSERT INTO master ( kind, value ) SELECT kind, value FROM master_unscoped;
				DROP TABLE master_unscoped;` );
		} );
	}

	// Every lookup takes a text; anything else (undefined, an object, a number) names nothing and finds nothing.
	contract( hash ) {
		const _row = typeof hash === 'string' ? this.db.get( 'SELECT * FROM contracts WHERE hash = :hash', { hash } ) : null;
		return _row ? { ..._row, spec: JSON.parse( _row.spec ), rules: JSON.parse( _row.rules ) } : null;
	}

	// The goals with one status ('proposed': they wait for a person), in the order they came.
	withStatus( status ) {
		return typeof status === 'string'
			? this.db.all( 'SELECT hash FROM contracts WHERE status = :status ORDER BY proposedAt', { status } ).map( row => this.contract( row.hash ) ) : [];
	}

	delivery( id ) {
		const _row = typeof id === 'string' ? this.db.get( 'SELECT * FROM deliveries WHERE id = :id', { id } ) : null;
		return _row ? Store.parseDelivery( _row ) : null;
	}

	deliveries( contract ) {
		return typeof contract === 'string'
			? this.db.all( 'SELECT * FROM deliveries WHERE contract = :contract ORDER BY createdAt', { contract } ).map( Store.parseDelivery ) : [];
	}

	// A goal and every goal above it, up to its root.
	lineage( hash ) {
		const _line = [];
		let _goal = this.contract( hash );
		while ( _goal && _line.length < 64 && !_line.includes( _goal.hash ) ) {
			_line.push( _goal.hash );
			_goal = this.contract( _goal.parent );
		}
		return _line;
	}

	// Everything under one root goal: "exactly once", sums and earlier releases count across the whole tree, so a
	// child can never repeat what a sibling already did.
	treeDeliveries( root ) {
		return typeof root === 'string'
			? this.db.all( 'SELECT * FROM deliveries WHERE root = :root ORDER BY createdAt', { root } ).map( Store.parseDelivery ) : [];
	}

	releasedCohorts( root ) {
		return typeof root === 'string'
			? this.db.all( 'SELECT cohort FROM releases WHERE root = :root', { root } ).map( row => JSON.parse( row.cohort ) ) : [];
	}

	// Every delivery and every release at this gate, of every goal. What an item already had and which groups already
	// went out is known across goals: a second goal that pays an invoice again pays it twice, and two groups that differ
	// by one person tell that person apart, whichever goals sent them.
	allDeliveries() {
		return this.db.all( 'SELECT * FROM deliveries ORDER BY createdAt' ).map( Store.parseDelivery );
	}

	allReleasedCohorts() {
		return this.db.all( 'SELECT cohort FROM releases' ).map( row => JSON.parse( row.cohort ) );
	}

	// Matching is exact, on the value as text; a list, an object or null is no account, whatever it prints as. A value
	// counts for the goals of its mission kind (scope) and, when the operator gave it for all of them, for every goal ('*').
	isMaster( kind, value, scope = Store.ALL ) {
		const _value = Store.masterValue( value );
		return typeof kind === 'string' && _value !== null && Boolean( this.db.get(
			'SELECT 1 AS ok FROM master WHERE kind = :kind AND value = :value AND scope IN ( \'*\', :scope )',
			{ kind, value: _value, scope: Store.scope( scope ) } ) );
	}

	// 6.2, 18.5: the addresses on file for a contact reference, from the pairs "<ref> <address>" (kind contact), for the
	// goals of one mission kind. A reference is one word; anything else (a text with a blank, an address itself, no
	// text) names no contact.
	addresses( ref, scope = Store.ALL ) {
		if ( typeof ref !== 'string' || !/^\S{1,200}$/.test( ref ) ) { return []; }
		const _prefix = `${ref} `;
		const _rows = this.db.all( `SELECT DISTINCT value FROM master WHERE kind = 'contact' AND scope IN ( '*', :scope )
			AND substr( value, 1, :n ) = :prefix ORDER BY value`, { n: _prefix.length, prefix: _prefix, scope: Store.scope( scope ) } );
		return _rows.map( row => row.value.slice( _prefix.length ) ).filter( address => /^\S+$/.test( address ) );
	}

	// The operator's master data: a kind (a text) and a list of values, each a text or a number. Anything else is
	// refused as a whole, in one booking: a text is no list of characters, null is no account. scope: the mission kind
	// the values are for, '*' for every goal; source: 'file' for what a mission folder brings, 'operator' for what a
	// person added at the gate.
	addMaster( kind, values, { scope = Store.ALL, source = 'operator' } = {} ) {
		const _values = Store._checked( kind, values );
		this.db.transaction( () => {
			for ( const value of _values ) {
				this.db.run( 'INSERT OR IGNORE INTO master ( kind, value, scope, source ) VALUES ( :kind, :value, :scope, :source )',
					{ kind, value, scope: Store.scope( scope ), source } );
			}
		} );
	}

	// A person takes values back: from then on no goal of that scope may use them. → how many were on file.
	revokeMaster( kind, values, { scope = Store.ALL } = {} ) {
		const _values = Store._checked( kind, values );
		return this.db.transaction( () => _values.reduce( ( sum, value ) => sum + this.db.run(
			'DELETE FROM master WHERE kind = :kind AND value = :value AND scope = :scope', { kind, value, scope: Store.scope( scope ) } ).changes, 0 ) );
	}

	// What the mission folders bring replaces what they brought before, in one booking: a value a folder no longer
	// holds is revoked at the next start; what a person added at the gate stays. entries: [ { scope, kind, values } ].
	loadMaster( entries ) {
		const _entries = entries.map( item => ( { ...item, values: Store._checked( item.kind, item.values ) } ) );
		this.db.transaction( () => {
			this.db.run( 'DELETE FROM master WHERE source = \'file\'' );
			_entries.forEach( item => this.addMaster( item.kind, item.values, { scope: item.scope, source: 'file' } ) );
		} );
	}

	static _checked( kind, values ) {
		if ( typeof kind !== 'string' || !kind.trim() ) {
			throw new TypeError( 'master data needs its kind as a text' );
		}
		if ( !Array.isArray( values ) ) {
			throw new TypeError( 'master data comes as a list of values' );
		}
		const _values = values.map( Store.masterValue );
		if ( _values.includes( null ) ) {
			throw new TypeError( 'every master value must be a text or a number' );
		}
		return _values;
	}

	// Master data for every goal.
	static ALL = '*';

	// A scope is a mission kind as a non-empty text; anything else is '*', every goal.
	static scope( value ) {
		return typeof value === 'string' && value.trim() ? value.trim() : Store.ALL;
	}

	// A master value as text: a non-empty text as it is, a finite number as its decimal text; anything else is none.
	static masterValue( value ) {
		if ( typeof value === 'string' ) { return value === '' ? null : value; }
		return typeof value === 'number' && Number.isFinite( value ) ? String( value ) : null;
	}

	// One row of the ledger as the gate books it; the columns not given stay empty.
	book( row ) {
		this.db.run( `INSERT INTO deliveries ( id, contract, root, node, action, target, params, labels, cohort, actionHash, status, reasons,
			expiresAt, createdAt, flags, lease, fence, address ) VALUES ( :id, :contract, :root, :node, :action, :target, :params, :labels, :cohort,
			:actionHash, :status, :reasons, :expiresAt, :createdAt, :flags, :lease, :fence, :address )`,
		{ node: null, target: null, cohort: null, reasons: null, flags: null, lease: null, fence: null, address: null, ...row } );
	}

	setStatus( id, status ) {
		this.db.run( 'UPDATE deliveries SET status = :status WHERE id = :id', { id, status } );
	}

	approval( id, delivery = null ) {
		const _row = typeof id === 'string' ? this.db.get( 'SELECT * FROM approvals WHERE id = :id', { id } ) : null;
		return _row && ( delivery === null || _row.delivery === delivery ) ? _row : null;
	}

	// A person is asked: one pending approval, bound to the hash of exactly that action (F1).
	ask( row ) {
		this.db.run( `INSERT INTO approvals ( id, delivery, actionHash, status, summary, requestedAt, expiresAt )
			VALUES ( :id, :delivery, :actionHash, 'pending', :summary, :requestedAt, :expiresAt )`, row );
	}

	pendingApprovals() {
		return this.db.all( 'SELECT * FROM approvals WHERE status = \'pending\' ORDER BY requestedAt' ).map( row => ( { ...row, summary: JSON.parse( row.summary ) } ) );
	}

	// F3: approvals nobody decided before they expired end as expired, their actions as rejected, in one booking.
	// → the approvals that ended now.
	expireApprovals( at, reasons ) {
		const _late = this.db.all( 'SELECT id, delivery FROM approvals WHERE status = \'pending\' AND expiresAt < :at', { at } );
		this.db.transaction( () => {
			if ( !_late.length ) { return; }
			for ( const item of _late ) {
				this.db.run( 'UPDATE approvals SET status = \'expired\' WHERE id = :id AND status = \'pending\'', { id: item.id } );
				this.db.run( 'UPDATE deliveries SET status = \'rejected\', reasons = :reasons WHERE id = :id AND status = \'awaiting_approval\'', {
					id: item.delivery, reasons: JSON.stringify( reasons ),
				} );
			}
		} );
		return _late;
	}

	// O1: an action booked as waiting without the approval that belongs to it can never be decided; it ends refused.
	refuseOrphans( reasons ) {
		this.db.run( `UPDATE deliveries SET status = 'refused', reasons = :reasons WHERE status = 'awaiting_approval'
			AND NOT EXISTS ( SELECT 1 FROM approvals a WHERE a.delivery = deliveries.id AND a.status = 'pending' )`, { reasons: JSON.stringify( reasons ) } );
	}

	static parseDelivery( row ) {
		return {
			...row,
			params: JSON.parse( row.params ),
			labels: JSON.parse( row.labels ),
			cohort: row.cohort ? JSON.parse( row.cohort ) : null,
			reasons: row.reasons ? JSON.parse( row.reasons ) : [],
			receipt: row.receipt ? JSON.parse( row.receipt ) : null,
			flags: row.flags ? JSON.parse( row.flags ) : [],
			withdrawn: Boolean( row.withdrawn ),
		};
	}

} );
