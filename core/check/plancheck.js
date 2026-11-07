// G2: a plan only reaches execution when it was made for this very contract, every move is in the catalog with
// valid parameters, every commitment is one the goal admits, the static data flow obeys 10.4 and the rules of the
// goal, nothing would close a cycle in the wait graph, and its cost fits the remaining budget (7.2). Thinking never
// touches the world; this check is the only door from plan to action.

app.define( 'Core.Check.PlanCheck', [ 'Core.Label.Flow', 'Core.Budget.Pot', 'Core.Criteria.Criterion', 'Lib.Actions', 'Core.Gates.StrategyGates' ],
	( Flow, Pot, Criterion, Actions, StrategyGates ) => class PlanCheck {

		static GATE = 'G2';

		// The trusted code of the core is no part of a plan (6.1): taking back a move happens outside any plan, and a
		// proposal is checked and registered only in the process the core opens for it (kind "meta").
		static TRUSTED = { check: 'meta', register: 'meta' };

		// strategyGates: the instances in force for this kind of task (21); restrict and order are checked here.
		// seed: the values the node starts with before its first step (node.seed), with their labels.
		check( plan, { catalog, contract, budgetLeft = Infinity, waits = null, actions = Actions.load(), strategyGates = [], seed } ) {
			const _steps = Array.isArray( plan?.steps ) ? plan.steps : null;
			if ( !_steps ) {
				return { gate: PlanCheck.GATE, ok: false, problems: [ 'the plan has no list of steps' ] };
			}
			const _problems = _steps.length ? [] : [ 'the plan has no steps' ];
			const _seed = PlanCheck.seed( seed, contract );
			_problems.push( ...PlanCheck.structure( _steps, { catalog, contract, waits, seed: _seed } ) );
			_problems.push( ...StrategyGates.plan( { ...plan, steps: _steps }, strategyGates ) );
			// 7.2, G2: a plan is bound to the hash of its contract; one that names none is bound to nothing. Reported with
			// everything else, so the person sees what else is wrong with it.
			const _bound = typeof plan.contract === 'string' && plan.contract !== '' ? [] : [ 'the plan names no contract (G2)' ];
			if ( _bound.length === 0 && plan.contract !== contract.hash ) { _bound.push( 'the plan was made for another contract' ); }
			if ( _problems.length ) {
				return { gate: PlanCheck.GATE, ok: false, problems: [ ..._bound, ..._problems ] };
			}
			_problems.push( ..._bound );
			const _rules = contract.rules();
			const _values = Flow.walk( _steps, catalog, ( step, values, producers ) => {
				const _move = catalog.get( step.move );
				if ( !_move.action ) { return; }
				_problems.push( ...PlanCheck.commitments( step, _move, contract, actions ) );
				_problems.push( ...PlanCheck.flow( step, _move, { values, producers, catalog, rules: _rules, actions } ) );
			}, _seed );
			const _cost = Pot.round( _steps.reduce( ( sum, step ) => sum + Pot.price( catalog.get( step.move ) ).total, 0 ) );
			// A budget left that is no number refuses rather than allows (fail closed).
			if ( typeof budgetLeft !== 'number' || Number.isNaN( budgetLeft ) ) {
				_problems.push( `plan costs ${_cost}, the budget left is no number` );
			} else if ( _cost > budgetLeft ) {
				_problems.push( `plan costs ${_cost}, budget left ${budgetLeft}` );
			}
			const _named = new Set( _steps.map( step => step.as ) );
			const _labels = Flow.record( [ ..._values ].filter( ( [ name ] ) => _named.has( name ) )
				.map( ( [ name, value ] ) => [ name, value.labels ] ) );
			return { gate: PlanCheck.GATE, ok: _problems.length === 0, problems: _problems, cost: _cost, labels: _labels };
		}

		// What makes a plan unusable before any data flows: steps that are no objects, moves outside the catalog or of
		// the core itself, wrong parameters, a price that is no amount, labels outside 10.4, a reference to a value no
		// earlier step produced, an outward action without a recipient, a wait that would close a cycle (R4).
		static structure( steps, { catalog, contract, waits, seed } ) {
			const _problems = [];
			Flow.walk( steps, catalog, ( step, values ) => {
				const _move = catalog.get( step.move );
				if ( !_move ) {
					_problems.push( `unknown move ${step.move}` );
					return;
				}
				_problems.push( ...PlanCheck.trusted( step, _move, contract ) );
				_problems.push( ...PlanCheck.params( step, _move ) );
				_problems.push( ...PlanCheck.price( step, _move ) );
				_problems.push( ...PlanCheck.typed( step ) );
				for ( const name of Flow.inputs( step ) ) {
					if ( !values.has( name ) ) { _problems.push( `${step.move}: reads ${PlanCheck.name( name )}, which no earlier step produces` ); }
				}
				if ( step.as !== undefined && step.as !== null && typeof step.as !== 'string' ) {
					_problems.push( `${step.move}: a value is named by a text` );
				}
				// An action to the outside goes to someone: without a recipient there is nothing the gate could check.
				if ( _move.action && !( typeof step.target === 'string' && step.target.trim() ) ) {
					_problems.push( `${step.move}: no recipient` );
				}
				const _node = PlanCheck.own( step.params, 'node' );
				if ( _node && waits && waits.graph.wouldClose( waits.node, _node ) ) {
					_problems.push( `${step.move}: waiting for ${_node} would close a cycle in the wait graph (R4)` );
				}
			}, seed );
			_problems.unshift( ...steps.map( ( step, index ) => ( step && typeof step === 'object' && !Array.isArray( step ) ? null : `step ${index + 1} is no object` ) )
				.filter( Boolean ) );
			return _problems;
		}

		// The values a node starts with, as the runner seeded it (node.seed: name → { value, labels, cohort }). A case
		// (kind "request", 8.1) starts with the message it answers, labelled foreign, also when the caller does not say so.
		static seed( seed, contract ) {
			const _case = contract.spec?.kind === 'request' ? { message: { labels: [ 'foreign' ], cohort: null } } : {};
			const _given = seed && typeof seed === 'object' ? seed : _case;
			return new Map( Object.entries( _given ).filter( ( [ , value ] ) => value && typeof value === 'object' ).map( ( [ name, value ] ) => [ name, {
				labels: [].concat( value.labels ?? [] ).filter( label => typeof label === 'string' ),
				group: Array.isArray( value.cohort ) && value.cohort.length > 0,
			} ] ) );
		}

		static name( value ) {
			return typeof value === 'string' ? value.slice( 0, 64 ) : typeof value;
		}

		// A parameter the step itself gives; a name of Object.prototype never is one.
		static own( params, name ) {
			return params && typeof params === 'object' && Object.hasOwn( params, name ) ? params[ name ] : undefined;
		}

		static trusted( step, move, contract ) {
			if ( !move.trusted || move.trusted === 'find' ) { return []; }
			const _kind = Object.hasOwn( PlanCheck.TRUSTED, move.trusted ) ? PlanCheck.TRUSTED[ move.trusted ] : null;
			return _kind && contract.spec?.kind === _kind ? [] : [ `${step.move} is trusted code of the core and no part of a plan` ];
		}

		// The parameters a move declares, with their types (6.2); a parameter it does not know is refused, and every
		// parameter not marked optional must be given. An action's own parameter (or, for an action filled from a
		// structured value, any of them) may come from its input instead.
		static params( step, move ) {
			const _schema = move.params && typeof move.params === 'object' && !Array.isArray( move.params ) ? move.params : {};
			const _declared = name => Object.hasOwn( _schema, name ) && _schema[ name ] && typeof _schema[ name ] === 'object';
			const _problems = [];
			const _given = step.params === undefined || step.params === null ? {} : step.params;
			if ( typeof _given !== 'object' || Array.isArray( _given ) ) {
				return [ `${step.move}: params must be an object` ];
			}
			for ( const [ name, value ] of Object.entries( _given ) ) {
				if ( !_declared( name ) ) {
					_problems.push( `${step.move}: unknown parameter ${name}` );
					continue;
				}
				if ( Array.isArray( value ) && !value.length && _schema[ name ].optional ) { continue; }
				const _problem = Criterion.checkParam( value, { ..._schema[ name ], optional: true } );
				if ( _problem ) { _problems.push( `${step.move}: ${name} ${_problem}` ); }
			}
			const _fed = name => Flow.inputs( step ).length > 0 && move.action && ( !move.param || move.param === name );
			for ( const [ name, param ] of Object.entries( _schema ) ) {
				if ( param?.optional === true || _fed( name ) ) { continue; }
				const _value = PlanCheck.own( _given, name );
				if ( _value === undefined || _value === null || ( typeof _value === 'string' && !_value.trim() ) ) {
					_problems.push( `${step.move}: ${name} is missing` );
				}
			}
			return _problems;
		}

		// 5.2: a price is an amount; a price that is no number or below zero could make any plan fit any budget.
		static price( step, move ) {
			const _amount = value => value === undefined || value === null || ( typeof value === 'number' && Number.isFinite( value ) && value >= 0 );
			return _amount( move.price ) && _amount( move.humanMinutes ) ? [] : [ `${step.move}: its price is no amount of at least 0` ];
		}

		// Labels written into a step must be labels of 10.4, a list for each parameter.
		static typed( step ) {
			if ( step.labels === undefined || step.labels === null ) { return []; }
			if ( typeof step.labels !== 'object' || Array.isArray( step.labels ) ) {
				return [ `${step.move}: labels must name a list for each parameter` ];
			}
			const _known = labels => Array.isArray( labels ) && labels.every( label => Flow.LABELS.includes( label ) );
			return Object.entries( step.labels ).filter( ( [ , labels ] ) => !_known( labels ) )
				.map( ( [ param ] ) => `${step.move}: the labels of ${param} must be a list of ${Flow.LABELS.join( ', ' )}` );
		}

		// A move may only make a commitment (a payment, a promise) the goal admits (6.2: what a move may commit to).
		static commitments( step, move, contract, actions ) {
			const _commits = move.commits || actions.entry( move.action )?.commits;
			if ( !_commits || contract.criteria.some( item => item.admits( _commits, move ) ) ) { return []; }
			return [ `${step.move}: commits to ${_commits}, which this goal does not admit` ];
		}

		// 10.4 for every goal, then the goal's own flow rules. values and producers stand as at this step's position.
		static flow( step, move, { values, producers, catalog, rules, actions } ) {
			const _byParam = PlanCheck.labelsByParam( step, move, { values, producers, catalog, rules, actions } );
			const _problems = [];
			for ( const param of actions.sensitive( move.action ) ) {
				if ( ( _byParam.get( param ) || [] ).includes( 'foreign' ) ) {
					_problems.push( `${step.move}: ${param} would carry foreign into a sensitive parameter (10.4)` );
				}
			}
			const _confidential = [ ..._byParam ].filter( ( [ , labels ] ) => labels.includes( 'confidential' ) );
			if ( _confidential.length && actions.outward( move.action ) ) {
				const _allowed = ( rules.allow || [] ).some( rule => rule.label === 'confidential' && actions.applies( rule.actions, move.action ) );
				if ( !_allowed || !PlanCheck.group( step, values, producers, catalog ) ) {
					_problems.push( ..._confidential.map( ( [ param ] ) => `${step.move}: ${param} would carry confidential${_allowed ? ' without a group' : ''} (10.4)` ) );
				}
			}
			_problems.push( ...Flow.violations( rules.flow, move.action, _byParam, actions ).map( text => `${step.move}: ${text}` ) );
			return _problems;
		}

		// Confidential data leaves only as a group: every input that carries confidential is a group. Confidential typed
		// into the step itself (a value from a message), or a step without inputs, is no group.
		static group( step, values, producers, catalog ) {
			const _typed = Object.values( step.labels || {} ).some( labels => [].concat( labels ).includes( 'confidential' ) );
			const _inputs = Flow.inputs( step );
			const _carries = name => [ values.get( name ).labels, ...Object.values( PlanCheck.fields( producers.get( name ), catalog ) ) ]
				.some( labels => labels.includes( 'confidential' ) );
			return !_typed && _inputs.length > 0 && _inputs.every( name => values.get( name ).group || !_carries( name ) );
		}

		// The field labels a producing move declares (trusted code labelling each field of its result).
		static fields( producer, catalog ) {
			const _fields = producer ? catalog.get( producer.move )?.fieldLabels : null;
			if ( !_fields || typeof _fields !== 'object' ) { return {}; }
			return Object.fromEntries( Object.entries( _fields ).map( ( [ field, labels ] ) => [ field, [].concat( labels ?? [] ) ] ) );
		}

		// Which labels each parameter of an outgoing action will carry (a Map): a single-parameter action takes the labels
		// of its input; an action filled from a structured value gives every one of its parameters the labels of that
		// value, plus the field labels its producing move declares. Labels written into the step itself (values typed in
		// from a message) are added to what the plan gives; they never replace it.
		static labelsByParam( step, move, { values, producers, catalog, rules = { flow: [] }, actions } ) {
			const _byParam = new Map();
			const _add = ( param, labels ) => _byParam.set( param, [ ...new Set( [ ...( _byParam.get( param ) || [] ), ...labels ] ) ] );
			const _inputs = Flow.inputs( step ).filter( name => values.has( name ) );
			if ( move.param ) {
				_inputs.forEach( name => _add( move.param, values.get( name ).labels ) );
			} else if ( _inputs.length ) {
				const _rules = ( rules.flow || [] ).filter( rule => actions.applies( rule.actions, move.action ) )
					.map( rule => rule.param );
				const _declared = move.params && typeof move.params === 'object' ? Object.keys( move.params ) : [];
				const _params = [ ..._declared, ...actions.sensitive( move.action ), ..._rules ];
				for ( const name of _inputs ) {
					const _fields = PlanCheck.fields( producers.get( name ), catalog );
					for ( const param of new Set( [ ..._params, ...Object.keys( _fields ) ] ) ) {
						_add( param, [ ...values.get( name ).labels, ...( Object.hasOwn( _fields, param ) ? _fields[ param ] : [] ) ] );
					}
				}
			}
			for ( const [ param, labels ] of Object.entries( step.labels || {} ) ) {
				_add( param, [].concat( labels ) );
			}
			return _byParam;
		}

	} );
