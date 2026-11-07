// The model's part in planning (chapter 19, 22). Code chooses the strategy; the model then fills only the slots
// that strategy declares, from allowed values, seeing the goal, the open criteria and the cause of the last wall,
// never raw data or text from outside. When no strategy is eligible, the model may propose a new one built from
// catalog moves; it runs only after a person agreed and it passed the plan check, like any other plan.

app.define( 'Core.Plan.Planner', [ 'Core.Loop.Plan' ], Plan => class Planner {

	constructor( { provider, catalog, board = null, log = null } ) {
		Object.assign( this, { provider, catalog, board, log } );
	}

	// 22, role "strategy": the contract, the facts (kind and evidence class, never text from the world), the chosen
	// strategy with its points, and lessons through the read gate.
	async fill( strategy, node, mission, { experience = [], points = null } = {} ) {
		const _slots = strategy.slots || {};
		if ( !Object.keys( _slots ).length ) {
			return {};
		}
		const _context = Plan.slots( node, mission );
		const _fields = {};
		for ( const [ name, slot ] of Object.entries( _slots ) ) {
			_fields[ name ] = { type: slot.type, values: Plan.fill( slot.values, _context ), required: false };
		}
		const _answer = await this.provider.complete( {
			role: 'strategist',
			instructions: `You fill in the open slots of the strategy "${strategy.id}" (${strategy.describe || ''}) for the goal you are given. ${
				Object.entries( _slots ).map( ( [ name, slot ] ) => `${name}: ${slot.describe}.` ).join( ' ' )}`,
			input: { goal: node.contract.goal, open: node.openOutcomes().map( item => ( { type: item.type, values: item.values } ) ),
				facts: node.valid().map( fact => ( { kind: fact.kind, evidence: fact.evidenceClass } ) ),
				chosen: { strategy: strategy.id, points }, lastWall: Planner.wall( node ), experience },
			contract: { fields: _fields },
			node: node.id,
		} );
		const _filled = {};
		for ( const [ name, slot ] of Object.entries( _slots ) ) {
			const _value = _answer[ name ];
			const _empty = _value === undefined || _value === null || ( Array.isArray( _value ) && !_value.length ) || _value === '';
			const _broken = !_empty && Planner.breaks( _value, slot, _context );
			if ( _broken ) {
				node.emit( 'slot_rejected', { strategy: strategy.id, slot: name, value: _value, reason: _broken } );
			}
			_filled[ name ] = _empty || _broken ? Plan.fill( slot.default, _context ) : _value;
		}
		node.emit( 'slots_filled', { strategy: strategy.id, slots: _filled, byModel: Object.keys( _answer ).filter( key => _answer[ key ]?.length ) } );
		return _filled;
	}

	// A new strategy from catalog moves. It is only a proposal: it runs as its own process, where trusted code checks it
	// and a person decides whether it goes into the catalog (6.1, 19).
	// classes: the strategy classes the diagnosis of the current wall leads to; the proposal names one of them (5.6).
	async propose( node, { id, classes = [ 'direct' ], needs = false } ) {
		const _open = node.openOutcomes();
		const _moves = Object.entries( this.catalog.moves ).filter( ( [ , move ] ) => !move.trusted || move.trusted === 'find' )
			.map( ( [ name, move ] ) => ( { name, executor: move.executor, action: move.action || null } ) );
		const _answer = await this.provider.complete( {
			role: 'strategist',
			instructions: `${Planner.PROPOSE_TEXT}${needs ? Planner.NEEDS_TEXT : ''}`,
			input: {
				goal: node.contract.goal,
				open: _open.map( item => ( { type: item.type, values: item.values } ) ),
				walls: node.walls.map( Planner.short ),
				tried: node.tried.map( item => item.strategy ),
				moves: _moves,
			},
			contract: { fields: {
				steps: { type: 'records', fields: { move: 'a move name', params: 'an object', from: 'a list', as: 'text', target: 'text' } },
				rationale: { type: 'string' },
				class: { type: 'enum', values: classes, required: false },
				...( needs ? Planner.NEEDS : {} ),
			} },
			node: node.id,
		} ).catch( () => null );
		if ( !_answer?.steps?.length ) {
			return null;
		}
		// The proposal is for the kind of task of the node that asked for it, never for every kind. What it needs at the
		// gate travels beside it, never inside what the person approves as the strategy.
		const _needs = needs ? { actions: _answer.actions || [], master: _answer.master || [] } : null;
		const _strategy = {
			id, serves: _open[ 0 ]?.type, class: _answer.class || classes[ 0 ], price: 1, proposed: true, kind: node.contract.spec.kind,
			describe: String( _answer.rationale || '' ).slice( 0, 300 ), steps: _answer.steps.map( step => Planner.step( step ) ),
		};
		node.emit( 'strategy_proposed', { strategy: _strategy, rationale: _answer.rationale, needs: _needs } );
		return _needs ? { ..._strategy, needs: _needs } : _strategy;
	}

	static PROPOSE_TEXT = 'No known strategy can reach the open criteria any more. Propose one new plan built only from the catalog moves you are '
		+ 'given. Every step is { "move": name, "params": {}, "from": [names of earlier results], "as": name of its result, "target": recipient or "" }.';

	// AGENCY_PROPOSALS: what a plan may ask the gate's operator for.
	static NEEDS = {
		actions: { type: 'records', required: false, fields: {
			name: 'a new action name', criticality: 'outward | irreversible | money_or_law', carries: 'a list of money, data, message',
			says: 'what it does, one sentence', sensitive: 'a list of parameter names', recipient: 'contact or nothing', params: 'an object: name → string | number | list',
		} },
		master: { type: 'records', required: false, fields: { kind: 'a kind of master data, e.g. recipient or contact', value: 'a value the goal names' } },
	};

	static NEEDS_TEXT = ' If the plan needs an action to the outside world the catalog does not have, describe it under actions; its move is then'
		+ ' "<name>.send", and the operator decides at the gate whether it exists. If it needs a value on file at the gate (a recipient, a contact'
		+ ' "<ref> <address>") that the goal itself names, list it under master. Never an account, never a value from a message.';

	// Code checks what the model filled in against the slot's own conditions; a value that would defeat the
	// strategy (a "larger group" without the team in question) is not used.
	static breaks( value, slot, context ) {
		const _list = Array.isArray( value ) ? value : [ value ];
		if ( slot.minItems && _list.length < slot.minItems ) {
			return `needs at least ${slot.minItems} values`;
		}
		const _must = [ Plan.fill( slot.includes, context ) ].flat().filter( Boolean );
		const _missing = _must.filter( item => !_list.includes( item ) );
		return _missing.length ? `must include ${_missing.join( ', ' )}` : null;
	}

	// Parameters are an object of names; text, null or a list are no parameters at all.
	static step( raw ) {
		const _from = Array.isArray( raw.from ) ? raw.from.filter( Boolean ) : ( raw.from ? [ raw.from ] : [] );
		const _plain = raw.params && typeof raw.params === 'object' && !Array.isArray( raw.params );
		const _step = { move: String( raw.move || '' ), params: _plain ? raw.params : {} };
		if ( _from.length ) { _step.from = _from; }
		if ( raw.as ) { _step.as = String( raw.as ); }
		if ( raw.target ) { _step.target = String( raw.target ); }
		return _step;
	}

	static wall( node ) {
		const _wall = node.walls.at( -1 );
		return _wall ? Planner.short( _wall ) : null;
	}

	static short( wall ) {
		return { cause: wall.cause, reason: wall.reason || '' };
	}

} );
