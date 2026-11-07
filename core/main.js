// The core process: thinks, plans and checks, and talks to the world only through the gate. It serves the
// control room (ui/) and streams its event log over SSE. What a person does here (give a task, answer a question, abort)
// and what the board shows needs the board pin (CORE_BOARD_PIN, header x-board-pin); messages from outside come in
// with the inbound token (INBOUND_TOKEN, header x-inbound-token). Without a board pin the board is open, for
// development and an open demo on simulated data only; without an inbound token nothing comes in from outside.
// The demo's extras (the neighbour office without a gate, its counters, the canned messages, the escape test) exist
// only with AGENCY_DEMO=1.

app.define( 'Core.Main', [
	'Lib.Config', 'Lib.Db', 'Lib.EventLog', 'Lib.Http', 'Core.System', 'Core.Mission.Mission', 'Lib.Limits', 'Core.Sandbox.Probes', 'Lib.Access',
], ( ...deps ) => {
	const [ Config, Db, EventLog, Http, System, Mission, Limits, Probes, Access ] = deps;
	return class Main {

		constructor( config = Config.load() ) {
			this.config = config;
			this.db = new Db( app.lib( 'node:path' ).join( config.storageDir, 'core.db' ) );
			this.log = new EventLog( this.db, 'core' );
			this.http = new Http();
			// A public demo (PUBLIC_DEMO=1) limits what one visitor can start: every run costs model calls.
			this.demo = process.env.PUBLIC_DEMO === '1';
			this.streams = new Map();
			this.limits = {
				calls: new Limits( { perCaller: 40, total: 600 } ),
				starts: new Limits( { perCaller: 4, total: 30, windowMs: 3600000 } ),
			};
			this.board = new Access( {
				secret: process.env.CORE_BOARD_PIN, name: 'CORE_BOARD_PIN', header: 'x-board-pin', missing: 'board pin required', log: this.log,
			} );
			this.inbound = new Access( {
				secret: process.env.INBOUND_TOKEN, name: 'INBOUND_TOKEN', header: 'x-inbound-token', missing: 'inbound token required',
				min: Main.TOKEN_MIN, log: this.log,
			} );
		}

		// A token a program sends (the inbound channel) is no pin a person types: long and random.
		static TOKEN_MIN = 24;
		// One message from outside: its id, sender and text as texts, at most this long.
		static MESSAGE_MAX = 64 * 1024;

		// The board refuses an answer for a reason of the caller's: the ticket is not open (answered, expired or unknown),
		// or the choice and the name are not what it asked for.
		// Live logs one caller of the public demo may keep open at once.
		static STREAMS = 6;

		static TICKET_REFUSALS = [
			[ /^no open ticket /, 404 ], [ /^the ticket \S+ expired at /, 410 ],
			[ / is not one of the options$/, 400 ], [ /^an answer is a confirmation by a person/, 400 ],
		];

		// → null when the request may go ahead, else the reason it may not.
		_limited( req, kind = 'calls' ) {
			if ( !this.demo ) { return null; }
			return this.limits[ kind ].take( Limits.caller( req ) ) ? null : 'too many requests; this is a public demo, please wait a few minutes';
		}

		async start() {
			this.system = await System.create( { config: this.config, db: this.db, log: this.log } );
			// 7.1: code the model wrote never runs on the open internet without an isolated sandbox.
			if ( this.demo && !this.system.describe().isolated ) {
				throw new Error( 'PUBLIC_DEMO=1 needs an isolated sandbox runtime (SANDBOX_RUNTIME=docker)' );
			}
			this._routes();
			// Overdue work first (Δw): goals that were open when the core stopped continue from the log.
			this.system.resume().catch( app.fail );
			const _port = await this.http.listen( this.config.core.port, this.config.core.host );
			this.log.append( 'core_started', {
				port: _port, ...this.system.describe(), boardPin: this.board.on, inbound: this.inbound.on,
				demo: Boolean( this.config.demo ),
			} );
			return _port;
		}

		stop() {
			return this.http.close();
		}

		// 7.1: the escape test of the office. Attacker code runs in the sandbox of the agent's code, one probe after the
		// other, each result an event in the log. One test at a time, and only in an isolated sandbox.
		probe( mission ) {
			const _runtime = this.system.runtime.constructor;
			const _probes = new Probes( new _runtime( { timeoutSeconds: 5, image: this.config.sandbox.image } ) );
			if ( !_probes.isolated ) {
				return [ 409, { error: 'this sandbox is not isolated (development); the escape test runs only in an isolated sandbox' } ];
			}
			if ( this._probing ) { return [ 409, { error: 'an escape test is running' } ]; }
			this._probing = true;
			const _engine = process.env.SANDBOX_DOCKER_RUNTIME || null;
			this.log.append( 'sandbox_probes_started', { mission, runtime: _runtime.NAME, engine: _engine, of: Probes.LIST.length } );
			_probes.run( { each: result => this.log.append( 'sandbox_probe', { mission, ...result } ) } )
				.then( done => this.log.append( 'sandbox_probes_ended', { mission, stopped: done.stopped, of: done.of } ) )
				.catch( app.fail ).finally( () => { this._probing = false; } );
			return [ 202, { started: true } ];
		}

		// 18: a mistake of the caller is a 4xx with what was wrong; anything else is a plain 500. No message from below the
		// API (a path, a stack, a database error) reaches a visitor; the operator finds the error in the core's output.
		_safe( handler ) {
			return async ( context ) => {
				try {
					await handler( { ...context, body: Main.body( context.body ) } );
				} catch ( error ) {
					const _status = Number.isInteger( error?.status ) && error.status >= 400 && error.status < 500 ? error.status : 500;
					if ( _status === 500 ) { app.fail( error ); }
					if ( context.res.headersSent ) { return context.res.end(); }
					Http.json( context.res, _status, { error: _status === 500 ? 'the core could not do this; its log says why' : error.message } );
				}
			};
		}

		// A body is one JSON object; anything else (null, a list, a number) counts as an empty one.
		static body( body ) {
			return body && typeof body === 'object' && !Array.isArray( body ) ? body : {};
		}

		_answer( id, { choice, by } ) {
			return this.system.board().then( ( board ) => {
				try {
					return board.answer( id, { choice, by } );
				} catch ( error ) {
					const _known = Main.TICKET_REFUSALS.find( ( [ pattern ] ) => pattern.test( String( error?.message ) ) );
					throw _known ? Object.assign( error, { status: _known[ 1 ] } ) : error;
				}
			} );
		}

		// → null when the request may pass, else [ status, body ]: the board pin, when one is set.
		_boardRefusal( req ) {
			const _result = this.board.check( this.board.given( req ) );
			return _result === 'ok' ? null : this.board.refusal( _result );
		}

		// A route of the board: the pin first, then the limits of a public demo (kind: which one, or none).
		_person( handler, kind = null ) {
			return this._safe( async ( ctx ) => {
				const _refused = this._boardRefusal( ctx.req );
				if ( _refused ) { return Http.json( ctx.res, ..._refused ); }
				const _limited = kind && this._limited( ctx.req, kind );
				if ( _limited ) { return Http.json( ctx.res, 429, { error: _limited } ); }
				return handler( ctx );
			} );
		}

		_routes() {
			const _path = app.lib( 'node:path' );
			const _demo = Boolean( this.config.demo );
			this.http
				.serve( '/ui/', _path.join( app.root, 'ui' ) )
				.serve( '/lib/', _path.join( app.root, 'lib' ) )
				.route( 'GET', '/', ( { res } ) => {
					res.writeHead( 302, { Location: _demo ? '/ui/office/' : '/ui/' } );
					res.end();
				} )
			// What a page needs before it asks for anything: where the gate is, and whether it needs the board pin.
				.route( 'GET', '/api/config', ( { res } ) => Http.json( res, 200, {
					gateUrl: process.env.GATE_PUBLIC_URL || this.config.gate.url, ...this.system.describe(),
					demo: _demo, boardPin: this.board.on,
				} ) )
			// For the operator and infra/smoke.sh: which sandbox and model are in use, and whether the gate answers.
				.route( 'GET', '/api/health', async ( { res } ) => {
					const _gate = await this.system.gate.contract( 'health' ).then( () => true ).catch( () => false );
					Http.json( res, 200, { ok: true, gate: _gate, ...this.system.describe() } );
				} )
				.route( 'GET', '/api/missions', this._person( ( { res } ) => Http.json( res, 200, Mission.list().map( item => item.describe() ) ) ) )
				.route( 'POST', '/api/missions/:id/start', this._person( async ( { req, res, params, body } ) => {
					const _busy = this.demo && this.system.running( params.id ) ? 'a run of this mission is still going; abort it first' : null;
					const _refused = _busy || this._limited( req, 'starts' );
					if ( _refused ) { return Http.json( res, _busy ? 409 : 429, { error: _refused } ); }
					// Only a mission of the missions folder, by its plain id (no path, no ../).
					const _mission = Mission.ID.test( params.id ) && Mission.list().find( item => item.id === params.id );
					if ( !_mission ) { return Http.json( res, 404, { error: 'no such mission' } ); }
					const _started = await this.system.start( _mission, String( body.task || _mission.task ).slice( 0, 2000 ) );
					Http.json( res, _started.refused ? 422 : 200, _started.refused ? _started : _started.describe() );
				} ) )
			// The kinds of tasks without a mission folder, and one of them written down as a mission folder (bin/promote.mjs).
				.route( 'GET', '/api/tasks', this._person( ( { res } ) => Http.json( res, 200, this.system.taskKinds() ) ) )
				.route( 'GET', '/api/tasks/:kind/mission', this._person( async ( { res, params } ) => Http.json( res, 200, await this.system.missionBundle( params.kind ) ) ) )
			// A task without a mission: the agent sets up what the kind of task needs, a person confirms each part.
				.route( 'POST', '/api/tasks', this._person( async ( { req, res, body } ) => {
					const _kind = typeof body.kind === 'string' && body.kind.trim() ? body.kind.trim() : 'general';
					const _busy = this.demo && this.system.running( _kind ) ? 'a task of this kind is still going; abort it first' : null;
					const _refused = _busy || this._limited( req, 'starts' );
					if ( _refused ) { return Http.json( res, _busy ? 409 : 429, { error: _refused } ); }
					if ( typeof body.task !== 'string' || !body.task.trim() ) { return Http.json( res, 400, { error: 'a task needs its text' } ); }
					const _started = await this.system.startTask( body.task.slice( 0, 2000 ), { kind: _kind } );
					Http.json( res, _started.refused ? 422 : 200, _started.refused ? _started : _started.describe() );
				} ) )
			// 8.1: a message from outside (a mail bridge, a form) for the latest run of a mission; it starts its own process.
				.route( 'POST', '/api/missions/:id/messages', this._safe( async ( { req, res, params, body } ) => {
					const _refused = this._inboundRefusal( req );
					if ( _refused ) { return Http.json( res, ..._refused ); }
					const _message = Main.message( body );
					if ( typeof _message === 'string' ) { return Http.json( res, 400, { error: _message } ); }
					Http.json( res, 200, await this.system.receive( params.id, _message ) );
				} ) )
				.route( 'POST', '/api/missions/:id/abort', this._person( async ( { res, params } ) => Http.json( res, 200, await this.system.abort( params.id ) ), 'calls' ) )
				.route( 'GET', '/api/tickets', this._person( async ( { res } ) => Http.json( res, 200, ( await this.system.board() ).list() ) ) )
				.route( 'POST', '/api/tickets/:id', this._person( async ( { res, params, body } ) => Http.json( res, 200, await this._answer(
					params.id, { choice: body.choice, by: body.by || 'person' } ) ), 'calls' ) )
				.route( 'GET', '/api/nodes', this._person( ( { res } ) => Http.json( res, 200, this.system.nodes().map( node => node.describe() ) ) ) )
				.route( 'GET', '/api/log', this._person( ( { res, query } ) => Http.json( res, 200, this.log.since( Number( query.get( 'since' ) || 0 ) ) ) ) )
				.route( 'GET', '/api/events', ( { req, res, query } ) => this._events( req, res, query ) );
			if ( _demo ) { this._demoRoutes(); }
		}

		// The demo's extras: the canned messages from outside, which reach the neighbour office too, the counters of
		// both offices, and the escape test of the sandbox.
		_demoRoutes() {
			this.http
				.route( 'POST', '/api/missions/:id/inbound/:message', this._person( async ( { res, params } ) => Http.json(
					res, 200, await this.system.inbound( params.id, params.message ) ), 'calls' ) )
				.route( 'POST', '/api/missions/:id/probes', this._person( ( { res, params } ) => Http.json( res, ...this.probe( params.id ) ), 'starts' ) )
			// The demo counters belong to the world, not to the core.
				.route( 'GET', '/api/missions/:id/exposure', this._person( async ( { res, params } ) => {
					const [ Exposure ] = await app.use( [ 'World.Exposure' ] );
					Http.json( res, 200, await Exposure.of( this.system, params.id ) );
				} ) );
		}

		_events( req, res, query ) {
			const _refused = this._boardRefusal( req );
			if ( _refused ) { return Http.json( res, ..._refused ); }
			// A public demo keeps at most STREAMS live logs open per caller, so nobody ties up the server.
			const _caller = Limits.caller( req );
			const _open = this.streams.get( _caller ) || 0;
			if ( this.demo && _open >= Main.STREAMS ) { return Http.json( res, 429, { error: 'too many open live logs; close one first' } ); }
			this.streams.set( _caller, _open + 1 );
			const _stream = Http.events( req, res );
			this.log.since( Number( query.get( 'since' ) || 0 ) ).forEach( _stream.send );
			const _unsubscribe = this.log.subscribe( _stream.send );
			_stream.closed.then( () => {
				_unsubscribe();
				const _left = ( this.streams.get( _caller ) || 1 ) - 1;
				if ( _left > 0 ) { this.streams.set( _caller, _left ); } else { this.streams.delete( _caller ); }
			} );
			return undefined;
		}

		// The inbound channel is off until INBOUND_TOKEN is set: nothing from outside starts a process unasked.
		_inboundRefusal( req ) {
			if ( !this.inbound.on ) { return [ 403, { error: 'the inbound channel is off (INBOUND_TOKEN is not set)' } ]; }
			const _result = this.inbound.check( this.inbound.given( req ) );
			return _result === 'ok' ? null : this.inbound.refusal( _result );
		}

		// One message from outside as the intake reads it: { id, from, to, subject, text }, each a text; the id names
		// the message once (a second one with the same id is a duplicate). → the message, or what is wrong with it.
		static message( body ) {
			const _text = name => ( typeof body[ name ] === 'string' ? body[ name ] : '' );
			const _message = { id: _text( 'id' ).trim(), from: _text( 'from' ).trim(), to: _text( 'to' ).trim(), subject: _text( 'subject' ), text: _text( 'text' ) };
			if ( !/^[\w.@:+-]{1,200}$/.test( _message.id ) ) { return 'a message needs its id: 1 to 200 letters, digits or . _ - @ : +'; }
			if ( !_message.from || _message.from.length > 320 ) { return 'a message needs its sender (from), at most 320 characters'; }
			if ( !_message.text.trim() ) { return 'a message needs its text'; }
			if ( JSON.stringify( _message ).length > Main.MESSAGE_MAX ) { return `a message is at most ${Main.MESSAGE_MAX} characters`; }
			return _message;
		}

	};
} );
