// Turns a strategy from the catalog into a concrete plan for one node: placeholders like {{focus}} are filled
// from the mission parameters and from the values of the node's criteria. An AI planner can later fill the same
// slots; the result passes the same plan check either way.

app.define( 'Core.Loop.Plan', [], () => class Plan {

	// Everything a placeholder may name: mission parameters, the values of the node's criteria and, for a child,
	// its own item (the precondition it serves) as {{item}}. A criterion fills only the parameters its type declares:
	// a value G1 would refuse never shadows a mission parameter, even in a contract that did not pass G1 (3.2).
	static slots( node, mission, extra = {} ) {
		const _slots = { ...mission.params };
		for ( const item of node.contract.criteria ) {
			const _declared = item.constructor?.PARAMS || {};
			for ( const [ name, value ] of Object.entries( item.values || {} ) ) {
				if ( Object.hasOwn( _declared, name ) ) { _slots[ name ] = value; }
			}
		}
		if ( node.contract.serves?.precondition ) {
			_slots.item = node.contract.serves.precondition;
		}
		// A new case from outside: what the extraction read from the message (8.1), e.g. the sender and the teams.
		Object.assign( _slots, node.contract.spec.scope || {} );
		const _byPerson = node.openOutcomes().find( item => item.byPerson );
		if ( _byPerson ) {
			_slots.byPerson = _byPerson.id;
			_slots.byPersonQuestion = `Is this fulfilled: ${_byPerson.type} ${JSON.stringify( _byPerson.values )}? (goal: ${node.contract.goal})`;
		}
		return Object.assign( _slots, extra );
	}

	// {{name}} or {{name|filter}}: subject (the part after the colon of "answers:design"), first (of a list).
	static value( slots, expression ) {
		const [ _name, _filter ] = expression.split( '|' );
		// Only the slots' own names: never a name of Object.prototype (__proto__, constructor, toString).
		const _value = Object.hasOwn( slots, _name ) ? slots[ _name ] : undefined;
		if ( _filter === 'subject' ) { return String( _value ?? '' ).split( ':' ).slice( 1 ).join( ':' ); }
		if ( _filter === 'first' ) { return Array.isArray( _value ) ? _value[ 0 ] : _value; }
		return _value;
	}

	static fill( value, slots ) {
		if ( typeof value === 'string' ) {
			const _whole = value.match( /^\{\{([\w|]+)\}\}$/ );
			if ( _whole ) { return Plan.value( slots, _whole[ 1 ] ); }
			return value.replace( /\{\{([\w|]+)\}\}/g, ( _all, name ) => Plan.value( slots, name ) ?? '' );
		}
		if ( Array.isArray( value ) ) { return value.map( item => Plan.fill( item, slots ) ); }
		if ( value && typeof value === 'object' ) {
			return Object.fromEntries( Object.entries( value ).map( ( [ key, item ] ) => [ key, Plan.fill( item, slots ) ] ) );
		}
		return value;
	}

	// The declared default of each slot, used when no model fills it.
	static defaults( strategy, node, mission ) {
		const _context = Plan.slots( node, mission );
		const _slots = Object.entries( strategy.slots || {} );
		return Object.fromEntries( _slots.map( ( [ name, slot ] ) => [ name, Plan.fill( slot.default, _context ) ] ) );
	}

	static resolve( strategy, node, mission, extra = {} ) {
		const _slots = Plan.slots( node, mission, extra );
		const _fill = value => Plan.fill( value, _slots );
		// A step with forEach runs once per item; {{item}} names the current one. An item the node already settled (a
		// valid item_resolved fact, e.g. a paid invoice) gets no step again in a later attempt.
		const _settled = new Set( ( node.valid ? node.valid() : node.facts || [] )
			.filter( fact => fact.kind === 'item_resolved' && fact.data?.item !== undefined ).map( fact => String( fact.data.item ).trim() ) );
		const _expanded = strategy.steps.flatMap( ( step ) => {
			if ( !step.forEach ) { return [ step ]; }
			const { forEach, ...one } = step;
			return [].concat( _fill( forEach ) ?? [] ).filter( item => !_settled.has( String( item ).trim() ) )
				.map( item => Plan.substitute( { ...one, item }, item ) );
		} );
		const _steps = _expanded.map( step => ( {
			...step,
			params: Plan.compact( _fill( step.params || {} ) ),
			target: _fill( step.target ),
		} ) );
		return { strategy: strategy.id, contract: node.contract.hash, steps: _steps };
	}

	// {{item}} is replaced inside the strings of a step or a template, never in its JSON text: an item (an invoice id
	// from the data) can only ever become a value, never a field, a move or a target of its own.
	static substitute( value, item ) {
		if ( typeof value === 'string' ) {
			return value.replace( /\{\{item\}\}/g, () => String( item ) );
		}
		if ( Array.isArray( value ) ) { return value.map( entry => Plan.substitute( entry, item ) ); }
		if ( value && typeof value === 'object' ) {
			return Object.fromEntries( Object.entries( value ).map( ( [ key, entry ] ) => [ key, Plan.substitute( entry, item ) ] ) );
		}
		return value;
	}

	// Slots without a value are left out instead of being sent as empty.
	static compact( params ) {
		return Object.fromEntries( Object.entries( params ).filter( ( [ , value ] ) => value !== undefined && value !== '' ) );
	}

} );
