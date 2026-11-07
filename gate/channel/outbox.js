// The simplest channel: delivers into a local outbox table and returns a receipt. It honours an idempotency
// key, so a repeated attempt for the same delivery never creates a second message (O2). Real channels (mail,
// bank) implement the same send() and replace this one per action in the gate configuration.

app.define( 'Gate.Channel.Outbox', [ 'Lib.Hash' ], Hash => class Outbox {

	static IDEMPOTENT = true;

	constructor( db ) {
		this.db = db;
		this.db.exec( `CREATE TABLE IF NOT EXISTS outbox (
			id TEXT PRIMARY KEY, idempotencyKey TEXT UNIQUE NOT NULL, action TEXT NOT NULL, target TEXT,
			params TEXT NOT NULL, time TEXT NOT NULL, address TEXT
		)` );
		// An older outbox lacks the address the gate resolved a reference to.
		if ( !this.db.all( 'PRAGMA table_info( outbox )' ).some( column => column.name === 'address' ) ) {
			this.db.exec( 'ALTER TABLE outbox ADD COLUMN address TEXT' );
		}
	}

	async send( delivery ) {
		const _existing = this.db.get( 'SELECT id, time FROM outbox WHERE idempotencyKey = :key', { key: delivery.id } );
		if ( _existing ) {
			return { ok: true, receipt: { id: _existing.id, time: _existing.time, repeated: true } };
		}
		const _id = Hash.id( 'msg' );
		const _time = new Date().toISOString();
		// A real channel sends to the address the gate resolved (delivery.address), else to the target as named.
		this.db.run( `INSERT INTO outbox ( id, idempotencyKey, action, target, address, params, time )
			VALUES ( :id, :key, :action, :target, :address, :params, :time )`, {
			id: _id, key: delivery.id, action: delivery.action, target: delivery.target || '', address: typeof delivery.address === 'string' ? delivery.address : null,
			params: JSON.stringify( delivery.params ), time: _time,
		} );
		return { ok: true, receipt: { id: _id, time: _time } };
	}

	// O4: what the world says about one operation, by its idempotency key (like a sent folder and a message id).
	async lookup( delivery ) {
		const _found = this.db.get( 'SELECT id, time FROM outbox WHERE idempotencyKey = :key', { key: delivery.id } );
		return _found ? { receipt: { id: _found.id, time: _found.time, reconciled: true } } : null;
	}

	// What one recipient got; a recipient that is no text (none at all, say) got nothing.
	messages( target ) {
		return typeof target === 'string'
			? this.db.all( 'SELECT * FROM outbox WHERE target = :target ORDER BY time', { target } ).map( row => ( { ...row, params: JSON.parse( row.params ) } ) )
			: [];
	}

} );
