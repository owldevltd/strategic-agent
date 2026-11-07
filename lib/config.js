// Everything the processes need from outside. Values come from the environment, or from a .env file in the
// project folder (see .env.example); the environment wins. A setting that is not what it must be stops the start
// with an error that names it, instead of a NaN that switches a rule off deep inside.

app.define( 'Lib.Config', [], () => class Config {

	// Leases of a move (18.6): 2 minutes for code, 3 for the model. A2: every client timeout stays below its lease.
	static LEASE_SECONDS = { code: 120, model: 180 };

	// The names a .env file put into process.env, with the value it put there (see readEnv).
	static _fromFile = new Map();

	static load( root = app.root ) {
		const path = app.lib( 'node:path' );
		Config.readEnv( path.join( root, '.env' ) );
		const _env = process.env;
		const _gatePort = Config._number( 'GATE_PORT', 8091, Config._port );
		return {
			root,
			storageDir: path.resolve( root, _env.STORAGE_DIR || 'storage' ),
			core: {
				host: _env.CORE_HOST || '127.0.0.1',
				port: Config._number( 'CORE_PORT', 8090, Config._port ),
			},
			gate: {
				host: _env.GATE_HOST || '127.0.0.1',
				port: _gatePort,
				url: _env.GATE_URL || `http://127.0.0.1:${_gatePort}`,
				bufferMinutes: Config._number( 'BUFFER_MINUTES', 5, value => value >= 0, 'a number of minutes, 0 or more' ),
				// Whose deliveries "exactly once" and "no difference" look at: every goal at this gate (the default), or only
				// the goal's own tree, for a public demo where every run is a simulated week of its own. Only the gate's
				// operator sets it, in the gate's own environment; the core cannot.
				ledger: Config._choice( 'GATE_LEDGER_SCOPE', [ 'gate', 'goal' ] ),
				// The origins whose page may call the gate from another origin: the core's operator page. In development the
				// core serves it on its own port; behind one host (a reverse proxy) page and gate share an origin and need none.
				origins: Config._origins( _env.GATE_UI_ORIGIN, Config._number( 'CORE_PORT', 8090, Config._port ) ),
			},
			llm: {
				baseUrl: _env.LLM_BASE_URL || 'https://api.vultrinference.com/v1',
				apiKey: _env.LLM_API_KEY || '',
				model: _env.LLM_MODEL || '',
				// A model per role where one does better than the default (a reasoning model for the coder, a fast one for
				// reading mail): LLM_MODELS=coder=model-a,extractor=model-b. A role not named uses the default model.
				models: Config._models( _env.LLM_MODELS ),
				// How long a reasoning model may think before it answers (reasoning_effort): LLM_EFFORT=coder=medium, or one
				// value for every role. Unset, the endpoint decides; a reasoning model may then think its whole token limit
				// away on a large answer (a parser, a file of code) and answer nothing.
				effort: Config._effort( _env.LLM_EFFORT ),
				// A2: shorter than the lease of a model move, so the supervisor never has to cut a call.
				timeoutSeconds: Config._number( 'LLM_TIMEOUT', 150, value => value > 0 && value < Config.LEASE_SECONDS.model,
					`seconds above 0 and below the model lease of ${Config.LEASE_SECONDS.model} (A2)` ),
			},
			sandbox: {
				runtime: _env.SANDBOX_RUNTIME || 'process',
				image: _env.SANDBOX_IMAGE || 'python:3.12-slim',
				timeoutSeconds: Config._number( 'SANDBOX_TIMEOUT', 10, value => value > 0 && value < Config.LEASE_SECONDS.code,
					`seconds above 0 and below the code lease of ${Config.LEASE_SECONDS.code} (A2, A7)` ),
			},
			// The demo's extras: a neighbour office without a gate that gets the same messages, the counters of both, the
			// canned messages from outside and the escape test. Off unless AGENCY_DEMO=1; never part of an operation.
			demo: Config._choice( 'AGENCY_DEMO', [ '0', '1' ] ) === '1',
			// The agent may propose what the gate checks against (an action, a master-data value); the operator decides at
			// the gate. Off unless AGENCY_PROPOSALS=1, in the core's and the gate's environment alike.
			proposals: Config._choice( 'AGENCY_PROPOSALS', [ '0', '1' ] ) === '1',
			// How many days the copy of a finished run's data is kept (core/vault); open runs keep theirs.
			vaultRetentionDays: Config._number( 'VAULT_RETENTION_DAYS', 30, value => Number.isInteger( value ) && value >= 1, 'whole days, 1 or more' ),
			maxDepth: Config._number( 'MAX_DEPTH', 5, value => Number.isInteger( value ) && value >= 0, 'a whole number, 0 or more (R2)' ),
			// The simulated world can run faster than real time for a demo; leases beat every 15 s by default.
			worldSpeed: Config._number( 'WORLD_SPEED', 1, value => value > 0, 'a number above 0' ),
			beatMs: Config._number( 'LEASE_BEAT_MS', 15000, value => value > 0, 'milliseconds above 0 (A1)' ),
		};
	}

	// A number setting: unset or empty gives the default; anything else must be a decimal number that passes ok.
	static _number( name, fallback, ok, what = 'a port number from 0 to 65535' ) {
		const _text = process.env[ name ];
		if ( _text === undefined || _text.trim() === '' ) { return fallback; }
		const _value = /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test( _text ) ? Number( _text ) : NaN;
		if ( !Number.isFinite( _value ) || !ok( _value ) ) {
			throw new RangeError( `Setting ${name} must be ${what}` );
		}
		return _value;
	}

	// role=model pairs, separated by commas; a role is a plain name. Anything else is refused at start.
	static _models( text ) {
		const _models = {};
		for ( const pair of String( text ?? '' ).split( ',' ).map( item => item.trim() ).filter( Boolean ) ) {
			const [ role, model ] = pair.split( '=' ).map( item => item?.trim() );
			if ( !/^[a-z][a-z_-]{0,39}$/.test( role || '' ) || !model ) { throw new RangeError( 'Setting LLM_MODELS must be role=model pairs, separated by commas' ); }
			_models[ role ] = model;
		}
		return _models;
	}

	// Origins separated by commas, each scheme://host[:port]; not set, the core's own page on this machine.
	static _origins( text, corePort ) {
		const _given = String( text ?? '' ).split( ',' ).map( item => item.trim() ).filter( Boolean );
		for ( const origin of _given ) {
			if ( !/^https?:\/\/[^/\s]+$/.test( origin ) ) { throw new RangeError( 'Setting GATE_UI_ORIGIN must be origins like https://agency.example, separated by commas' ); }
		}
		return _given.length ? _given : [ `http://127.0.0.1:${corePort}`, `http://localhost:${corePort}` ];
	}

	static EFFORTS = [ 'low', 'medium', 'high' ];

	// "medium" for every role ("*"), or role=effort pairs; an effort the endpoints do not know stops the start.
	static _effort( text ) {
		const _effort = {};
		for ( const pair of String( text ?? '' ).split( ',' ).map( item => item.trim() ).filter( Boolean ) ) {
			const _parts = pair.split( '=' ).map( item => item.trim() );
			const [ role, value ] = _parts.length === 1 ? [ '*', _parts[ 0 ] ] : _parts;
			if ( _parts.length > 2 || !( role === '*' || /^[a-z][a-z_-]{0,39}$/.test( role ) ) || !Config.EFFORTS.includes( value ) ) {
				throw new RangeError( `Setting LLM_EFFORT must be one of ${Config.EFFORTS.join( ', ' )}, or role=effort pairs separated by commas` );
			}
			_effort[ role ] = value;
		}
		return _effort;
	}

	// A setting from a fixed list: unset or empty gives the first entry; anything else must be one of them.
	static _choice( name, values ) {
		const _text = ( process.env[ name ] ?? '' ).trim();
		if ( !_text ) { return values[ 0 ]; }
		if ( !values.includes( _text ) ) { throw new RangeError( `Setting ${name} must be one of ${values.join( ', ' )}` ); }
		return _text;
	}

	static _port( value ) {
		return Number.isInteger( value ) && value >= 0 && value <= 65535;
	}

	// Fills process.env from a .env file where the environment has no value. What an earlier .env put there is no
	// environment: it gives way, so a second root read in the same process never keeps the first root's values.
	static readEnv( file ) {
		const fs = app.lib( 'node:fs' );
		const _values = fs.existsSync( file ) ? Config.parseEnv( fs.readFileSync( file, 'utf8' ) ) : new Map();
		for ( const [ name, value ] of Config._fromFile ) {
			if ( process.env[ name ] === value ) {
				delete process.env[ name ];
			}
		}
		Config._fromFile.clear();
		for ( const [ name, value ] of _values ) {
			if ( process.env[ name ] === undefined ) {
				process.env[ name ] = value;
				Config._fromFile.set( name, value );
			}
		}
		return _values;
	}

	// NAME=value lines into a fresh map; the first line of a name counts. A line may start with "export ", a value
	// may be quoted ('…' or "…", taken as written) and may end in a comment after a blank (" # …"). Nothing is
	// expanded: no shell, no variables.
	static parseEnv( text ) {
		const _values = new Map();
		for ( const line of text.split( /\r?\n/ ) ) {
			const _match = line.match( /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=([\s\S]*)$/ );
			if ( _match && !_values.has( _match[ 1 ] ) ) {
				_values.set( _match[ 1 ], Config._value( _match[ 2 ] ) );
			}
		}
		return _values;
	}

	static _value( text ) {
		const _quoted = text.trim().match( /^(['"])([\s\S]*)\1(?:\s+#[\s\S]*)?$/ );
		if ( _quoted ) { return _quoted[ 2 ]; }
		return text.replace( /\s#[\s\S]*$/, '' ).trim();
	}

} );
