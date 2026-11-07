// Defining strategies, moves and criteria is itself a process on the same route (6.1, 14, 19). A proposal becomes a
// goal of its own whose contract uses only catalog types: the proposal passes the catalog check on exactly this
// version (test_green), a person said yes to exactly this question (confirmed_by), and the catalog holds this version
// (state_is). It runs the same loop as every other goal. The system grows with its own circle while the system gates
// stay untouchable: a proposal composes what exists. A move is one of the five base moves with a configuration and
// never an action to the outside; a criterion type is a conjunction of existing types; a strategy is a sequence of
// catalog moves. Only trusted code checks and registers; what a person approved is kept and applied after a restart.

app.define( 'Core.Meta.Proposals', [ 'Lib.Hash', 'Core.Move.Catalog', 'Core.Criteria.Composite' ], ( Hash, Catalog, Composite ) => class Proposals {

	static KINDS = [ 'strategy', 'move', 'criterion' ];
	static ID = /^[a-z][a-z0-9_.-]{1,40}$/;

	constructor( db, { log = null } = {} ) {
		this.db = db;
		this.log = log;
		this.db.exec( `CREATE TABLE IF NOT EXISTS proposals (
			version TEXT PRIMARY KEY, kind TEXT NOT NULL, mission TEXT NOT NULL, body TEXT NOT NULL, by TEXT NOT NULL,
			status TEXT NOT NULL, approvedBy TEXT, time TEXT NOT NULL
		)` );
	}

	// The version is the hash of the proposal: what the person approves is exactly what gets registered.
	submit( kind, body, { mission, by } ) {
		const _version = Hash.sha256( Hash.canonical( { kind, body } ) ).slice( 0, 16 );
		this.db.run( `INSERT OR IGNORE INTO proposals ( version, kind, mission, body, by, status, time )
			VALUES ( :version, :kind, :mission, :body, :by, 'proposed', :at )`, {
			version: _version, kind, mission, body: Hash.canonical( body ), by, at: new Date().toISOString(),
		} );
		return _version;
	}

	get( version ) {
		const _row = this.db.get( 'SELECT * FROM proposals WHERE version = :version', { version } );
		return _row ? { ..._row, body: JSON.parse( _row.body ) } : null;
	}

	count() {
		return this.db.get( 'SELECT COUNT(*) AS n FROM proposals' ).n;
	}

	// The goal of the process for one proposal; the requesting node is its client, so it carries its invariants.
	static contract( kind, body, version, { parent, deadline, budget } ) {
		const _question = `Add the ${kind} "${body.id || body.type}" to the catalog? ${Proposals.summary( kind, body )}`;
		return {
			id: `${parent.contract.id}/${kind}-${version.slice( 0, 6 )}`,
			goal: `The new ${kind} "${body.id || body.type}" is checked, approved by a person and in the catalog`,
			deadline, budget, value: budget, kind: 'meta', parent: parent.contract.hash,
			criteria: [
				{ id: 'm1', type: 'test_green', values: { test: `${kind}_check`, commit: version }, origin: 'client' },
				{ id: 'm2', type: 'confirmed_by', values: { role: 'client', question: _question }, origin: 'client' },
				{ id: 'm3', type: 'state_is', values: { object: 'catalog', field: `${kind}:${body.id || body.type}`, value: version }, origin: 'client' },
			],
		};
	}

	static summary( kind, body ) {
		if ( kind === 'strategy' ) { return Proposals._steers( body ); }
		if ( kind === 'move' ) { return `A ${body.executor} move: ${body.describe || ''}`; }
		return `It holds when all of ${( body.all || [] ).map( part => part.type ).join( ', ' )} hold.`;
	}

	// The person says yes to everything that changes which strategy the chooser takes and what it then does (19, 5.6):
	// what it serves, its steps with their parameters and recipients, its class, whether it is a probe, its start
	// curve, what it fits and the depth it is meant for. Nothing of that may be approved unseen.
	static _steers( body ) {
		const _json = value => Hash.canonical( value );
		const _step = step => [ step?.move, step?.params && Object.keys( step.params ).length ? _json( step.params ) : '', step?.target ? `to ${step.target}` : '' ]
			.filter( Boolean ).join( ' ' );
		const _parts = [ `It serves ${body.serves} with ${( Array.isArray( body.steps ) ? body.steps : [] ).map( _step ).join( ' → ' )}.` ];
		if ( body.class !== undefined ) { _parts.push( `Class: ${[].concat( body.class ).join( ', ' )}.` ); }
		if ( body.probe !== undefined ) { _parts.push( body.probe ? 'It is a probe.' : 'It is no probe.' ); }
		if ( body.startCurve !== undefined ) { _parts.push( `Start curve: ${_json( body.startCurve )}.` ); }
		if ( body.fits !== undefined ) { _parts.push( `Fits: ${_json( body.fits )}.` ); }
		if ( body.depth !== undefined ) { _parts.push( `Depth: ${_json( body.depth )}.` ); }
		return _parts.join( ' ' );
	}

	// The trusted check (a code move): only what exists may be composed. → { result: green|red, problems }
	check( version, { catalog, registry, strategies } ) {
		const _proposal = this.get( version );
		if ( !_proposal ) { return { result: 'red', problems: [ 'no such proposal' ] }; }
		if ( !Proposals.KINDS.includes( _proposal.kind ) ) { return { result: 'red', problems: [ `unknown kind ${_proposal.kind}` ] }; }
		const _body = _proposal.body;
		const _checks = {
			strategy: () => Proposals._strategy( _body, { catalog, registry, strategies } ),
			move: () => Proposals._move( _body, catalog ),
			criterion: () => Proposals._criterion( _body, registry ),
		};
		let _problems;
		try {
			_problems = _body && typeof _body === 'object' && !Array.isArray( _body ) ? _checks[ _proposal.kind ]() : [ 'the proposal is no object' ];
		} catch ( error ) {
			_problems = [ `the proposal is malformed: ${error.message}` ];
		}
		return { result: _problems.length ? 'red' : 'green', problems: _problems };
	}

	static _strategy( body, { catalog, registry, strategies } ) {
		const _problems = Proposals.ID.test( body.id || '' ) ? [] : [ 'the id must be a short code' ];
		if ( strategies.some( item => item.id === body.id ) ) { _problems.push( `a strategy ${body.id} exists already` ); }
		if ( body.serves !== '@byPerson' && !registry.has( body.serves ) ) { _problems.push( `${body.serves} is no criterion type` ); }
		const _steps = Array.isArray( body.steps ) ? body.steps : [];
		if ( !_steps.length ) { _problems.push( 'a strategy needs steps' ); }
		_problems.push( ...Proposals._choice( body ) );
		for ( const step of _steps ) {
			if ( !step || typeof step !== 'object' || Array.isArray( step ) ) {
				_problems.push( 'every step is an object with a move' );
				continue;
			}
			const _move = typeof step.move === 'string' && catalog.get( step.move );
			if ( !_move ) {
				_problems.push( `${step.move} is not in the catalog` );
				continue;
			}
			// The trusted moves of the core (checking and registering proposals, taking back a move) are no building blocks.
			if ( _move.trusted && _move.trusted !== 'find' ) {
				_problems.push( `${step.move} is trusted code of the core and no part of a strategy` );
			}
			const _plain = !step.params || ( typeof step.params === 'object' && !Array.isArray( step.params ) );
			if ( !_plain ) { _problems.push( `${step.move}: params must be an object` ); }
			// A list is no object of names, and each of its entries is no parameter of the move either.
			const _params = step.params && typeof step.params === 'object' ? step.params : {};
			const _unknown = Object.keys( _params ).filter( name => !Object.hasOwn( _move.params || {}, name ) && name !== _move.param );
			_problems.push( ..._unknown.map( name => `${step.move} has no parameter ${name}` ) );
		}
		if ( !( Number( body.price ) >= 0 ) ) { _problems.push( 'the price must be a number' ); }
		return _problems;
	}

	// What steers the choice is checked as well: a chance p0 in [0, 1], a positive time constant, and patterns that
	// compile, so an approved strategy can neither win every choice nor break the chooser. A pattern is short text
	// without a repeated repetition: (a+)+ on a crafted value would hold up every choice (ReDoS).
	static _choice( body ) {
		const _problems = [];
		const _curve = body.startCurve;
		if ( _curve !== undefined ) {
			const _p0 = Number( _curve?.p0 );
			const _tau = Number( _curve?.tauH );
			if ( !( _p0 >= 0 && _p0 <= 1 ) ) { _problems.push( 'the start chance p0 must be between 0 and 1' ); }
			if ( !( _tau > 0 && Number.isFinite( _tau ) ) ) { _problems.push( 'the time constant tauH must be a positive number' ); }
		}
		for ( const [ name, pattern ] of Object.entries( body.fits && typeof body.fits === 'object' ? body.fits : {} ) ) {
			if ( typeof pattern !== 'string' || pattern.length > Proposals.PATTERN ) {
				_problems.push( `fits.${name} must be a pattern of at most ${Proposals.PATTERN} characters` );
				continue;
			}
			if ( Proposals.nested( pattern ) ) { _problems.push( `fits.${name} repeats a repetition, which can take exponential time` ); }
			try {
				new RegExp( pattern );
			} catch {
				_problems.push( `fits.${name} is no valid pattern` );
			}
		}
		if ( body.fits !== undefined && ( !body.fits || typeof body.fits !== 'object' || Array.isArray( body.fits ) ) ) {
			_problems.push( 'fits maps parameters to patterns' );
		}
		return _problems;
	}

	static PATTERN = 100;

	// Does a pattern repeat a group that repeats itself, like (a+)+, (\d*)* or ((a+)b){2,}? Escapes and character
	// classes are skipped; any repetition inside a repeated group counts, which is stricter than needed.
	static nested( pattern ) {
		const _open = [];
		let _group = null;
		for ( let i = 0; i < pattern.length; i++ ) {
			const _char = pattern[ i ];
			if ( _char === '\\' ) {
				i++;
				_group = null;
			} else if ( _char === '[' ) {
				for ( i++; i < pattern.length && pattern[ i ] !== ']'; i++ ) { i += pattern[ i ] === '\\' ? 1 : 0; }
				_group = null;
			} else if ( _char === '(' ) {
				_open.push( false );
				_group = null;
			} else if ( _char === ')' ) {
				_group = { repeats: _open.pop() ?? false };
			} else if ( _char === '*' || _char === '+' || ( _char === '{' && /^\{\d+(,\d*)?\}/.test( pattern.slice( i ) ) ) ) {
				if ( _group?.repeats ) { return true; }
				_open.fill( true );
				_group = null;
			} else if ( _char !== '?' ) {
				_group = null;
			}
		}
		return false;
	}

	// A new move is one of the five base moves with a configuration; it never acts outward, never creates an
	// expectation, never confirms a criterion and never produces evidence: those are fixed in the catalog and the gate's
	// action table. Nor does it set labels (10.4): what it derives carries every label of its inputs (it inherits, set
	// on registration), and only trusted code may say a value is cleaner, a group, or labelled per field.
	static FIXED = [ 'action', 'creates', 'confirms', 'resolves', 'trusted', 'labels', 'inherit', 'fieldLabels', 'group', 'fact', 'about',
		'evidence', 'outbound', 'template', 'agentCode' ];

	static _move( body, catalog ) {
		const _problems = Proposals.ID.test( body.id || '' ) ? [] : [ 'the id must be a short code' ];
		if ( catalog.get( body.id ) ) { _problems.push( `a move ${body.id} exists already` ); }
		if ( !Catalog.EXECUTORS.includes( body.executor ) ) { _problems.push( `${body.executor} is not one of the five base moves` ); }
		for ( const field of Proposals.FIXED ) {
			if ( body[ field ] !== undefined ) { _problems.push( `a proposed move may not set ${field}` ); }
		}
		if ( body.executor === 'ai' && !( body.role && body.contract?.fields ) ) { _problems.push( 'a model move needs a role and a step contract' ); }
		if ( body.executor === 'code' && !/^sandbox\/tools\/[a-z_]+\.py$/.test( body.tool || '' ) ) { _problems.push( 'a code move runs a sandbox tool' ); }
		if ( body.executor === 'code' && body.tool && !app.lib( 'node:fs' ).existsSync( app.lib( 'node:path' ).join( app.root, body.tool ) ) ) {
			_problems.push( `${body.tool} does not exist` );
		}
		if ( !( Number( body.price ?? 0 ) >= 0 ) ) { _problems.push( 'the price must be a number' ); }
		return _problems;
	}

	// A new criterion type holds when all its parts hold; each part is an existing type with values ({{name}} names a
	// parameter of the new type).
	static _criterion( body, registry ) {
		const _problems = /^[a-z][a-z0-9_]{2,40}$/.test( body.type || '' ) ? [] : [ 'the type must be a short code' ];
		if ( registry.has( body.type ) ) { _problems.push( `a type ${body.type} exists already` ); }
		const _all = Array.isArray( body.all ) ? body.all : [];
		if ( _all.length < 2 ) { _problems.push( 'a new type combines at least two existing types' ); }
		for ( const part of _all ) {
			if ( !part || typeof part !== 'object' || !registry.has( part.type ) ) { _problems.push( `${part?.type} is no criterion type` ); }
		}
		return _problems;
	}

	// The two trusted code moves of a proposal's process: the check reports a test run on exactly this version; the
	// registration needs the person's yes to exactly this question and reports what the catalog now holds.
	run( name, step, ctx ) {
		if ( ![ 'check', 'register' ].includes( name ) ) {
			throw new Error( `${step.move} is no move of a proposal; ${name} runs only from the judgment (E6)` );
		}
		const _version = step.params?.version;
		const _proposal = this.get( _version );
		const _out = { labels: [ 'own' ], cohort: null, facts: [] };
		const _fact = ( kind, data ) => ( { kind, evidenceClass: 'observation', source: `trusted meta.${name}`, origin: 'system', data } );
		if ( name === 'check' ) {
			const _known = { catalog: ctx.runner.catalog, registry: ctx.runner.registry, strategies: ctx.runner.mission.strategies };
			const _check = this.check( _version, _known );
			ctx.node.emit( 'proposal_checked', { version: _version, ..._check } );
			const _wall = _check.result === 'red' ? { cause: 'plan_refused', detail: _check.problems, reason: _check.problems.join( '; ' ) } : null;
			const _run = _fact( 'test_run', { test: `${_proposal?.kind}_check`, commit: _version, result: _check.result } );
			return { ..._out, value: _check, facts: [ _run ], wall: _wall };
		}
		const _question = ctx.node.contract.criteria.find( item => item.type === 'confirmed_by' );
		const _yes = _question?.check( ctx.node.valid() );
		const _by = _yes?.met ? ctx.node.facts.find( fact => _yes.evidence.includes( fact.id ) )?.source || 'a person' : null;
		if ( !this.register( _version, { approved: _by, runner: ctx.runner } ) ) {
			return { ..._out, value: null, wall: { cause: 'rejected_by_person', reason: 'the proposal was not approved' } };
		}
		const _id = _proposal.body.id || _proposal.body.type;
		return { ..._out, value: { registered: _id }, facts: [ _fact( 'state_read', { object: 'catalog', field: `${_proposal.kind}:${_id}`, value: _version } ) ] };
	}

	// The trusted registration (a code move): only an approved, green version goes into the catalog. The check runs
	// again right here, and the one who proposed it can never be the one who approves it.
	register( version, { approved, runner } ) {
		const _proposal = this.get( version );
		if ( !_proposal || !approved || !runner || Proposals.self( approved, _proposal.by ) ) { return false; }
		const _known = { catalog: runner.catalog, registry: runner.registry, strategies: runner.mission.strategies };
		if ( !Proposals.intact( _proposal ) || this.check( version, _known ).result !== 'green' ) { return false; }
		this.db.run( 'UPDATE proposals SET status = \'approved\', approvedBy = :by WHERE version = :version', { version, by: approved } );
		Proposals.apply( { ..._proposal, status: 'approved', approvedBy: approved }, runner );
		this.log?.append( 'catalog_extended', { kind: _proposal.kind, id: _proposal.body.id || _proposal.body.type, version, by: approved } );
		return true;
	}

	// What people approved for one mission (or kind of task), oldest first: { kind, body, version, approvedBy }.
	approvedFor( mission, kind ) {
		return this.db.all( 'SELECT * FROM proposals WHERE status = \'approved\' AND mission = :mission AND kind = :kind ORDER BY time', { mission, kind } )
			.map( row => ( { ...row, body: JSON.parse( row.body ) } ) ).filter( item => Proposals.intact( item ) && item.approvedBy );
	}

	// What a person approved earlier is part of the catalog again after a restart: only a row whose body still has its
	// version and that names who approved it; anything else was changed outside the system and is left out.
	applyApproved( runner ) {
		const _rows = this.db.all( 'SELECT * FROM proposals WHERE status = \'approved\' AND ( mission = :mission OR kind = \'criterion\' ) ORDER BY time',
			{ mission: runner.mission.id } );
		for ( const row of _rows ) {
			let _proposal;
			try {
				_proposal = { ...row, body: JSON.parse( row.body ) };
			} catch {
				_proposal = null;
			}
			if ( _proposal && Proposals.intact( _proposal ) && row.approvedBy && !Proposals.self( row.approvedBy, row.by ) ) {
				Proposals.apply( _proposal, runner );
			} else {
				this.log?.append( 'proposal_refused_on_load', { version: row.version, reason: 'changed outside the system or approved by nobody' } );
			}
		}
	}

	// AGENCY_PROPOSALS: what a proposed strategy needs at the gate (an action, a master-data value) is proposed there and
	// decided by the operator; the node that asked waits for each decision (as for its goal's confirmation, 3.2). An
	// approved action is learned by this process with the send move trusted code derives for it. A value is labelled
	// own only when the confirmed root goal names it, foreign otherwise; the gate checks that again with its own copy.
	// → true when everything was approved; anything refused, rejected or left open is false.
	async gateSetUp( node, needs, runner ) {
		const _actions = ( Array.isArray( needs?.actions ) ? needs.actions : [] ).slice( 0, 2 );
		const _master = ( Array.isArray( needs?.master ) ? needs.master : [] ).slice( 0, 5 );
		if ( !_actions.length && !_master.length ) { return true; }
		if ( !runner.proposals || typeof runner.gate.proposeAt !== 'function' ) { return false; }
		const _root = [ node, ...node.ancestors() ].at( -1 );
		const _requests = [
			..._actions.map( item => ( { kind: 'action', body: { name: item?.name, entry: Proposals.entry( item ) } } ) ),
			..._master.map( item => ( { kind: 'master', body: { kind: item?.kind, value: item?.value },
				labels: Proposals.named( _root.contract.spec, item?.value ) ? [ 'own' ] : [ 'foreign' ] } ) ),
		];
		for ( const request of _requests ) {
			let _row;
			try {
				_row = await runner.gate.proposeAt( { ...request, contract: node.contract.hash, node: node.id } );
			} catch ( error ) {
				node.emit( 'gate_proposal_refused', { kind: request.kind, reason: String( error?.message ).slice( 0, 300 ) } );
				return false;
			}
			node.emit( 'gate_proposal_submitted', { proposal: _row.id, kind: request.kind, name: _row.name } );
			const _decided = await Proposals.decided( runner, node, _row.id );
			node.emit( 'gate_proposal_decided', { proposal: _row.id, status: _decided?.status || 'open' } );
			if ( _decided?.status !== 'approved' ) { return false; }
			if ( request.kind === 'action' ) { Proposals.learn( request.body, runner ); }
		}
		return true;
	}

	// The fields of an action the model described that make an action; anything else is left out for the gate to see.
	static entry( item ) {
		const _keys = [ 'criticality', 'carries', 'says', 'sensitive', 'recipient', 'params' ];
		return Object.fromEntries( _keys.filter( key => item && item[ key ] !== undefined && item[ key ] !== '' && item[ key ] !== null )
			.map( key => [ key, item[ key ] ] ) );
	}

	static learn( { name, entry }, runner ) {
		const Actions = app.get( 'Lib.Actions' );
		if ( !Actions.learned()[ name ] ) { Actions.learn( { [ name ]: entry } ); }
		Catalog.derive( runner.catalog );
	}

	// Waits for the operator, as long as the node may: until its deadline, or until it is stopped.
	static async decided( runner, node, id ) {
		for ( ;; ) {
			const _row = await runner.gate.gateProposal( id ).catch( () => null );
			if ( _row && _row.status !== 'proposed' ) { return _row; }
			if ( node.stopping || !( Date.now() < Date.parse( node.contract.deadline ) ) ) { return _row; }
			await new Promise( resolve => setTimeout( resolve, runner.pollMs ) );
		}
	}

	// Does the goal a person confirmed name the value: as one of its criteria's values, or each part of a contact pair?
	static named( spec, value ) {
		if ( typeof value !== 'string' || !value.trim() ) { return false; }
		const _texts = new Set();
		const _walk = ( item, depth = 0 ) => {
			if ( typeof item === 'string' ) { _texts.add( item.trim() ); }
			if ( item && typeof item === 'object' && depth < 8 ) { Object.values( item ).forEach( inner => _walk( inner, depth + 1 ) ); }
		};
		_walk( ( spec?.criteria || [] ).map( item => item?.values ) );
		return value.split( /\s+/ ).filter( Boolean ).every( part => _texts.has( part ) );
	}

	// The body is still the one its version was computed from.
	static intact( proposal ) {
		return Hash.sha256( Hash.canonical( { kind: proposal.kind, body: proposal.body } ) ).slice( 0, 16 ) === proposal.version;
	}

	// The proposer (a node, or the agent) never approves its own proposal.
	static self( approved, by ) {
		const _who = String( approved ).replace( /^(person|node)\s+/, '' ).trim();
		return !_who || _who === String( by ) || _who.toLowerCase() === 'agent';
	}

	static apply( proposal, runner ) {
		const { kind, body, version, approvedBy } = proposal;
		if ( kind === 'strategy' && !runner.mission.strategies.some( item => item.id === body.id ) ) {
			runner.mission.strategies.push( { ...body, approved: { version, by: approvedBy } } );
		} else if ( kind === 'move' && !runner.catalog.get( body.id ) ) {
			const _fixed = { inherit: true, criticality: body.executor === 'wait' ? 'read' : 'internal', approved: { version, by: approvedBy } };
			runner.catalog.moves[ body.id ] = { ...body, ..._fixed };
		} else if ( kind === 'criterion' && !runner.registry.has( body.type ) ) {
			runner.registry.types[ body.type ] = Composite.of( body, runner.registry );
		}
	}

} );
