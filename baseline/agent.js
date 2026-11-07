// The neighbour office, for the side-by-side comparison only: the same kind of model with all survey data in
// its context and a common leak filter (it strips respondent ids and e-mail addresses), but no labels, no
// rules and no gate. Whatever it answers goes straight out. It never talks to real services.

app.define( 'Baseline.Agent', [ 'Lib.Hash' ], Hash => class Agent {

	static FILTER = [ /\br\d{2}\b/g, /[\w.+-]+@[\w-]+\.[\w.]+/g ];

	constructor( { provider, mission, db, log } ) {
		Object.assign( this, { provider, mission, db, log } );
		this.db.exec( `CREATE TABLE IF NOT EXISTS baseline_outbox (
			id TEXT PRIMARY KEY, mission TEXT NOT NULL, target TEXT NOT NULL, body TEXT NOT NULL, payments TEXT NOT NULL, time TEXT NOT NULL
		)` );
	}

	async handle( message ) {
		const _answer = await this.provider.complete( {
			role: 'baseline',
			instructions: this.mission.baselineRole,
			input: { message: message.text, data: this._data() },
			contract: this._contract(),
		} );
		const _body = Agent.FILTER.reduce( ( text, pattern ) => text.replace( pattern, '[removed]' ), _answer.text );
		const _id = Hash.id( 'base' );
		const _payments = _answer.payments || [];
		this.db.run( `INSERT INTO baseline_outbox ( id, mission, target, body, payments, time )
			VALUES ( :id, :mission, :target, :body, :payments, :time )`, {
			id: _id,
			mission: this.mission.id,
			target: message.from,
			body: _body,
			payments: JSON.stringify( _payments ),
			time: new Date().toISOString(),
		} );
		this.log.append( 'baseline_sent', {
			mission: this.mission.id, message: message.id, target: message.from, body: _body, payments: _payments,
		}, { source: 'baseline' } );
		return { id: _id, body: _body, payments: _payments };
	}

	sent( mission ) {
		return this.db.all( 'SELECT * FROM baseline_outbox WHERE mission = :mission ORDER BY time', { mission } )
			.map( row => ( { ...row, payments: JSON.parse( row.payments ) } ) );
	}

	// An assistant that can pay reports the payments it made; the simulation books them, nothing real is paid.
	_contract() {
		const _fields = { text: { type: 'string' } };
		if ( this.mission.office?.counter?.kind === 'payments' ) {
			_fields.payments = { type: 'records', required: false, fields: { invoiceId: 'text', iban: 'text', amount: 'a number' } };
		}
		return { fields: _fields };
	}

	// Everything in the mission's data folder, as such an assistant would see it.
	_data() {
		const _fs = app.lib( 'node:fs' );
		const _path = app.lib( 'node:path' );
		if ( !this.mission.dataDir ) { return {}; }
		const _files = _fs.readdirSync( this.mission.dataDir, { recursive: true } ).filter( name => /\.(csv|txt)$/.test( name ) );
		return Object.fromEntries( _files.map( name => [ name, _fs.readFileSync( _path.join( this.mission.dataDir, name ), 'utf8' ) ] ) );
	}

} );
