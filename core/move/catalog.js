// The move catalog: base moves (catalog/moves.json) plus the moves a mission brings. A plan may only use moves
// listed here (G2); new moves are configurations of the five base moves code, ai, human, wait and child, added only
// through their own process with a person's approval (Core.Meta.Proposals).
// Every entry carries the fields of 6.2: executor, evidence, criticality, idempotency (hours the service keeps the
// key; null: none, so at most once), parameter types, sensitive parameters, price, t_signal, horizon H, the maximum
// lease, what it creates, what it may commit to, and whether it can be taken back. For an outward action the gate's
// action table is the one source of criticality, sensitive parameters, idempotency and commitments; the catalog
// shows the same values. Only the catalog's own entries are moves: a name of Object.prototype never is one.

app.define( 'Core.Move.Catalog', [ 'Lib.Actions', 'Core.Label.Flow' ], ( Actions, Flow ) => class Catalog {

	static EXECUTORS = [ 'code', 'ai', 'human', 'wait', 'child' ];
	static CRITICALITY = [ 'read', 'internal', 'outward', 'irreversible', 'money_or_law' ];
	static FIELDS = [ 'executor', 'evidence', 'criticality', 'params', 'price', 'tSignalH', 'horizonH', 'leaseMaxMin', 'reversible' ];

	static load( mission ) {
		const _path = app.lib( 'node:path' ).join( app.root, 'catalog', 'moves.json' );
		const _base = JSON.parse( app.lib( 'node:fs' ).readFileSync( _path, 'utf8' ) );
		const _own = Object.entries( Catalog.object( mission?.moves ) ? mission.moves : {} )
			.map( ( [ name, move ] ) => [ name, Catalog.defaults( move ) ] );
		return new Catalog( { ..._base, ...Object.fromEntries( _own ) } );
	}

	// What a mission's move may leave out (6.2 still sees every field): no evidence, no typed parameters, no signal or
	// horizon, a lease by its kind of executor, and reversible only for waiting and for asking a person. executor,
	// criticality and price are never filled in: they are the move.
	static LEASE = { code: 2, ai: 3 };

	static defaults( move ) {
		if ( !Catalog.object( move ) ) { return move; }
		const _executor = typeof move.executor === 'string' ? move.executor : '';
		return {
			evidence: [], params: {}, tSignalH: null, horizonH: null, commits: null,
			leaseMaxMin: Object.hasOwn( Catalog.LEASE, _executor ) ? Catalog.LEASE[ _executor ] : null,
			reversible: [ 'wait', 'human' ].includes( _executor ),
			...move,
		};
	}

	// A definition that is no object (null, a text, a list) is no move: it is kept aside for validate() to report,
	// so one broken mission move never takes the whole catalog down.
	constructor( moves, actions = Actions.load() ) {
		const _given = Object.entries( moves && typeof moves === 'object' ? moves : {} );
		this.moves = Object.fromEntries( _given.filter( ( [ , move ] ) => Catalog.object( move ) )
			.map( ( [ name, move ] ) => [ name, Catalog.entry( move, actions ) ] ) );
		this.broken = _given.filter( ( [ , move ] ) => !Catalog.object( move ) ).map( ( [ name ] ) => name );
	}

	static object( value ) {
		return Boolean( value ) && typeof value === 'object' && !Array.isArray( value );
	}

	// An action move shows what the gate's table says about its action.
	static entry( move, actions ) {
		const _action = actions.entry( move.action );
		if ( !_action ) { return { sensitive: [], idempotencyH: null, ...move }; }
		return {
			...move, criticality: _action.criticality, sensitive: _action.sensitive || [], idempotencyH: _action.idempotencyH ?? null,
			commits: _action.commits || null,
		};
	}

	// The send move of an action an operator approved at the gate (Gate.Proposals): trusted code, no model, a person's
	// approval of each use at the gate. A text goes into body when the action carries a message; else the fields of
	// the input become its parameters, each with its own labels (10.4).
	static sendMove( name, entry ) {
		const _declared = Object.entries( entry?.params || {} );
		const _params = Object.fromEntries( _declared.map( ( [ key, type ] ) => [ key, { type, optional: true } ] ) );
		const _message = Array.isArray( entry?.carries ) && entry.carries.includes( 'message' );
		return {
			executor: 'code', action: name, ...( _message ? { param: 'body' } : {} ), params: _params, evidence: [ 'delivered' ], price: 0.1,
			humanMinutes: 2, horizonH: 168, leaseMaxMin: 5, reversible: false, derived: true,
			describe: `trusted code: hands the action ${name} (${String( entry?.says || '' ).slice( 0, 120 )}) to the gate; a person approves each use`,
		};
	}

	// Adds the send move <action>.send of every action this process learned; a move of that name the catalog has stays.
	static derive( catalog, actions = app.get( 'Lib.Actions' ) ) {
		const _table = actions.load();
		for ( const [ name, entry ] of Object.entries( actions.learned() ) ) {
			const _move = `${name}.send`;
			if ( !catalog.get( _move ) ) {
				catalog.moves[ _move ] = Catalog.entry( Catalog.defaults( Catalog.sendMove( name, entry ) ), _table );
			}
		}
		return catalog;
	}

	get( name ) {
		return typeof name === 'string' && Object.hasOwn( this.moves, name ) ? this.moves[ name ] : null;
	}

	cost( name ) {
		return this.get( name )?.price ?? 1;
	}

	// → the problems of the catalog: a missing field of 6.2, an unknown executor or criticality, an unknown action, a
	// price that is no amount, parameters that are no types, labels outside 10.4, a model that does not inherit.
	validate( actions = Actions.load() ) {
		const _problems = this.broken.flatMap( name => [ `${name}: the definition is no object`,
			...Catalog.FIELDS.map( field => `${name}: ${field} is missing (6.2)` ) ] );
		for ( const [ name, move ] of Object.entries( this.moves ) ) {
			const _missing = Catalog.FIELDS.filter( field => !Object.hasOwn( move, field ) );
			_problems.push( ..._missing.map( field => `${name}: ${field} is missing (6.2)` ) );
			if ( !Catalog.EXECUTORS.includes( move.executor ) ) { _problems.push( `${name}: ${move.executor} is not a base move` ); }
			if ( !Catalog.CRITICALITY.includes( move.criticality ) ) { _problems.push( `${name}: criticality ${move.criticality} is unknown` ); }
			if ( move.action !== undefined && !actions.entry( move.action ) ) { _problems.push( `${name}: the gate knows no action ${move.action}` ); }
			_problems.push( ...Catalog.amounts( move ).map( text => `${name}: ${text}` ) );
			_problems.push( ...Catalog.labels( move ).map( text => `${name}: ${text}` ) );
		}
		return _problems;
	}

	// G2 adds prices to check the budget: a price is a number of at least zero (5.2); parameters are typed (6.2).
	static amounts( move ) {
		const _problems = [];
		if ( Object.hasOwn( move, 'price' ) && !Catalog.amount( move.price ) ) { _problems.push( 'price must be a number of at least 0' ); }
		if ( move.humanMinutes !== undefined && !Catalog.amount( move.humanMinutes ) ) { _problems.push( 'humanMinutes must be a number of at least 0' ); }
		if ( Object.hasOwn( move, 'params' ) && !Catalog.object( move.params ) ) {
			_problems.push( 'params must be an object of typed parameters' );
		} else if ( Catalog.object( move.params ) && Object.values( move.params ).some( param => !Catalog.object( param ) ) ) {
			_problems.push( 'every parameter in params must be an object with its type' );
		}
		return _problems;
	}

	static amount( value ) {
		return typeof value === 'number' && Number.isFinite( value ) && value >= 0;
	}

	// 10.4: labels are those of the paper; a model always inherits the labels of its inputs (only trusted code may clean).
	static labels( move ) {
		const _problems = [];
		const _known = list => Array.isArray( list ) && list.every( label => Flow.LABELS.includes( label ) );
		if ( move.labels !== undefined && !_known( move.labels ) ) { _problems.push( `labels must be a list of ${Flow.LABELS.join( ', ' )}` ); }
		const _fields = move.fieldLabels;
		if ( _fields !== undefined && !( Catalog.object( _fields ) && Object.values( _fields ).every( _known ) ) ) {
			_problems.push( `fieldLabels must name for each field a list of ${Flow.LABELS.join( ', ' )}` );
		}
		if ( move.executor === 'ai' && move.inherit !== true ) { _problems.push( 'a model step must inherit the labels of its inputs (inherit: true, 10.4)' ); }
		return _problems;
	}

} );
