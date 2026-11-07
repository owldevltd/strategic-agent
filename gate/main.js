// The gate process. Its own SQLite file, its own log, the only keys for the channels. Three kinds of caller, each with
// its own secret (Lib.Access): the core (GATE_CORE_TOKEN, header x-core-token) proposes goals, takes leases and submits
// actions; the operator (GATE_OPERATOR_PIN, header x-operator-pin, or the field "pin" of the JSON body) confirms goals,
// decides approvals, settles unclear actions and keeps the master data, which the core can never do; reading the
// ledger, the log and the outbox needs either one. The operator endpoints answer only JSON requests (a page of another
// origin cannot send one without asking first), and only the origins in GATE_UI_ORIGIN may ask. Without a secret its
// routes stay open: that is for development only; the deployment sets both.

app.define( 'Gate.Main', [ 'Lib.Config', 'Lib.Db', 'Lib.EventLog', 'Lib.Http', 'Lib.Access', 'Gate.Egress', 'Gate.Channels', 'Lib.Missions' ],
	( Config, Db, EventLog, Http, Access, Egress ) => class Main {

		// What a request may carry; the gate refuses more before it books anything (A8).
		static MAX_BODY = 7 * 1024 * 1024;
		// The core token is no pin a person types: long and random (deploy.sh makes one).
		static TOKEN_MIN = 24;

		constructor( config = Config.load() ) {
			this.config = config;
			const _path = app.lib( 'node:path' );
			this.db = new Db( _path.join( config.storageDir, 'gate.db' ) );
			this.log = new EventLog( this.db, 'gate' );
			this.operator = new Access( {
				secret: process.env.GATE_OPERATOR_PIN, name: 'GATE_OPERATOR_PIN', header: 'x-operator-pin', missing: 'operator pin required', log: this.log,
			} );
			this.core = new Access( {
				secret: process.env.GATE_CORE_TOKEN, name: 'GATE_CORE_TOKEN', header: 'x-core-token', missing: 'core token required',
				min: Main.TOKEN_MIN, log: this.log,
			} );
			this.channels = app.get( 'Gate.Channels' ).create( this.db );
			this.egress = new Egress( { db: this.db, log: this.log, channels: this.channels, bufferMinutes: config.gate.bufferMinutes,
				ledger: config.gate.ledger, proposals: config.proposals === true } );
			this.store = this.egress.store;
			this.outbox = this.channels.outbox;
			this.http = new Http( { cors: config.gate.origins, maxBody: Main.MAX_BODY } );
		}

		async start() {
			this._loadMaster();
			// The deployment's own channels (AGENCY_CHANNELS), before anything can be sent, a recovered operation included.
			// The actions an operator approved before, then the channels that may deliver them.
			this.egress.proposals.load();
			await app.get( 'Gate.Channels' ).load( this.channels, { db: this.db, actions: this.egress.rules.actions, log: this.log } );
			this._routes();
			const _port = await this.http.listen( this.config.gate.port, this.config.gate.host );
			// O1: what was open when the gate stopped is rebuilt from its ledger before anything new comes in.
			const _unclear = await this.egress.recover();
			this.log.append( 'gate_started', { port: _port, operatorPin: this.operator.on, coreToken: this.core.on, unclear: _unclear.length } );
			return _port;
		}

		stop() {
			return this.http.close();
		}

		// The gate's own copy of the master data (known accounts, recipients and the like), read from the operator's
		// mission folders (Lib.Missions) at start: the file mission.json names under "master" (master.json when it names
		// none), for the goals of that mission's kind only. What a folder no longer holds is revoked; the core can never
		// add to it.
		_loadMaster() {
			const _entries = [];
			for ( const { id, file, value } of app.get( 'Lib.Missions' ).files( 'mission.json' ) ) {
				const _file = Main.masterFile( file, value?.master );
				if ( !_file ) { continue; }
				const _data = JSON.parse( app.lib( 'node:fs' ).readFileSync( _file, 'utf8' ).replace( /^\uFEFF/, '' ) );
				const _scope = typeof value.kind === 'string' && value.kind ? value.kind : id;
				Object.entries( _data ).forEach( ( [ kind, values ] ) => _entries.push( { scope: _scope, kind, values } ) );
			}
			this.store.loadMaster( _entries );
			this.log.append( 'master_loaded', { values: _entries.reduce( ( sum, item ) => sum + item.values.length, 0 ) } );
		}

		// The master file of one mission: a plain file name next to its mission.json, never a path out of the folder; null
		// when the mission has none.
		static masterFile( missionFile, name = 'master.json' ) {
			const _path = app.lib( 'node:path' );
			if ( typeof name !== 'string' || !name || _path.basename( name ) !== name || name.startsWith( '.' ) ) {
				throw new Error( `${missionFile}: "master" names a file next to mission.json, not ${JSON.stringify( name )}` );
			}
			const _file = _path.join( _path.dirname( missionFile ), name );
			return app.lib( 'node:fs' ).existsSync( _file ) ? _file : null;
		}

		// → null when the request may pass, else [ status, body ]. With no secret set the routes are open (development);
		// with more than one, the request names the one it carries.
		static guard( req, body, accesses ) {
			const _on = accesses.filter( item => item.on );
			if ( !_on.length ) { return null; }
			const _carried = _on.find( item => item.given( req, body, item.header === 'x-operator-pin' ? 'pin' : null ) );
			if ( !_carried ) {
				return [ 403, { error: _on.map( item => item.missing ).join( ' or ' ) } ];
			}
			const _result = _carried.check( _carried.given( req, body, _carried.header === 'x-operator-pin' ? 'pin' : null ), Access.client( req ) );
			return _result === 'ok' ? null : _carried.refusal( _result );
		}

		_routes() {
			const _body = body => ( body && typeof body === 'object' && !Array.isArray( body ) ? body : {} );
			// Every route: a request larger than the gate takes is refused before anything is booked; a refusal the gate
			// decided (Rules.refusal) is the caller's error, answered 4xx with its reason, never as an error of the gate.
			const _answer = handler => async ( ctx ) => {
				if ( Main.size( ctx ) > Main.MAX_BODY ) {
					return Http.json( ctx.res, 413, { error: 'the request is too large for the gate' } );
				}
				try {
					return await handler( ctx );
				} catch ( error ) {
					if ( error?.refusal !== true || !( error.status >= 400 && error.status < 500 ) ) { throw error; }
					return Http.json( ctx.res, error.status, { error: error.message } );
				}
			};
			const _guarded = accesses => handler => _answer( ( ctx ) => {
				const _refused = Main.guard( ctx.req, ctx.body, accesses );
				return _refused ? Http.json( ctx.res, ..._refused ) : handler( ctx );
			} );
			const _core = _guarded( [ this.core ] );
			const _read = _guarded( [ this.operator, this.core ] );
			const _operator = _guarded( [ this.operator ] );
			const _person = handler => async ( ctx ) => {
				if ( !Main.json( ctx.req ) ) {
					return Http.json( ctx.res, 403, { error: 'the operator endpoints take JSON requests only' } );
				}
				return _operator( handler )( ctx );
			};
			const _by = body => ( typeof _body( body ).by === 'string' && _body( body ).by.trim() ? _body( body ).by : 'operator' );
			// Master data that is no kind and list of values is the caller's error.
			const _ok = ( res, fn ) => {
				try {
					return Http.json( res, 200, fn() );
				} catch ( error ) {
					if ( !( error instanceof TypeError ) ) { throw error; }
					return Http.json( res, 400, { error: error.message } );
				}
			};
			const _master = ( body, change ) => ( { kind: String( _body( body ).kind ), scope: _body( body ).scope ?? '*', ...change, by: _by( body ) } );
			this.http
				.route( 'POST', '/contracts', _core( ( { res, body } ) => Http.json( res, 200, this.egress.propose( _body( body ).spec, _body( body ).rules, _body( body ).hash ) ) ) )
				// The goals that wait for a person, as contract_proposed announced them, however long the log has grown.
				.route( 'GET', '/contracts', _read( ( { res, query } ) => Http.json( res, 200, this.store.withStatus( query.get( 'status' ) || 'proposed' ).map( Main.proposal ) ) ) )
				.route( 'GET', '/contracts/:hash', _read( ( { res, params } ) => Http.json( res, 200, this.store.contract( params.hash ) ) ) )
				.route( 'GET', '/contracts/:hash/deliveries', _read( ( { res, params } ) => Http.json( res, 200, this.store.deliveries( params.hash ) ) ) )
				.route( 'POST', '/contracts/:hash/withdraw', _core( ( { res, params } ) => Http.json( res, 200, this.egress.withdrawContract( params.hash ) ) ) )
				.route( 'POST', '/contracts/:hash/confirm', _person( ( { res, params, body } ) => Http.json( res, 200, this.egress.confirm( params.hash, _by( body ) ) ) ) )
				// The body as it came: what is no request is refused and booked by the gate itself (A8).
				.route( 'POST', '/deliveries', _core( async ( { res, body } ) => Http.json( res, 200, await this.egress.submit( body ) ) ) )
				.route( 'POST', '/leases', _core( ( { res, body } ) => Http.json( res, 200, this.egress.lease( _body( body ) ) ) ) )
				.route( 'POST', '/leases/:id/beat', _core( ( { res, params, body } ) => Http.json( res, 200, this.egress.leases.beat( params.id, _body( body ).fence ) ) ) )
				.route( 'POST', '/leases/:id/release', _core( ( { res, params, body } ) => Http.json( res, 200, this.egress.leases.release( params.id, _body( body ).fence ) ) ) )
				.route( 'POST', '/deliveries/:id/withdraw', _core( ( { res, params } ) => Http.json( res, 200, this.egress.withdraw( params.id ) ) ) )
				.route( 'POST', '/deliveries/:id/redeem', _core( async ( { res, params, body } ) => Http.json( res, 200, await this.egress.redeem( {
					..._body( body ), delivery: params.id,
				} ) ) ) )
				.route( 'GET', '/unclear', _read( ( { res } ) => Http.json( res, 200, this.egress.unclear() ) ) )
				// O5: a person who checked outside settles an unclear action as executed or not_sent, with a reason.
				.route( 'POST', '/unclear/:id', _person( ( { res, params, body } ) => Http.json( res, 200, this.egress.settle( params.id, {
					result: _body( body ).result, by: _by( body ), reason: _body( body ).reason,
				} ) ) ) )
				.route( 'GET', '/deliveries/:id', _read( ( { res, params } ) => Http.json( res, 200, this.store.delivery( params.id ) ) ) )
				.route( 'GET', '/approvals', _read( ( { res } ) => Http.json( res, 200, this.egress.pendingApprovals() ) ) )
				.route( 'POST', '/approvals/:id', _person( async ( { res, params, body } ) => Http.json( res, 200, await this.egress.decide(
					params.id, _body( body ).decision, _by( body ), { reason: _body( body ).reason, explicit: _body( body ).explicit },
				) ) ) )
				// The operator's own master data, for one mission kind (scope) or for every goal ('*', when none is named).
				.route( 'POST', '/master', _person( ( { res, body } ) => _ok( res, () => {
					this.store.addMaster( _body( body ).kind, _body( body ).values, { scope: _body( body ).scope } );
					this.log.append( 'master_added', _master( body, {} ) );
					return { ok: true };
				} ) ) )
				.route( 'POST', '/master/revoke', _person( ( { res, body } ) => _ok( res, () => {
					const _revoked = this.store.revokeMaster( _body( body ).kind, _body( body ).values, { scope: _body( body ).scope } );
					this.log.append( 'master_revoked', _master( body, { revoked: _revoked } ) );
					return { revoked: _revoked };
				} ) ) )
				// What the agent proposes and the operator decides (AGENCY_PROPOSALS): an action, a master-data value.
				.route( 'POST', '/proposals', _core( ( { res, body } ) => Http.json( res, 200, this.egress.proposals.submit( _body( body ) ) ) ) )
				.route( 'GET', '/proposals', _read( ( { res, query } ) => Http.json( res, 200, this.egress.proposals.list(
					query.get( 'status' ) || 'proposed', query.get( 'scope' ) ) ) ) )
				.route( 'GET', '/proposals/:id', _read( ( { res, params } ) => Http.json( res, 200, this.egress.proposals.get( params.id ) ) ) )
				.route( 'POST', '/proposals/:id', _person( ( { res, params, body } ) => Http.json( res, 200, this.egress.proposals.decide(
					params.id, _body( body ).decision, _by( body ), _body( body ).reason ) ) ) )
				.route( 'POST', '/proposals/:id/revoke', _person( ( { res, params, body } ) => Http.json( res, 200, this.egress.proposals.revoke(
					params.id, _by( body ), _body( body ).reason ) ) ) )
				.route( 'GET', '/actions/learned', _read( ( { res } ) => Http.json( res, 200, this.egress.proposals.learned() ) ) )
				.route( 'GET', '/outbox/:target', _read( ( { res, params } ) => Http.json( res, 200, this.outbox.messages( params.target ) ) ) )
				.route( 'GET', '/log', _read( ( { res, query } ) => Http.json( res, 200, this.log.since( Number( query.get( 'since' ) || 0 ) ) ) ) )
				.route( 'GET', '/events', _read( ( { req, res, query } ) => {
					const _stream = Http.events( req, res );
					this.log.since( this.log.start( query ) ).forEach( _stream.send );
					_stream.closed.then( this.log.subscribe( _stream.send ) );
				} ) );
		}

		// A goal that waits for a person, in the shape of its contract_proposed event.
		static proposal( contract ) {
			const { hash, spec, rules, parent, proposedAt } = contract;
			return { hash, id: spec.id, goal: spec.goal, understood: spec.understood || null, rules, parent, proposedAt };
		}

		static json( req ) {
			return String( req.headers[ 'content-type' ] || '' ).split( ';' )[ 0 ].trim().toLowerCase() === 'application/json';
		}

		// The size of a request: as announced, or else as read.
		static size( { req, body } ) {
			const _announced = Number( req.headers[ 'content-length' ] );
			return Number.isFinite( _announced ) ? _announced : Buffer.byteLength( JSON.stringify( body ) ?? '' );
		}

	} );
