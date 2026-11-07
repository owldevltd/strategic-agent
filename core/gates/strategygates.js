// Strategy gates (chapters 7.3, 21): instances of fixed rule templates, kept as data. The agent sets them for a new
// kind of task and may add or tighten them later, never remove or loosen them; a system gate compares before and
// after. Only a person can lift one (the ticket "check the gates" when they paralyse a goal). Every instance has a
// scope (the kind of task) and an expiry.
//   precondition  a criterion of a catalog type must hold before a move runs; a move it blocks is a wall that names
//                 the precondition, so the judgment may make it a child (U2)
//   restrict      a parameter of a move may only take some values, or stay within a bound (checked at G2)
//   order         a move may only run after another one in the same plan (checked at G2)

app.define( 'Core.Gates.StrategyGates', [ 'Lib.Hash', 'Core.Loop.Plan' ], ( Hash, Plan ) => class StrategyGates {

	static TEMPLATES = {
		precondition: [ 'move', 'criterion' ],
		restrict: [ 'move', 'param' ],
		order: [ 'before', 'after' ],
	};

	static DAYS = 180;

	constructor( db, { log = null, now = () => Date.now() } = {} ) {
		Object.assign( this, { db, log, now } );
		this.db.exec( `CREATE TABLE IF NOT EXISTS strategy_gates (
			id TEXT PRIMARY KEY, rule TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, scope TEXT NOT NULL, expires TEXT NOT NULL,
			by TEXT NOT NULL, status TEXT NOT NULL, time TEXT NOT NULL
		)` );
	}

	// The instances in force for a kind of task now.
	active( scope ) {
		const _now = new Date( this.now() ).toISOString();
		const _rows = this.db.all( `SELECT * FROM strategy_gates WHERE status = 'active' AND ( scope = :scope OR scope = '*' )
			AND expires > :now ORDER BY time`, { scope, now: _now } );
		return _rows.map( row => ( { ...JSON.parse( row.data ), id: row.id, scope: row.scope, expires: row.expires, by: row.by } ) );
	}

	has( scope ) {
		return this.active( scope ).length > 0;
	}

	// The agent adds an instance or tightens one; the system gate compares it with what is in force. → { ok, problems, id }
	// strategies: the strategies of the kind of task; an order no strategy keeps would paralyse every goal from the start.
	propose( instance, { scope, by = 'agent', registry = null, catalog = null, strategies = null } ) {
		const _rule = { ...instance, expires: instance.expires || new Date( this.now() + StrategyGates.DAYS * 86400000 ).toISOString() };
		const _problems = StrategyGates.schema( _rule, registry, this.now() );
		// An instance is about moves of the catalog; one that names none of them would never hold anything.
		const _moves = [ _rule.move, _rule.before, _rule.after ].filter( Boolean );
		if ( catalog ) { _problems.push( ..._moves.filter( name => !catalog.get( name ) ).map( name => `${name} is not a move of the catalog` ) ); }
		// A restriction is about a parameter the move really has, or its recipient (target); a model's "to" or
		// "recipient" for the recipient means the target.
		if ( catalog && _rule.rule === 'restrict' && catalog.get( _rule.move ) ) {
			_rule.param = StrategyGates.param( _rule, catalog.get( _rule.move ) );
			if ( !_rule.param ) { _problems.push( `${instance.param} is no parameter of ${_rule.move}` ); }
		}
		const _mine = strategies ? strategies.filter( item => !item.kind || item.kind === scope ) : null;
		if ( _mine && _rule.rule === 'order' ) { _problems.push( ...StrategyGates.paralyses( _rule, _mine ) ); }
		if ( _mine && _rule.rule === 'precondition' ) { _problems.push( ...StrategyGates.waitsForItself( _rule, _mine ) ); }
		const _key = StrategyGates.key( _rule );
		// The new instance must be at least as strict as every instance in force on the same thing. An instance for every
		// kind ('*') stays in force for the other kinds; only one of this kind is replaced.
		const _matching = _problems.length ? [] : this.active( scope ).filter( item => StrategyGates.key( item ) === _key );
		_matching.forEach( item => _problems.push( ...StrategyGates.looser( _rule, item, registry ) ) );
		const _before = _matching.at( -1 ) || null;
		const _retire = _matching.filter( item => item.scope === scope );
		if ( _problems.length ) {
			this.log?.append( 'strategy_gate_refused', { rule: _rule.rule, scope, by, problems: _problems } );
			return { ok: false, problems: _problems };
		}
		const _id = Hash.id( 'sg' );
		const _data = Object.fromEntries( Object.entries( _rule ).filter( ( [ name ] ) => ![ 'id', 'scope', 'by' ].includes( name ) ) );
		this.db.transaction( () => {
			_retire.forEach( item => this.db.run( 'UPDATE strategy_gates SET status = \'tightened\' WHERE id = :id', { id: item.id } ) );
			this.db.run( `INSERT INTO strategy_gates ( id, rule, key, data, scope, expires, by, status, time )
				VALUES ( :id, :rule, :key, :data, :scope, :expires, :by, 'active', :at )`, {
				id: _id, rule: _rule.rule, key: _key, data: JSON.stringify( _data ), scope, expires: _rule.expires, by,
				at: new Date( this.now() ).toISOString(),
			} );
		} );
		this.log?.append( _before ? 'strategy_gate_tightened' : 'strategy_gate_added', { id: _id, rule: _rule.rule, scope, by, replaces: _retire[ 0 ]?.id || null } );
		return { ok: true, problems: [], id: _id };
	}

	// Only a person lifts an instance; the agent never can, however it spells itself ("Agent", "agent-2"), and nobody
	// unnamed can either.
	lift( id, { by } = {} ) {
		const _who = typeof by === 'string' ? by.trim().toLowerCase() : '';
		if ( !_who || _who.startsWith( 'agent' ) ) { return false; }
		const _done = this.db.run( 'UPDATE strategy_gates SET status = \'lifted\' WHERE id = :id AND status = \'active\'', { id } ).changes > 0;
		if ( _done ) { this.log?.append( 'strategy_gate_lifted', { id, by } ); }
		return _done;
	}

	// An order that every strategy using the later move breaks leaves no way at all: paralysis from the start (21).
	static paralyses( rule, strategies ) {
		const _moves = strategy => ( strategy.steps || [] ).map( step => step.move );
		const _using = strategies.filter( strategy => _moves( strategy ).includes( rule.after ) );
		const _kept = strategy => _moves( strategy ).slice( 0, _moves( strategy ).indexOf( rule.after ) ).includes( rule.before );
		return _using.length && !_using.some( _kept ) ? [ `no strategy of this kind runs ${rule.after} after ${rule.before}; the gate would paralyse it from the start` ] : [];
	}

	// A precondition only the blocked move can bring about never holds: every way to it runs that move, so the gate would
	// wait for itself, a cycle like the one R4 refuses in the wait graph ("write code only once its tests are green").
	static waitsForItself( rule, strategies ) {
		const _serving = strategies.filter( strategy => strategy.serves === rule.criterion?.type );
		const _uses = strategy => ( strategy.steps || [] ).some( step => step.move === rule.move );
		return _serving.length && _serving.every( _uses )
			? [ `every strategy that reaches ${rule.criterion.type} runs ${rule.move}; the gate would wait for itself (R4)` ] : [];
	}

	// What an instance is about, with its template: two instances of different templates never replace each other.
	static key( rule ) {
		const _about = { precondition: `${rule.move}|${rule.criterion?.type}`, restrict: `${rule.move}|${rule.param}`, order: `${rule.before}|${rule.after}` };
		return Object.hasOwn( _about, rule.rule ) ? `${rule.rule}:${_about[ rule.rule ]}` : null;
	}

	static schema( rule, registry, now ) {
		const _fields = Object.hasOwn( StrategyGates.TEMPLATES, rule.rule ) ? StrategyGates.TEMPLATES[ rule.rule ] : null;
		if ( !_fields ) { return [ `${rule.rule} is not a rule template` ]; }
		const _problems = _fields.filter( field => !rule[ field ] ).map( field => `${rule.rule} needs ${field}` );
		if ( Number.isNaN( Date.parse( rule.expires ) ) || Date.parse( rule.expires ) <= now ) { _problems.push( 'an instance needs an expiry in the future' ); }
		if ( rule.rule === 'precondition' && registry && !registry.has( rule.criterion?.type ) ) { _problems.push( `${rule.criterion?.type} is no criterion type` ); }
		if ( rule.rule === 'restrict' && !Array.isArray( rule.allowed ) && rule.max === undefined && rule.min === undefined ) {
			_problems.push( 'restrict needs allowed values or a bound' );
		}
		return _problems;
	}

	// The system gate: is the new instance at least as strict as the one in force?
	static looser( rule, before, registry ) {
		const _problems = Date.parse( rule.expires ) < Date.parse( before.expires ) ? [ 'it would end earlier than the instance in force' ] : [];
		if ( rule.rule === 'restrict' ) {
			if ( before.allowed && !rule.allowed ) { _problems.push( 'it would drop the allowed values' ); }
			if ( before.allowed && !( rule.allowed || [] ).every( value => before.allowed.includes( value ) ) ) { _problems.push( 'it would allow more values' ); }
			if ( before.max !== undefined && !( rule.max <= before.max ) ) { _problems.push( 'it would raise or drop the upper bound' ); }
			if ( before.min !== undefined && !( rule.min >= before.min ) ) { _problems.push( 'it would lower or drop the lower bound' ); }
		}
		if ( rule.rule === 'precondition' && registry ) {
			const _new = registry.create( { id: 'new', ...rule.criterion } );
			const _old = registry.create( { id: 'old', ...before.criterion } );
			if ( !_new?.atLeastAsStrict( _old ) ) { _problems.push( 'the precondition would be weaker' ); }
		}
		return _problems.map( problem => `${problem} (gate ${before.id}); the agent may only tighten (21)` );
	}

	// The parameter a restrict instance holds: one the move declares, or "target", the recipient of its action.
	static param( rule, move ) {
		const _declared = [ ...Object.keys( move.params && typeof move.params === 'object' ? move.params : {} ), move.param ].filter( Boolean );
		if ( typeof rule.param !== 'string' ) { return null; }
		if ( _declared.includes( rule.param ) ) { return rule.param; }
		return [ 'target', 'to', 'recipient' ].includes( rule.param ) && move.action ? 'target' : null;
	}

	// G2: restrict and order on a resolved plan. Each problem names its instance.
	static plan( plan, gates ) {
		const _problems = [];
		plan.steps.forEach( ( step, index ) => {
			for ( const gate of gates.filter( item => item.rule === 'restrict' && item.move === step.move ) ) {
				// A step that leaves the parameter out is outside the gate as well: what it would do cannot be held against
				// the instance (fail closed). Only the step's own parameters count, never a name of Object.prototype.
				const _given = Boolean( step.params ) && typeof step.params === 'object' && Object.hasOwn( step.params, gate.param );
				const _value = _given ? step.params[ gate.param ] : gate.param === 'target' ? step.target ?? undefined : undefined;
				const _values = _value === undefined ? [] : [].concat( _value );
				const _listed = item => gate.allowed.includes( item );
				const _outside = _value === undefined || ( gate.allowed && !_values.every( _listed ) );
				// A bound holds only for numbers inside it: text, NaN, a list or an object is outside.
				const _number = item => typeof item === 'number' || ( typeof item === 'string' && item.trim() !== '' );
				const _above = gate.max !== undefined && _values.some( item => !_number( item ) || !( Number( item ) <= gate.max ) );
				const _below = gate.min !== undefined && _values.some( item => !_number( item ) || !( Number( item ) >= gate.min ) );
				const _off = _outside || _above || _below;
				if ( _off ) { _problems.push( `${step.move}: ${gate.param} is outside what the strategy gate allows (gate ${gate.id})` ); }
			}
			for ( const gate of gates.filter( item => item.rule === 'order' && item.after === step.move ) ) {
				if ( !plan.steps.slice( 0, index ).some( earlier => earlier.move === gate.before ) ) {
					_problems.push( `${step.move} may only run after ${gate.before} (gate ${gate.id})` );
				}
			}
		} );
		return _problems;
	}

	// Before a move runs: the first precondition instance for it that the node's facts do not meet, as a precondition
	// with an id (16.4). A precondition a child has met counts while its evidence is valid (B2, R7).
	blocking( step, node, scope, registry ) {
		for ( const gate of this.active( scope ).filter( item => item.rule === 'precondition' && item.move === step.move ) ) {
			const _values = Plan.fill( gate.criterion.values || {}, { ...( step.params || {} ), target: step.target } );
			const _criterion = registry.create( { id: `gate-${gate.id}`, type: gate.criterion.type, values: _values } );
			const _facts = node.valid();
			const _met = _criterion.check( _facts ).met || _facts.some( fact => fact.kind === 'precondition_met' && fact.data?.id === _criterion.id );
			if ( !_met ) { return { gate, precondition: { id: _criterion.id, type: _criterion.type, values: _values } }; }
		}
		return null;
	}

} );
