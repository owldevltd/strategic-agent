// Evaluates the rules of a confirmed contract against one outgoing action. The gate runs this itself, with its
// own code and its own ledger; it does not trust any verdict from the core. Fail closed (A8): an unknown action, an
// unknown or malformed rule, a value it cannot read, all refuse.

app.define( 'Gate.Rules', [ 'Lib.Actions', 'Lib.Hash', 'Core.Contract.Contract' ], ( Actions, Hash, Contract ) => class Rules {

	// The rules the gate knows, each with the shape it must have; anything else refuses.
	static RULES = new Map( [
		[ 'expires', rule => !Number.isNaN( Date.parse( rule.at ) ) ],
		[ 'human_approval', () => true ],
		[ 'min_group', rule => Number.isInteger( rule.k ) && rule.k >= 1 ],
		[ 'data_subject', () => true ],
		[ 'no_difference', rule => Number.isInteger( rule.k ) && rule.k >= 1 ],
		[ 'exactly_once', rule => typeof rule.key === 'string' && rule.key.length > 0 ],
		[ 'known_account', rule => typeof rule.param === 'string' && rule.param.length > 0 ],
		[ 'sum_max', rule => typeof rule.param === 'string' && rule.param.length > 0 && typeof rule.max === 'number' && rule.max >= 0 ],
	] );

	static WAITING = 50;

	_waiting( contract ) {
		return this.store.treeDeliveries( contract.root ).filter( item => item.status === 'awaiting_approval' && !item.withdrawn ).length;
	}

	// What still counts against "exactly once", a sum or a release: everything not ended without an effect.
	static STANDING = [ 'executed', 'open', 'awaiting_approval', 'approved', 'unclear' ];

	// ledger: 'gate' (every goal at this gate) or 'goal' (only the goal's own tree), for "exactly once" and "no difference".
	constructor( store, { bufferMinutes = 5, now = () => Date.now(), actions = Actions.load(), ledger = 'gate' } = {} ) {
		if ( ![ 'gate', 'goal' ].includes( ledger ) ) { throw new RangeError( `the ledger is "gate" or "goal", not ${String( ledger ).slice( 0, 40 )}` ); }
		this.ledger = ledger;
		this.store = store;
		this.bufferMinutes = bufferMinutes;
		this.now = now;
		this.actions = actions;
	}

	// Returns { refusals: [ ... ], needsApproval: bool }. The criticality of the action alone can require a person
	// (G-6); a rule of the goal can require one for actions that would otherwise pass.
	evaluate( contract, request ) {
		if ( !this.actions.known( request.action ) ) {
			return { refusals: [ { rule: 'action', reason: `${String( request.action ).slice( 0, 60 )} is not a known action (fail closed)` } ], needsApproval: false };
		}
		const _rules = contract.rules || {};
		const _refusals = [ ...this._system( contract, request ) ];
		// A contract stored with partial rules (an older gate, a damaged row) cannot be checked: nothing passes.
		if ( ![ _rules.gate, _rules.flow, _rules.allow ].every( Array.isArray ) ) {
			_refusals.push( { rule: 'rules', reason: 'the rules of this goal are not three lists (fail closed)' } );
		}
		let _needsApproval = this.actions.needsPerson( request.action );
		for ( const rule of Rules.list( _rules.flow ).filter( entry => this.actions.applies( entry.actions, request.action ) ) ) {
			_refusals.push( ...this._flow( rule, request ) );
		}
		for ( const rule of Rules.list( _rules.gate ).filter( entry => this.actions.applies( entry.actions, request.action ) ) ) {
			const _known = Rules.RULES.has( rule.rule );
			if ( !_known || !Rules.RULES.get( rule.rule )( rule ) ) {
				const _name = String( rule.rule ).slice( 0, 40 );
				_refusals.push( { rule: _name, criterion: rule.criterion, reason: `${_known ? 'malformed' : 'unknown'} rule ${_name} (fail closed)` } );
				continue;
			}
			if ( rule.rule === 'human_approval' ) {
				_needsApproval = true;
				continue;
			}
			const _reason = this[ Rules.method( rule.rule ) ].call( this, rule, request, contract );
			if ( _reason ) {
				_refusals.push( { rule: rule.rule, criterion: rule.criterion, reason: _reason } );
			}
		}
		// P6: a person's attention is limited. A goal keeps at most WAITING actions waiting for a person at once; a core that
		// floods the person is refused (the requests are booked, the person is not asked).
		if ( _needsApproval && this._waiting( contract ) >= Rules.WAITING ) {
			_refusals.push( { rule: 'waiting', reason: `${Rules.WAITING} actions of this goal already wait for a person` } );
		}
		return { refusals: _refusals, needsApproval: _needsApproval };
	}

	static list( value ) {
		return Array.isArray( value ) ? value.filter( item => item && typeof item === 'object' ) : [];
	}

	static object( value ) {
		return Boolean( value ) && typeof value === 'object' && !Array.isArray( value );
	}

	// The rules of a goal as the gate stores them at propose(): three lists, every gate rule known and of its shape,
	// every flow rule and allowance naming what it is about, every selector a text (A8). → the problems, none if usable.
	static check( rules ) {
		if ( !Rules.object( rules ) || ![ rules.gate, rules.flow, rules.allow ].every( Array.isArray ) ) {
			return [ 'the rules are not three lists (gate, flow, allow)' ];
		}
		const _texts = value => value === undefined || typeof value === 'string' || ( Array.isArray( value ) && value.every( item => typeof item === 'string' ) );
		const _name = rule => ( Rules.object( rule ) && typeof rule.rule === 'string' ? rule.rule.slice( 0, 40 ) : 'without a name' );
		const _gate = rule => Rules.object( rule ) && Rules.RULES.has( rule.rule ) && Rules.RULES.get( rule.rule )( rule )
			&& _texts( rule.actions );
		const _flow = rule => Rules.object( rule ) && typeof rule.param === 'string' && rule.param !== ''
			&& _texts( rule.mustHave ) && _texts( rule.mustNot ) && _texts( rule.actions );
		const _allow = rule => Rules.object( rule ) && typeof rule.label === 'string' && rule.label !== '' && _texts( rule.actions );
		return [
			...rules.gate.filter( rule => !_gate( rule ) ).map( rule => `the gate rule ${_name( rule )} is unknown or malformed` ),
			...rules.flow.filter( rule => !_flow( rule ) ).map( () => 'a flow rule is malformed' ),
			...rules.allow.filter( rule => !_allow( rule ) ).map( () => 'an allowance is malformed' ),
		];
	}

	// The same rules: the same three lists, whatever the order of the rules or of their keys.
	static same( sent, derived ) {
		const _sent = Rules.json( sent );
		const _list = list => ( Array.isArray( list ) ? list.map( item => Hash.canonical( item ) ).sort() : null );
		return Rules.object( _sent ) && [ 'gate', 'flow', 'allow' ].every( name => Hash.canonical( _list( _sent[ name ] ) ) === Hash.canonical( _list( derived[ name ] ) ) );
	}

	// Is the child at least as strict as the parent? Its gate and flow rules contain every rule of the parent, it allows
	// nothing to leave that the parent does not allow, and its expiry is not later. Rules are compared without the
	// criterion id they came from.
	static covers( child, parent ) {
		const _key = ( { criterion: _c, at: _a, ...rest } ) => Hash.canonical( rest );
		const _within = ( wider, narrower ) => {
			const _wide = new Set( ( wider || [] ).map( _key ) );
			return ( narrower || [] ).every( rule => _wide.has( _key( rule ) ) );
		};
		const _gate = list => ( list || [] ).filter( rule => rule.rule !== 'expires' );
		const _expiry = list => Math.min( ...( list || [] ).filter( rule => rule.rule === 'expires' ).map( rule => Date.parse( rule.at ) ) );
		const _stricter = _within( _gate( child.gate ), _gate( parent.gate ) ) && _within( child.flow, parent.flow );
		return _stricter && _within( parent.allow, child.allow ) && _expiry( child.gate ) <= _expiry( parent.gate );
	}

	// The most a request may carry (params, labels, group and texts together); more is refused, not stored (A8).
	static MAX_REQUEST = 6 * 1024 * 1024;

	// A8, F1 at the boundary: the request exactly as the gate books and hashes it, and the problems that make it
	// unreadable. Only the known fields are taken (an "id" from outside could hide a booked delivery from the rules),
	// and every value goes through JSON once, so the hash covers exactly what is stored and read back: a Date becomes
	// its ISO text, a function or undefined is dropped, NaN is null, a BigInt is refused.
	static request( raw ) {
		const _problems = [];
		const _in = Rules.object( raw ) ? raw : {};
		if ( _in !== raw ) {
			_problems.push( { rule: 'request', reason: 'the request is no object (A8)' } );
		}
		const _get = name => ( Object.hasOwn( _in, name ) ? _in[ name ] : undefined );
		// A required text is taken as it is (the action table or the ledger decides about an empty one); an optional
		// empty text is none.
		const _text = ( name, rule = name, { required = false, number = false } = {} ) => {
			const _value = _get( name );
			if ( _value === undefined || _value === null || ( _value === '' && !required ) ) {
				if ( required ) { _problems.push( { rule, reason: `the request names no ${name}` } ); }
				return null;
			}
			if ( typeof _value === 'string' || ( number && typeof _value === 'number' && Number.isFinite( _value ) ) ) {
				return String( _value );
			}
			_problems.push( { rule, reason: `${name} is no text (A8)` } );
			return null;
		};
		const _json = ( name, { fallback, list = false, object = false } ) => {
			const _value = _get( name );
			if ( _value === undefined || _value === null ) { return fallback; }
			const _copy = Rules.json( _value );
			if ( _copy === undefined || ( object && !Rules.object( _copy ) ) || ( list && !Array.isArray( _copy ) ) ) {
				_problems.push( { rule: name, reason: `${name} cannot be read as ${object ? 'an object' : list ? 'a list' : 'JSON'} (A8)` } );
				return fallback;
			}
			return _copy;
		};
		const _fence = _get( 'fence' );
		const request = {
			contract: _text( 'contract', 'contract', { required: true } ), action: _text( 'action', 'action', { required: true } ),
			node: _text( 'node' ), target: _text( 'target', 'target', { number: true } ), lease: _text( 'lease', 'lease' ),
			fence: Number.isInteger( _fence ) ? _fence : null,
			params: _json( 'params', { fallback: {}, object: true } ), labels: _json( 'labels', { fallback: {}, object: true } ),
			cohort: _json( 'cohort', { fallback: null } ), flags: _json( 'flags', { fallback: null, list: true } ),
		};
		if ( _fence !== undefined && _fence !== null && request.fence === null ) {
			_problems.push( { rule: 'lease', reason: 'the fencing token is no integer (A6)' } );
		}
		if ( Rules.size( request ) > Rules.MAX_REQUEST ) {
			_problems.push( { rule: 'size', reason: `the request carries more than ${Rules.MAX_REQUEST} characters (A8)` } );
		}
		return { request, problems: _problems };
	}

	// A value as JSON reads it back; undefined when JSON cannot carry it.
	static json( value ) {
		try {
			const _text = JSON.stringify( value );
			return _text === undefined ? undefined : JSON.parse( _text );
		} catch {
			return undefined;
		}
	}

	// How much a request carries, in characters of its JSON.
	static size( request ) {
		const { contract, action, node, target, lease, params, labels, cohort, flags } = request;
		return JSON.stringify( { contract, action, node, target, lease, params, labels, cohort, flags } ).length;
	}

	// The labels of one parameter, however they were nested; only names count.
	static labels( request, param ) {
		const _given = request.labels && typeof request.labels === 'object' && Object.hasOwn( request.labels, param ) ? request.labels[ param ] : [];
		return [].concat( _given ?? [] ).flat( Infinity ).filter( label => typeof label === 'string' );
	}

	// The data-flow limits of 10.4 hold for every goal: nothing foreign in a sensitive parameter (and a sensitive
	// parameter without any label is not trusted either), nothing confidential outside unless a rule of the goal allows
	// it, and then only as a group the gate can check.
	_system( contract, request ) {
		const _out = [];
		const _params = request.params && typeof request.params === 'object' ? request.params : {};
		for ( const param of this.actions.sensitive( request.action ) ) {
			const _labels = Rules.labels( request, param );
			if ( _labels.includes( 'foreign' ) ) {
				_out.push( { rule: 'sensitive', reason: `${param} carries a foreign value into a sensitive parameter` } );
			} else if ( Object.hasOwn( _params, param ) && !_labels.length ) {
				_out.push( { rule: 'sensitive', reason: `${param} carries no label; its origin is unknown (fail closed)` } );
			}
		}
		const _all = request.labels && typeof request.labels === 'object' ? Object.keys( request.labels ).flatMap( name => Rules.labels( request, name ) ) : [];
		if ( request.cohort !== undefined && request.cohort !== null && !Array.isArray( request.cohort ) ) {
			_out.push( { rule: 'group', reason: 'the declared group is no list' } );
		}
		if ( _all.includes( 'confidential' ) && this.actions.outward( request.action ) ) {
			const _allowed = Rules.list( contract.rules?.allow ).some( rule => rule.label === 'confidential' && this.actions.applies( rule.actions, request.action ) );
			if ( !_allowed ) {
				_out.push( { rule: 'confidential', reason: 'confidential data may not leave under this goal' } );
			} else if ( !Array.isArray( request.cohort ) ) {
				_out.push( { rule: 'confidential', reason: 'confidential data without a declared group' } );
			}
		}
		// Where data goes is the gate's own master data, as where money goes (pentest C): a release (data about a group, or
		// anything confidential) only to a recipient the operator listed (kind "recipient"). A goal cannot add one, so a model
		// that wrote a stranger into the goal and a person who confirmed it unread are both stopped here.
		const _release = Array.isArray( request.cohort ) || _all.includes( 'confidential' );
		if ( _release && this.actions.outward( request.action ) && !this.store.isMaster( 'recipient', request.target, this.scope( contract ) ) ) {
			_out.push( { rule: 'recipient', reason: `${String( request.target ).slice( 0, 60 )} is not a recipient in the master data` } );
		}
		return _out;
	}

	// G-1b, A7: an action expires with its contract, and never later than the root's deadline plus the buffer.
	expiresAt( contract ) {
		const _root = contract.root && contract.root !== contract.hash ? this.store.contract( contract.root ) : null;
		const _at = [ contract, _root ].filter( Boolean ).flatMap( item => Rules.list( item.rules?.gate ) )
			.filter( rule => rule.rule === 'expires' ).map( rule => Date.parse( rule.at ) ).filter( at => !Number.isNaN( at ) );
		return new Date( ( _at.length ? Math.min( ..._at ) : this.now() ) + this.bufferMinutes * 60000 ).toISOString();
	}

	_flow( rule, request ) {
		const _labels = Rules.labels( request, rule.param );
		const _out = [];
		for ( const label of [].concat( rule.mustNot ?? [] ) ) {
			if ( _labels.includes( label ) ) {
				_out.push( { rule: 'flow', criterion: rule.criterion, reason: `${rule.param} carries the label ${label}` } );
			}
		}
		for ( const label of [].concat( rule.mustHave ?? [] ) ) {
			if ( !_labels.includes( label ) ) {
				_out.push( { rule: 'flow', criterion: rule.criterion, reason: `${rule.param} lacks the label ${label}` } );
			}
		}
		return _out;
	}

	_expires( rule ) {
		return this.now() > Date.parse( rule.at ) + this.bufferMinutes * 60000 ? 'the contract has expired' : null;
	}

	// The people of a group: distinct ids, each a non-empty text or a number; → null when one is no id.
	static people( cohort ) {
		const _ids = [];
		for ( const item of cohort ) {
			const _id = typeof item === 'number' && Number.isFinite( item ) ? String( item ) : typeof item === 'string' ? item.normalize( 'NFC' ).trim() : '';
			if ( !_id ) { return null; }
			_ids.push( _id );
		}
		return new Set( _ids );
	}

	// A message without confidential data is not a release, e.g. "I cannot report on fewer than five people".
	_minGroup( rule, request ) {
		if ( !Array.isArray( request.cohort ) ) { return null; }
		const _people = Rules.people( request.cohort );
		if ( !_people ) { return 'the group names someone who is no id (fail closed)'; }
		return _people.size < rule.k ? `group of ${_people.size} < ${rule.k}` : null;
	}

	// A data subject's copy: a release about exactly one person, to the address the master data holds for that person
	// ("<id> <address>", kind contact): the address the gate resolved the target to, or the target itself. A message
	// without data about anyone is no release.
	_dataSubject( rule, request, contract ) {
		if ( !Array.isArray( request.cohort ) ) { return null; }
		const _people = Rules.people( request.cohort );
		if ( !_people ) { return 'the group names someone who is no id (fail closed)'; }
		if ( _people.size !== 1 ) { return `a copy for a data subject is about ${_people.size} people`; }
		const [ _id ] = _people;
		const _given = typeof request.address === 'string' ? request.address : request.target;
		const _target = typeof _given === 'string' ? _given.trim() : '';
		return this.store.isMaster( 'contact', `${_id} ${_target}`, this.scope( contract ) ) ? null : `${_target.slice( 0, 60 )} is not the address on file for ${_id.slice( 0, 40 )}`;
	}

	// Against every release that went out or may still go out: executed, open, approved, waiting or unclear, of this
	// goal and of every other goal at this gate, so a second goal cannot tell apart whom the first one grouped (see
	// ledger). The comparison is pairwise, as the paper defines the rule: each earlier release against the new one.
	_noDifference( rule, request, contract ) {
		if ( !Array.isArray( request.cohort ) ) { return null; }
		const _new = Rules.people( request.cohort );
		if ( !_new ) { return 'the group names someone who is no id (fail closed)'; }
		const _earlier = [
			...( this.ledger === 'goal' ? this.store.releasedCohorts( contract.root ) : this.store.allReleasedCohorts() ),
			...this._anywhere( request, contract ).filter( item => Rules.STANDING.includes( item.status ) && Array.isArray( item.cohort ) )
				.map( item => item.cohort ),
		];
		for ( const cohort of _earlier ) {
			const _old = Rules.people( cohort ) || new Set();
			const _diff = [ ..._new ].filter( id => !_old.has( id ) ).length + [ ..._old ].filter( id => !_new.has( id ) ).length;
			if ( _diff > 0 && _diff < rule.k ) {
				return `differs from an earlier release by ${_diff} ${_diff === 1 ? 'person' : 'people'}`;
			}
		}
		return null;
	}

	// A key as one text (NFC, trimmed, case counts): 4711 and "4711", "R-1187 " and "R-1187" are the same invoice,
	// "r-1187" is another one.
	static key( value ) {
		if ( typeof value === 'number' && Number.isFinite( value ) ) { return String( value ); }
		return typeof value === 'string' ? value.normalize( 'NFC' ).trim() : '';
	}

	_exactlyOnce( rule, request, contract ) {
		const _params = request.params && typeof request.params === 'object' ? request.params : {};
		const _value = Object.hasOwn( _params, rule.key ) ? Rules.key( _params[ rule.key ] ) : '';
		if ( !_value ) {
			return `missing ${rule.key}`;
		}
		const _earlier = this._anywhere( request, contract ).find( item => this.actions.applies( rule.actions, item.action )
			&& Rules.key( item.params?.[ rule.key ] ) === _value && Rules.STANDING.includes( item.status ) );
		return _earlier ? `${rule.key} ${_value} already has a ${_earlier.action} (${_earlier.status})` : null;
	}

	_knownAccount( rule, request, contract ) {
		const _value = request.params && Object.hasOwn( request.params, rule.param ) ? request.params[ rule.param ] : undefined;
		const _kind = typeof rule.kind === 'string' && rule.kind ? rule.kind : 'account';
		return this.store.isMaster( _kind, _value, this.scope( contract ) ) ? null : `${rule.param} is not in the master data (${_kind})`;
	}

	// An amount in whole cents: a finite number of at least 0, or text that is one; anything else is no amount.
	static cents( value ) {
		const _number = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test( value ) ? Number( value ) : NaN;
		return Number.isFinite( _number ) && _number >= 0 ? Math.round( _number * 100 ) : null;
	}

	_sumMax( rule, request, contract ) {
		const _amount = Rules.cents( request.params?.[ rule.param ] );
		if ( _amount === null ) { return `${rule.param} is no amount of at least 0 (fail closed)`; }
		let _spent = 0;
		const _counted = entry => this.actions.applies( rule.actions, entry.action ) && Rules.STANDING.includes( entry.status );
		for ( const item of this._others( contract, request ).filter( _counted ) ) {
			const _earlier = Rules.cents( item.params?.[ rule.param ] );
			if ( _earlier === null ) { return `an earlier ${item.action} has no readable ${rule.param} (fail closed)`; }
			_spent += _earlier;
		}
		const _total = ( _spent + _amount ) / 100;
		return _spent + _amount > Math.round( rule.max * 100 ) ? `sum would reach ${_total} > ${rule.max}` : null;
	}

	// When a stored delivery is checked again (after an approval), it must not count against itself. A sum is one goal's
	// (its tree); what an item already had is the gate's to know across all goals, unless the operator kept the ledger
	// to each goal (a public demo where every run is a simulated week of its own).
	// The master data a goal may use: its mission's (the kind of its root goal, which a person confirmed; a child goal
	// cannot move itself to another mission's data) and what the operator gave for every goal.
	scope( contract ) {
		const _root = this.store.contract( contract?.root ) || contract;
		return _root?.spec?.kind;
	}

	_others( contract, request ) {
		return this.store.treeDeliveries( contract.root ).filter( item => item.id !== request.id );
	}

	_anywhere( request, contract ) {
		return this.ledger === 'goal' ? this._others( contract, request ) : this.store.allDeliveries().filter( item => item.id !== request.id );
	}

	// A refusal the gate decided (a hash that does not match, money without a reason, input it cannot read): the
	// caller's error, answered over HTTP with its status and reason, never as an error of the gate itself.
	static refusal( message, status = 400 ) {
		return Object.assign( new Error( message ), { status, refusal: true } );
	}

	// The goal as the criterion classes read it; null when it cannot even be hashed (a value JSON cannot carry).
	static goal( spec, types ) {
		try {
			const _goal = new Contract( Rules.canonical( spec ), types );
			return { hash: _goal.hash, unknown: _goal.unknown, rules: () => _goal.rules() };
		} catch {
			return null;
		}
	}

	// The fields of a goal its hash covers.
	static canonical( spec ) {
		const { id, goal, deadline, budget, value, serves, parent, criteria, understood, soft, kind, scope, amends } = spec;
		return { id, goal, deadline, budget, value, serves, parent, criteria, understood, soft, kind, scope, amends };
	}

	// Rule names are data (snake_case); each maps to a method, min_group → _minGroup.
	static method( name ) {
		return `_${name.replace( /_([a-z])/g, ( _all, char ) => char.toUpperCase() )}`;
	}
} );
