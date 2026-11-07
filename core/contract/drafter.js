// Manifestation at G1 (chapter 3.2), steps 1 to 4. A model turns a task in words into criteria of the catalog's
// types; code adds the invariants the catalog prescribes for this kind of process, checks schema, consistency
// (K1–K8) and feasibility, and gives the model one chance to repair. What comes out is a draft with a
// back-translation and a list of what is not covered; a person confirms it at the gate (step 5), and the hash
// freezes it (step 6).

app.define( 'Core.Contract.Drafter', [ 'Core.Contract.Contract', 'Core.Check.ContractCheck', 'Core.Move.Catalog' ],
	( Contract, ContractCheck, Catalog ) => class Drafter {

		static INSTRUCTIONS = [
			'You turn a task from a person into a goal contract. Use only criterion types from the catalog you are given.',
			'outcomes: what must be true in the world when the task is done (outcome types). rules: limits the person states explicitly (invariant types).',
			'strategyGates: rules you consider necessary for this kind of task, about the moves you are given, as instances of the rule templates: { "rule": "precondition",',
			'"move": a move, "criterion": { "type", "values" } } (it must hold before the move runs), { "rule": "restrict", "move", "param",',
			'"allowed": [values] or "max"/"min" } (param is one of the move\'s parameters, or "target" for the recipient of an action), or',
			'{ "rule": "order", "before": a move, "after": a move }. They may only make things stricter.',
			'backTranslation: one or two sentences, "You want ...", so the person can check you understood. notCovered: what the task does not include.',
			'coverage: for every sentence of your goal, the sentence and the indexes (k1, k2, ... in the order outcomes then rules) of the criteria that cover it;',
			'a sentence no criterion covers belongs into notCovered. soft: wishes that are not measurable, e.g. "friendly tone", as short texts.',
			'deadlineHours: the time the person gives, in hours; never write a deadline criterion. Every criterion is { "type": ..., "values": { ... } }',
			'with exactly the parameters its catalog entry lists. Do not repeat the rules that are added automatically.',
			'Outcomes use only types the catalog marks achievable for this kind of task, with values that match their pattern;',
			'what cannot be said that way is not an outcome: put it into soft, or into notCovered. For a kind of task the system does',
			'not know yet every outcome type is achievable: choose those that say best what must be true; the system proposes the ways.',
		].join( ' ' );

		static CONTRACT = { fields: {
			goal: { type: 'string' },
			deadlineHours: { type: 'number' },
			outcomes: { type: 'records', fields: { type: 'a criterion type', values: 'an object with its parameters' } },
			rules: { type: 'records', required: false, fields: { type: 'a criterion type', values: 'an object with its parameters' } },
			// Every field of the three rule templates; an instance uses those of its own template (the store checks it).
			strategyGates: { type: 'records', required: false, fields: {
				rule: 'precondition | restrict | order', move: 'a move (precondition, restrict)', criterion: 'an object { type, values } (precondition)',
				param: 'a parameter of the move (restrict)', allowed: 'the values it may take (restrict)', max: 'an upper bound (restrict)',
				min: 'a lower bound (restrict)', before: 'the move that must run first (order)', after: 'the move that may only run after it (order)',
			} },
			backTranslation: { type: 'string' },
			notCovered: { type: 'list' },
			coverage: { type: 'records', required: false, fields: { sentence: 'one sentence of the goal', criteria: 'a list of criterion ids' } },
			soft: { type: 'list', required: false },
		} };

		// The criteria catalog as this kind of task can use it: which outcome types a strategy can achieve, and for which
		// values (feasibility is part of G1; the model sees it up front).
		static catalog( registry, mission ) {
			const _mine = ( mission.strategies || [] ).filter( item => !item.kind || item.kind === mission.kind );
			// A new kind (no strategy of its own yet): every outcome type can be reached once the agent proposed a way.
			const _new = !( mission.strategies || [] ).some( item => item.kind && item.kind === mission.kind );
			return registry.list().map( ( entry ) => {
				if ( entry.kind !== 'outcome' ) { return entry; }
				if ( _new ) { return { ...entry, achievable: true }; }
				const _ways = _mine.filter( item => item.serves === entry.type || ( item.reaches || [] ).includes( entry.type ) );
				const _patterns = _ways.filter( item => item.serves === entry.type ).map( item => item.fits ).filter( Boolean );
				const _open = _ways.some( item => item.serves !== entry.type || !item.fits );
				return { ...entry, achievable: _ways.length > 0, ...( !_open && _patterns.length ? { valuesMatch: _patterns } : {} ) };
			} );
		}

		constructor( { provider, registry, log = null } ) {
			Object.assign( this, { provider, registry, log } );
		}

		async draft( mission, task, { now = Date.now() } = {} ) {
			const _id = `${mission.id}-${now.toString( 36 )}`;
			this.log?.append( 'task_received', { mission: mission.id, task, id: _id } );
			let _problems = null;
			let _contract = null;
			for ( let round = 1; round <= 2; round++ ) {
				const _repair = _problems ? ` Your previous draft was refused: ${_problems.join( '; ' )}. Fix exactly that.` : '';
				const { answer: _answer, refused: _refused } = await this._ask( mission, task, _repair );
				if ( _refused ) {
					this.log?.append( 'draft_checked', { id: _id, round, ok: false, problems: _refused } );
					return { ok: false, problems: _refused };
				}
				const _catalog = Catalog.load( mission );
				const _spec = this._spec( { id: _id, answer: _answer, mission, now, task } );
				// Step 6 binds the spec as JSON writes it: a value JSON cannot carry would hash like another one, so such a
				// draft is refused before anything of it is hashed.
				const _unbound = Drafter.unhashable( _spec ).map( where => `${where}: a value JSON cannot carry, so the hash could not bind it` );
				if ( _unbound.length ) {
					this.log?.append( 'draft_checked', { id: _id, round, ok: false, problems: _unbound } );
					_problems = _unbound;
					_contract = null;
					continue;
				}
				const _drafted = new Contract( _spec, this.registry );
				_contract = ContractCheck.channelled( _drafted, _catalog, this.registry );
				const _mandatory = mission.invariants || [];
				const _known = { now, mandatory: _mandatory, strategies: mission.strategies, catalog: _catalog };
				const _check = new ContractCheck().check( _contract, _known );
				this.log?.append( 'draft_checked', { id: _id, round, ok: _check.ok, problems: _check.problems, contract: _contract.describe() } );
				if ( _check.ok ) {
					// 7.3: the strategy gates the agent proposes for this kind of task; the gate store decides (only stricter).
					const _gates = ( _answer.strategyGates || [] ).filter( item => item && typeof item === 'object' && item.rule );
					return { ok: true, contract: _contract, gates: _gates };
				}
				_problems = _check.problems;
			}
			return { ok: false, problems: _problems, ...( _contract ? { contract: _contract } : {} ) };
		}

		// 22, role "contract draft": the task as the person gives it (with the selection it names, e.g. which invoices) and
		// the criteria catalog; no other data of the world. A model that breaks its step contract twice (the provider's
		// own repair included) has its draft refused; that is an answer, not a crash. → { answer } or { refused }
		async _ask( mission, task, repair ) {
			try {
				return { answer: await this.provider.complete( {
					role: 'contract',
					instructions: Drafter.INSTRUCTIONS + repair,
					input: {
						task: { text: task, given: mission.context || {} }, catalog: Drafter.catalog( this.registry, mission ),
						addedAutomatically: mission.invariants || [], moves: Object.keys( Catalog.load( mission ).moves ),
					},
					contract: Drafter.CONTRACT,
				} ) };
			} catch ( error ) {
				return { refused: [ `the model's answer was refused: ${String( error?.message ?? error ).slice( 0, 2000 )}` ] };
			}
		}

		// The places in a spec that hold no plain JSON value: NaN, ±Infinity, a Date, a function, a symbol, a big
		// integer, undefined or a hole in a list, an object of a class, or a cycle. → a list of paths, empty when JSON carries it all.
		static unhashable( value, where = 'draft', seen = new Set() ) {
			if ( value === null || typeof value === 'string' || typeof value === 'boolean' ) { return []; }
			if ( typeof value === 'number' ) { return Number.isFinite( value ) ? [] : [ where ]; }
			if ( !value || typeof value !== 'object' || seen.has( value ) ) { return [ where ]; }
			const _proto = Object.getPrototypeOf( value );
			if ( !Array.isArray( value ) && _proto !== Object.prototype && _proto !== null ) { return [ where ]; }
			seen.add( value );
			const _entries = Array.isArray( value ) ? Array.from( value, ( item, index ) => [ index, item ] )
				: Object.entries( value ).filter( ( [ , item ] ) => item !== undefined );
			const _found = _entries.flatMap( ( [ key, item ] ) => Drafter.unhashable( item, `${where}.${key}`, seen ) );
			seen.delete( value );
			return _found;
		}

		// Layer 1: the client's outcomes and rules, plus the catalog's invariants for this kind of process. The agent's own
		// rules for this kind of task are strategy gates (21), kept apart from the contract. Every invariant is immutable
		// once confirmed.
		// A type as the model wrote it, as text for the refusal; a value that cannot be turned into text is named so.
		static label( type ) {
			if ( typeof type === 'string' ) { return type; }
			try {
				return String( type ?? '' );
			} catch {
				return '[unreadable]';
			}
		}

		_spec( { id, answer, mission, now, task } ) {
			const _defaults = mission.defaults || {};
			const _hours = Math.min( Math.max( Number( answer.deadlineHours ) || _defaults.deadlineHours || 24, 1 ), 24 * 30 );
			const _criteria = [];
			const _add = ( list, origin, immutable ) => {
				for ( const item of list || [] ) {
					const _values = item && typeof item.values === 'object' && !Array.isArray( item.values ) ? item.values : {};
					_criteria.push( { id: `k${_criteria.length + 1}`, type: Drafter.label( item?.type ), values: _values, origin, immutable } );
				}
			};
			// Types the system sets itself (the deadline, preconditions) are not the model's to write; they are dropped.
			const _internal = item => this.registry.has( item?.type ) && this.registry.types[ item.type ].INTERNAL;
			const _own = list => ( Array.isArray( list ) ? list : [] ).filter( item => !_internal( item ) );
			_add( _own( answer.outcomes ), 'client', false );
			_add( _own( answer.rules ), 'client', true );
			_add( mission.invariants, 'catalog', true );

			const _coverage = ( answer.coverage || [] ).map( item => ( { sentence: String( item?.sentence || '' ), criteria: [].concat( item?.criteria || [] ).map( String ) } ) );
			return {
				id,
				goal: answer.goal,
				deadline: new Date( now + _hours * 3600000 ).toISOString(),
				budget: _defaults.budget ?? 20,
				value: _defaults.value ?? 20,
				kind: mission.kind,
				criteria: _criteria,
				soft: ( answer.soft || [] ).map( String ).slice( 0, 5 ),
				understood: { task, backTranslation: answer.backTranslation, notCovered: answer.notCovered || [], coverage: _coverage },
			};
		}

	} );
