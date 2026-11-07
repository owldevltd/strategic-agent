// The table of outgoing actions (catalog/actions.json): their criticality (5.3), what they carry and which of their
// parameters are sensitive (6.2, 10.4). Core and gate read the same file; the gate keeps its own copy from its
// start and never takes one from the core. Rules name actions by name or by class, so a criterion never needs to
// know the actions of a particular mission: 'payment', 'carries:money', 'outward' or '*'.

app.define( 'Lib.Actions', [ 'Lib.Missions' ], Missions => class Actions {

	static LEVELS = [ 'read', 'internal', 'outward', 'irreversible', 'money_or_law' ];
	static FILE = 'catalog/actions.json';
	static NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

	// The catalog's table, plus the actions the missions bring (actions.json in a mission's folder) and those an operator
	// approved at the gate in this process (learn).
	static load( file = Actions.FILE ) {
		const _path = app.lib( 'node:path' ).join( app.root, file );
		const _table = JSON.parse( app.lib( 'node:fs' ).readFileSync( _path, 'utf8' ) );
		if ( file !== Actions.FILE ) { return new Actions( _table ); }
		const _merged = Actions.merged( _table );
		for ( const [ name, entry ] of Actions.#learned ) {
			if ( !Object.hasOwn( _merged, name ) ) { _merged[ name ] = entry; }
		}
		return new Actions( _merged );
	}

	// Actions an operator approved at the gate (Gate.Proposals), known to this process from then on. The same hard rules
	// hold as for a proposal (proposable); a name the files have is never replaced. → the names learned.
	static #learned = new Map();

	static learn( table ) {
		const _known = Actions.load();
		const _names = [];
		for ( const [ name, entry ] of Object.entries( table && typeof table === 'object' ? table : {} ) ) {
			if ( Actions.#learned.has( name ) ) { continue; }
			const _problems = Actions.proposable( name, entry, _known );
			if ( _problems.length ) { throw new Error( `the action ${String( name ).slice( 0, 40 )} cannot be learned: ${_problems.join( '; ' )}` ); }
			Actions.#learned.set( name, structuredClone( entry ) );
			_names.push( name );
		}
		return _names;
	}

	static forget( name ) {
		return Actions.#learned.delete( name );
	}

	static learned() {
		return Object.fromEntries( [ ...Actions.#learned ].map( ( [ name, entry ] ) => [ name, structuredClone( entry ) ] ) );
	}

	// What an action that someone other than the operator's files proposes must be (Gate.Proposals): a new name, at least
	// outward (it goes through the gate and a person's approval of each use), money only as money_or_law, a text that
	// says what it does, and nothing the table does not know. → the problems; none: it may be proposed.
	static PROPOSABLE = [ 'criticality', 'carries', 'sensitive', 'says', 'recipient', 'inside', 'idempotencyH', 'commits', 'params' ];
	static CARRIES = [ 'money', 'data', 'message' ];

	static proposable( name, entry, known = Actions.load() ) {
		if ( typeof name !== 'string' || !Actions.NAME.test( name ) || name in Object.prototype ) { return [ 'the name is no action\'s name' ]; }
		if ( known.entry( name ) ) { return [ `the action ${name} exists already` ]; }
		if ( !entry || typeof entry !== 'object' || Array.isArray( entry ) ) { return [ 'the action is no object' ]; }
		const _foreign = Object.keys( entry ).filter( key => !Actions.PROPOSABLE.includes( key ) )
			.map( key => `${key.slice( 0, 40 )} is no field of an action` );
		return [ ..._foreign, ...Actions.RULES.filter( ( [ holds ] ) => !holds( entry ) ).map( ( [ , says ] ) => says ) ];
	}

	static #names = value => Array.isArray( value ) && value.every( item => typeof item === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test( item ) );

	// Each rule of a proposed action: [ holds( entry ), what it says when it does not ].
	static RULES = [
		[ entry => Actions.LEVELS.indexOf( entry.criticality ) >= Actions.LEVELS.indexOf( 'outward' ),
			'a proposed action is at least outward (outward, irreversible or money_or_law)' ],
		[ entry => Array.isArray( entry.carries ) && entry.carries.every( item => Actions.CARRIES.includes( item ) ), 'carries is a list of money, data, message' ],
		[ entry => !( Array.isArray( entry.carries ) && entry.carries.includes( 'money' ) ) || entry.criticality === 'money_or_law',
			'an action that carries money is money_or_law' ],
		[ entry => entry.sensitive === undefined || Actions.#names( entry.sensitive ), 'sensitive is a list of parameter names' ],
		[ entry => typeof entry.says === 'string' && entry.says.trim() !== '' && entry.says.length <= 200, 'says what the action does, in at most 200 characters' ],
		[ entry => entry.recipient === undefined || Actions.RECIPIENTS.includes( entry.recipient ), 'recipient is contact' ],
		[ entry => entry.inside === undefined || ( typeof entry.inside === 'boolean' && Array.isArray( entry.carries ) && entry.carries.includes( 'message' ) ),
			'inside is true or false, for an action that carries a message' ],
		[ entry => entry.idempotencyH === undefined
			|| ( Number.isFinite( entry.idempotencyH ) && entry.idempotencyH >= 0 && entry.idempotencyH <= 720 ),
		'idempotencyH is a number of hours from 0 to 720' ],
		[ entry => entry.commits === undefined || ( typeof entry.commits === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test( entry.commits ) ), 'commits is a plain name' ],
		[ entry => entry.params === undefined || ( Boolean( entry.params ) && typeof entry.params === 'object' && !Array.isArray( entry.params )
			&& Object.entries( entry.params ).every( ( [ key, type ] ) => Actions.#names( [ key ] ) && [ 'string', 'number', 'list' ].includes( type ) ) ),
		'params maps parameter names to string, number or list' ],
	];

	// A mission adds actions of its own (a refund, a deployment); it never changes one the catalog or another mission
	// defines, and a name it cannot have is refused: the table would otherwise depend on which file was read last.
	static merged( base, files = Missions.files( 'actions.json' ) ) {
		Object.entries( base ).forEach( ( [ name, entry ] ) => Actions._money( 'the catalog', name, entry ) );
		const _table = { ...base };
		for ( const { id, value } of files ) {
			if ( !value || typeof value !== 'object' || Array.isArray( value ) ) { throw new TypeError( `mission ${id}: actions.json is no object` ); }
			for ( const [ name, entry ] of Object.entries( value ) ) {
				// A name every object inherits (constructor, toString) is no action, whatever its spelling allows.
				if ( !Actions.NAME.test( name ) || name in Object.prototype ) { throw new Error( `mission ${id}: ${name.slice( 0, 40 )} is no name for an action` ); }
				if ( Object.hasOwn( _table, name ) ) { throw new Error( `mission ${id}: the action ${name} is defined already` ); }
				// A recipient type the gate does not know would check nothing while looking like a rule (fail closed).
				if ( entry && typeof entry === 'object' && Object.hasOwn( entry, 'recipient' ) && !Actions.RECIPIENTS.includes( entry.recipient ) ) {
					throw new Error( `mission ${id}: the action ${name} names the recipient type ${String( entry.recipient ).slice( 0, 40 )}, which the gate does not know` );
				}
				Actions._money( `mission ${id}`, name, entry );
				_table[ name ] = entry;
			}
		}
		return _table;
	}

	// 5.3: what moves money has money criticality: a person approves it with a reason, and no table can make it less.
	static _money( where, name, entry ) {
		const _carries = entry && typeof entry === 'object' && Array.isArray( entry.carries ) ? entry.carries : [];
		if ( _carries.includes( 'money' ) && entry.criticality !== 'money_or_law' ) {
			throw new Error( `${where}: the action ${name} carries money, so its criticality is money_or_law, not ${String( entry.criticality ).slice( 0, 40 )}` );
		}
	}

	constructor( table = {} ) {
		this.table = table && typeof table === 'object' ? table : {};
	}

	// Only the table's own entries: a name of Object.prototype is no action.
	entry( action ) {
		return typeof action === 'string' && Object.hasOwn( this.table, action ) ? this.table[ action ] : null;
	}

	known( action ) {
		return Actions.LEVELS.includes( this.entry( action )?.criticality );
	}

	criticality( action ) {
		return this.known( action ) ? this.entry( action ).criticality : null;
	}

	outward( action ) {
		return Actions.LEVELS.indexOf( this.criticality( action ) ) >= Actions.LEVELS.indexOf( 'outward' );
	}

	// 6.2 (the recipient is a contact reference): an action whose recipient is of type contact goes only to a reference the master data
	// holds an address for; the gate resolves it and refuses anything else, a plain address too.
	static RECIPIENTS = [ 'contact' ];

	toContact( action ) {
		return this.entry( action )?.recipient === 'contact';
	}

	// 7.3: a message that leaves the company (a reply to a customer, a reminder to a supplier). An action that carries a
	// message goes outside unless the table says it stays inside ("inside": true, a report to HR, an invitation to a
	// team): when nothing is said, the stricter rules hold.
	outside( action ) {
		return this.matches( 'carries:message', action ) && this.entry( action ).inside !== true;
	}

	needsPerson( action ) {
		return this.outward( action );
	}

	// What the person has to give together with an approval.
	requires( action ) {
		const _level = this.criticality( action );
		return { reason: _level === 'money_or_law', explicit: _level === 'irreversible' };
	}

	// A copy: whoever asks can never shorten the list the gate checks.
	sensitive( action ) {
		const _list = this.entry( action )?.sensitive;
		return Array.isArray( _list ) ? [ ..._list ] : [];
	}

	matches( selector, action ) {
		if ( typeof selector !== 'string' ) { return false; }
		if ( selector === '*' || selector === action ) { return true; }
		if ( selector === 'outward' ) { return this.outward( action ); }
		const [ _key, _value ] = selector.split( ':' );
		const _carries = this.entry( action )?.carries;
		return _key === 'carries' && Array.isArray( _carries ) && _carries.includes( _value );
	}

	// selectors: a list, or one selector; nothing given stands for every action.
	applies( selectors, action ) {
		const _list = selectors === undefined || selectors === null ? [ '*' ] : [].concat( selectors );
		return _list.some( selector => this.matches( selector, action ) );
	}

	// Every action a selector stands for, e.g. to tell a person what a rule covers.
	expand( selector ) {
		return Object.keys( this.table ).filter( action => this.matches( selector, action ) );
	}

} );
