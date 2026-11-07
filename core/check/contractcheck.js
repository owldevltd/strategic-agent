// G1: a goal is only accepted when it is well-formed, consistent and feasible (3.2, 14.2: K1 to K8). Problems come
// back as a list for a ticket; nothing is repaired silently, except what the paper itself prescribes: where no
// channel can deliver a criterion's evidence, a person becomes the channel (K4), which the person sees in the
// back-translation. For a child, the check also holds it against all its ancestors (R5, R6): it must serve an
// open criterion of its parent, finish earlier, and carry every invariant of every ancestor, so recursion can never
// drop a protection rule.

app.define( 'Core.Check.ContractCheck', [ 'Lib.Hash' ], Hash => class ContractCheck {

	static GATE = 'G1';

	// mandatory: invariants the catalog prescribes for this kind of process (K7); strategies: what the system can do,
	// to see whether every outcome has a way at all and the budget reaches the cheapest one (feasibility).
	// catalog: the moves, to see whether a channel delivers each criterion's evidence (K4). parent: the parent node
	// itself, for what only it knows (R6: is the criterion open, was the precondition unmet, which precondition did it
	// name). A child that resembles an ancestor closely comes back with a question for its parent (R5).
	check( contract, options = {} ) {
		const { now = Date.now(), ancestors = [], mandatory = [] } = options;
		// R3: the buffer is a number of minutes, never negative; anything else means the default.
		const bufferMinutes = Number.isFinite( options.bufferMinutes ) && options.bufferMinutes >= 0 ? options.bufferMinutes : 5;
		const { strategies = null, catalog = null, parent = null } = options;
		const _problems = [
			...this._form( contract ),
			...this._time( contract, now ),
			...this._windows( contract ),
			...this._consistency( contract ),
			...this._layers( contract ),
			...this._mandatory( contract, mandatory ),
			...this._covered( contract ),
		];
		if ( strategies ) {
			_problems.push( ...this._feasible( contract, strategies ) );
		}
		if ( catalog ) {
			_problems.push( ...ContractCheck.unchannelled( contract, catalog ).map( id => `${id}: no channel delivers its evidence; a person must confirm it (K4)` ) );
		}
		const _questions = [];
		if ( ancestors.length ) {
			_problems.push( ...this._child( contract, ancestors, bufferMinutes ) );
			_problems.push( ...ContractCheck.contribution( contract, parent ) );
			_questions.push( ...ContractCheck.similar( contract, ancestors ) );
		}
		return { gate: ContractCheck.GATE, ok: _problems.length === 0, problems: _problems, questions: _questions };
	}

	_form( contract ) {
		const _problems = [];
		if ( !contract.id || !String( contract.goal ?? '' ).trim() ) {
			_problems.push( 'contract needs an id and a goal' );
		}
		// K8: budget and value are amounts: finite numbers, not negative (a negative value would turn the choice around).
		for ( const name of [ 'budget', 'value' ] ) {
			const _amount = contract.spec[ name ];
			if ( _amount !== undefined && _amount !== null && !( typeof _amount === 'number' && Number.isFinite( _amount ) && _amount >= 0 ) ) {
				_problems.push( `${name} must be a number of at least 0 (K8)` );
			}
		}
		for ( const type of contract.unknown ) {
			_problems.push( `unknown criterion type: ${type}` );
		}
		for ( const item of contract.criteria ) {
			_problems.push( ...item.validate() );
		}
		if ( !contract.outcomes().length ) {
			_problems.push( 'no outcome criterion: a goal must describe an effect, not only rules' );
		}
		if ( contract.outcomes().length && !contract.outcomes().some( item => item.origin === 'client' ) ) {
			_problems.push( 'only agent criteria describe the effect; the client\'s own outcome is missing (3.3)' );
		}
		return _problems;
	}

	// A time: a text Date.parse reads, and for an ISO date a day that exists (no 30 February rolled into March).
	static time( value ) {
		if ( typeof value !== 'string' ) { return NaN; }
		const _ms = Date.parse( value );
		const _day = value.match( /^(\d{4})-(\d{2})-(\d{2})/ );
		if ( _day ) {
			const [ , _y, _m, _d ] = _day.map( Number );
			const _last = new Date( Date.UTC( _y, _m, 0 ) ).getUTCDate();
			if ( _m < 1 || _m > 12 || _d < 1 || _d > _last ) { return NaN; }
		}
		return _ms;
	}

	_time( contract, now ) {
		const _deadline = ContractCheck.time( contract.deadline );
		if ( Number.isNaN( _deadline ) ) {
			return [ 'contract deadline is missing or invalid' ];
		}
		const _problems = _deadline <= now ? [ 'contract deadline is in the past' ] : [];
		// K8: every criterion's deadline is a valid time in the future, and no later than the contract's.
		for ( const item of contract.criteria.filter( entry => entry.deadline ) ) {
			const _own = ContractCheck.time( item.deadline );
			if ( Number.isNaN( _own ) ) {
				_problems.push( `${item.id}: its deadline is invalid (K8)` );
			} else if ( _own <= now ) {
				_problems.push( `${item.id}: its deadline is in the past (K8)` );
			} else if ( _own > _deadline ) {
				_problems.push( `${item.id}: deadline after the contract deadline` );
			}
		}
		return _problems;
	}

	// K2: every window ends no later than its criterion's deadline, unless the type asks for a later window. K3: an
	// event that depends on a commitment must leave time for it.
	_windows( contract ) {
		const _problems = [];
		for ( const item of contract.criteria.filter( entry => Array.isArray( entry.values.window ) ) ) {
			const _end = Date.parse( item.values.window[ 1 ] );
			if ( item.deadline && _end > Date.parse( item.deadline ) && !item.constructor.WINDOW_AFTER_DEADLINE ) {
				_problems.push( `${item.id}: its window ends after its own deadline (K2)` );
			}
			const _before = item.values.after && contract.criteria.find( entry => entry.id === item.values.after );
			// A commitment without a deadline of its own is due at the contract's deadline (3.1).
			const _due = _before && Date.parse( _before.deadline || contract.deadline );
			if ( item.values.after && !_before ) {
				_problems.push( `${item.id}: depends on ${item.values.after}, which does not exist (K3)` );
			} else if ( _before && _due >= _end ) {
				_problems.push( `${item.id}: ${_before.id} is due only after this window ends (K3)` );
			}
		}
		return _problems;
	}

	// 3.3: criteria of the agent extend the evidence, but never define fulfilment alone; each serves a criterion of
	// the client or the catalog (layer 1).
	_layers( contract ) {
		const _problems = [];
		const _layer1 = new Set( contract.criteria.filter( item => item.origin !== 'agent' ).map( item => item.id ) );
		for ( const item of contract.outcomes().filter( entry => entry.origin === 'agent' ) ) {
			if ( !item.serves || !_layer1.has( item.serves ) ) {
				_problems.push( `${item.id}: a criterion of the agent must serve a criterion of the client (3.3)` );
			}
		}
		return _problems;
	}

	// K5: every sentence of the effect is covered by a criterion of the client or the catalog, or listed as not
	// covered in the back-translation. Only a drafted goal has a back-translation to hold it against.
	_covered( contract ) {
		const _understood = contract.understood;
		if ( !_understood ) { return []; }
		const _layer1 = new Set( contract.criteria.filter( item => item.origin !== 'agent' ).map( item => item.id ) );
		const _sentences = ContractCheck.sentences( contract.goal );
		const _coverage = ( Array.isArray( _understood.coverage ) ? _understood.coverage : [] ).filter( item => item && typeof item === 'object' );
		const _listed = Array.isArray( _understood.notCovered ) ? _understood.notCovered : [];
		// A sentence is covered when the entries for it, or for the parts it consists of, name criteria of layer 1.
		const _id = id => ( /^\d+$/.test( String( id ).trim() ) ? `k${String( id ).trim()}` : String( id ).trim().toLowerCase() );
		return _sentences.filter( ( sentence ) => {
			const _for = item => ContractCheck.same( item.sentence, sentence ) || ContractCheck.part( item.sentence, sentence );
			const _entries = _coverage.filter( _for );
			const _named = entry => [].concat( entry.criteria ?? [] ).some( id => _layer1.has( _id( id ) ) );
			const _covered = _entries.length && _entries.every( _named );
			return !_covered && !_listed.some( entry => ContractCheck.listed( entry, sentence ) );
		} ).map( sentence => `"${sentence}" is neither covered by a criterion nor listed as not covered (K5)` );
	}

	// K5: an entry of the list of what is not covered names a sentence when the whole entry is that sentence, or the
	// sentence followed by its reason after a colon ("Fix their tools: no criterion"); never a piece of a longer word.
	static listed( entry, sentence ) {
		if ( typeof entry !== 'string' ) { return false; }
		const _colon = entry.indexOf( ':' );
		return ContractCheck.same( entry, sentence ) || ( _colon > 0 && ContractCheck.same( entry.slice( 0, _colon ), sentence ) );
	}

	static sentences( text ) {
		return String( text ).split( /(?<=[.!?])\s+/ ).map( item => item.trim().replace( /[.!?]$/, '' ) ).filter( Boolean );
	}

	static same( a, b ) {
		return ContractCheck.norm( a ) === ContractCheck.norm( b );
	}

	// A part of a sentence: a clause of it, at least four words long.
	static part( part, sentence ) {
		const _part = ContractCheck.norm( part );
		return _part.split( ' ' ).length >= 4 && ContractCheck.norm( sentence ).includes( _part );
	}

	// Letters and digits of any script, in one composed form and lower case; everything else is a blank or nothing.
	static norm( value ) {
		return String( value || '' ).normalize( 'NFC' ).toLowerCase().replace( /[^\p{L}\p{N}\s]/gu, '' ).replace( /\s+/gu, ' ' ).trim();
	}

	// K4, 3.4: where no channel of the catalog can deliver a criterion's evidence, a person becomes the channel. The
	// person sees this in the back-translation before confirming.
	static channelled( contract, catalog, registry ) {
		const _missing = ContractCheck.unchannelled( contract, catalog );
		if ( !_missing.length ) { return contract; }
		const _spec = structuredClone( contract.canonical() );
		_spec.criteria = _spec.criteria.map( item => ( _missing.includes( item.id ) ? { ...item, byPerson: true } : item ) );
		if ( _spec.understood ) {
			_spec.understood.confirmedByYou = _missing;
		}
		return new contract.constructor( _spec, registry );
	}

	// K4: the outcomes whose evidence no move of the catalog can deliver, and no person is asked to confirm.
	// Each type says itself whether the delivered kinds prove it (a composite only when every outcome part is channelled);
	// a type without that says it through its evidence kinds.
	static unchannelled( contract, catalog ) {
		const _delivered = new Set( Object.values( catalog.moves ).flatMap( move => [].concat( move?.evidence || [] ) ) );
		const _channelled = Type => ( typeof Type.channelled === 'function' ? Type.channelled( _delivered )
			: [].concat( Type.EVIDENCE || [] ).some( kind => _delivered.has( kind ) ) );
		return contract.outcomes().filter( item => !item.byPerson && !_channelled( item.constructor ) ).map( item => item.id );
	}

	// What a rule of a type is about (7.3): two rules of a type about different things (payments once per invoice and
	// once per order) are two rules, never a contradiction. Only rules about the same thing can contradict; a type not
	// listed here (nor declaring IDENTITY itself) is a single rule per contract. name → its default when left out.
	static IDENTITY = new Map( [
		[ 'exactly_once', { key: null, action: null } ],
		[ 'human_approval', { actions: null } ],
		[ 'account_from_master', { param: 'iban' } ],
		[ 'sum_max', { param: 'amount' } ],
	] );

	static identity( item ) {
		const _own = item.constructor?.IDENTITY;
		const _declared = Array.isArray( _own ) ? Object.fromEntries( _own.map( name => [ name, null ] ) ) : _own;
		const _names = _declared && typeof _declared === 'object' ? _declared : ContractCheck.IDENTITY.get( item.type ) || {};
		const _of = name => ( Object.hasOwn( item.values || {}, name ) ? item.values[ name ] : null ) ?? _names[ name ];
		return `${item.type}:${Hash.canonical( Object.keys( _names ).map( name => [ name, _of( name ) ] ) )}`;
	}

	_consistency( contract ) {
		const _problems = [];
		const _ids = new Set();
		const _same = new Map();
		for ( const item of contract.criteria ) {
			if ( _ids.has( item.id ) ) {
				_problems.push( `duplicate criterion id: ${item.id}` );
			}
			_ids.add( item.id );
			if ( item.kind !== 'invariant' ) { continue; }
			const _identity = ContractCheck.identity( item );
			const _earlier = _same.get( _identity );
			if ( _earlier && !item.atLeastAsStrict( _earlier ) && !_earlier.atLeastAsStrict( item ) ) {
				_problems.push( `${item.id}: contradicts ${_earlier.id} (same rule, other values)` );
			}
			_same.set( _identity, _earlier && _earlier.atLeastAsStrict( item ) ? _earlier : item );
		}
		// The agent may add rules for its kind of task (strategy gates), but only ever tighten (7.3): each of its rules is
		// at least as strict as every rule of the client or the catalog about the same thing, wherever it stands in the list.
		const _given = contract.invariants().filter( item => item.origin !== 'agent' );
		for ( const item of contract.invariants().filter( entry => entry.origin === 'agent' ) ) {
			const _about = ContractCheck.identity( item );
			for ( const other of _given.filter( entry => ContractCheck.identity( entry ) === _about && !item.atLeastAsStrict( entry ) ) ) {
				_problems.push( `${item.id}: the agent may only tighten ${other.id}, not loosen it` );
			}
		}
		return _problems;
	}

	// K7: every criterion the catalog prescribes for this kind of process is present, at least as strict, immutable. 3.3
	// names rules and cross-checks alike (conservation rules and counter-checks, such as a preserved count): a prescribed outcome (a
	// frozen test suite that must be green) is layer 1 as much as a rule, so no drafted goal closes without it (G-5).
	_mandatory( contract, mandatory ) {
		const _problems = [];
		for ( const need of mandatory ) {
			const _have = contract.criteria.filter( item => item.type === need.type );
			if ( !_have.some( item => item.atLeastAsStrict( need ) && item.immutable ) ) {
				_problems.push( `missing invariant of this kind of process: ${need.type} ${JSON.stringify( need.values )} (K7)` );
			}
		}
		return _problems;
	}

	// Every outcome needs at least one strategy that serves or reaches it, and the budget must reach the cheapest of them.
	// A kind of task the catalog has no strategy for yet is learned, not refused: G1 asks for deadlines, budget and
	// channels (3.2), and the first goal of a new kind is where the agent proposes its ways (6.1, 19).
	static newKind( contract, strategies ) {
		const _kind = contract.spec?.kind;
		return typeof _kind === 'string' && _kind !== '' && !strategies.some( strategy => strategy?.kind === _kind );
	}

	_feasible( contract, strategies ) {
		const _problems = [];
		if ( ContractCheck.newKind( contract, strategies ) ) { return _problems; }
		const _for = strategy => ( !strategy.kind || strategy.kind === contract.spec.kind )
			&& ( !strategy.intents || strategy.intents.includes( contract.spec.scope?.intent ) );
		for ( const item of contract.outcomes() ) {
			const _test = ( name, pattern ) => {
				try {
					return new RegExp( pattern ).test( String( item.values?.[ name ] ?? '' ) );
				} catch {
					return false;
				}
			};
			const _fits = strategy => Object.entries( strategy.fits || {} ).every( ( [ name, pattern ] ) => _test( name, pattern ) );
			const _reaches = strategy => ( strategy.serves === item.type && _fits( strategy ) )
				|| ( strategy.reaches || [] ).includes( item.type ) || ( item.byPerson && strategy.serves === '@byPerson' );
			const _ways = strategies.filter( strategy => _for( strategy ) && _reaches( strategy ) );
			if ( !_ways.length ) {
				_problems.push( `${item.id}: no strategy can achieve ${item.type}` );
			} else {
				const _cheapest = Math.min( ..._ways.map( strategy => strategy.price ?? 1 ) );
				if ( !( _cheapest <= contract.budget ) ) {
					_problems.push( `${item.id}: budget ${contract.budget} is below the cheapest way (${_cheapest})` );
				}
			}
		}
		return _problems;
	}

	// G-10: an amendment may change anything the client may change, but never an immutable criterion, and it may not
	// drop one.
	static amendment( before, after ) {
		const _after = new Set( after.immutables() );
		return before.immutables().filter( item => !_after.has( item ) )
			.map( item => `immutable criterion ${JSON.parse( item )[ 0 ]} would change (G-10)` );
	}

	// R6: the criterion the child serves is open in the parent, the precondition was unmet there, and the child's own
	// outcomes express exactly the precondition the parent named.
	static contribution( contract, parent ) {
		const _serves = contract.serves;
		if ( !parent || !_serves ) { return []; }
		const _problems = [];
		if ( !parent.openOutcomes().some( item => item.id === _serves.criterion ) ) {
			_problems.push( `child serves ${_serves.criterion}, which is not open in its parent (R6)` );
		}
		if ( _serves.precondition && parent.preconditionMet?.( _serves.precondition ) ) {
			_problems.push( `precondition ${_serves.precondition} is already met in the parent (R6, R8)` );
		}
		const _named = [ ...parent.walls ].reverse().find( wall => wall.precondition?.id === _serves.precondition )?.precondition;
		const _own = contract.outcomes().filter( item => item.origin === 'client' );
		const _exact = _own.length === 1 && _own[ 0 ].type === _named?.type
			&& JSON.stringify( _own[ 0 ].values ) === JSON.stringify( _named?.values || {} );
		if ( _named && !_exact ) {
			_problems.push( `the child's outcomes do not express exactly precondition ${_named.id} (R6)` );
		}
		// A child no wall named (one per item of its parent's criterion, from a template) expresses a part of the
		// criterion it serves: the same type, a part of each of its lists, every other value the same.
		const _served = parent.contract.criteria.find( item => item.id === _serves.criterion );
		if ( !_named && _served && !( _own.length && _own.every( item => ContractCheck.within( item, _served ) ) ) ) {
			_problems.push( `the child's outcomes are no part of ${_served.id} (R6)` );
		}
		return _problems;
	}

	// A part that is narrower than the whole: within it, and at least one of its lists names fewer entries (one invoice
	// of two). Such a child divides its parent's work; it does not reword it (R5).
	static narrower( part, whole ) {
		const _shorter = ( [ key, value ] ) => Array.isArray( value ) && Array.isArray( whole.values?.[ key ] )
			&& value.length < whole.values[ key ].length;
		return ContractCheck.within( part, whole ) && Object.entries( part.values || {} ).some( _shorter );
	}

	static within( part, whole ) {
		const _same = ( a, b ) => JSON.stringify( a ) === JSON.stringify( b );
		const _values = whole.values || {};
		const _keys = new Set( [ ...Object.keys( _values ), ...Object.keys( part.values || {} ) ] );
		return part.type === whole.type && [ ..._keys ].every( ( key ) => {
			const [ _part, _whole ] = [ part.values?.[ key ], _values[ key ] ];
			const _lists = Array.isArray( _whole ) && Array.isArray( _part );
			return _lists ? _part.length > 0 && _part.every( item => _whole.includes( item ) ) : _same( _part, _whole );
		} );
	}

	// R5: high similarity to an ancestor (the same type with nearly the same values, or nearly the same goal) is no
	// refusal; it is a question to the parent.
	static similar( contract, ancestors ) {
		const _words = text => new Set( String( text ).normalize( 'NFC' ).toLowerCase().match( /[\p{L}\p{N}]+/gu ) || [] );
		const _overlap = ( a, b ) => {
			const _a = _words( a );
			const _b = _words( b );
			const _both = [ ..._a ].filter( word => _b.has( word ) ).length;
			return _both / Math.max( 1, new Set( [ ..._a, ..._b ] ).size );
		};
		const _questions = [];
		for ( const ancestor of ancestors ) {
			if ( _overlap( contract.goal, ancestor.goal ) >= ContractCheck.SIMILAR ) {
				_questions.push( `the goal resembles "${ancestor.goal}" of ${ancestor.id} (R5)` );
			}
			for ( const item of ancestor.outcomes() ) {
				const _near = own => _overlap( JSON.stringify( own.values ), JSON.stringify( item.values ) ) >= ContractCheck.SIMILAR;
				const _other = own => own.type === item.type && JSON.stringify( own.values ) !== JSON.stringify( item.values );
				const _close = contract.outcomes().find( own => _other( own ) && _near( own ) );
				if ( _close ) { _questions.push( `${_close.id} resembles outcome ${item.id} of ${ancestor.id} (R5)` ); }
			}
		}
		return _questions;
	}

	static SIMILAR = 0.7;

	_child( contract, ancestors, bufferMinutes ) {
		const _problems = [];
		const _parent = ancestors[ ancestors.length - 1 ];
		const _serves = contract.serves;
		if ( !_serves || !_parent.criteria.some( item => item.id === _serves.criterion ) ) {
			_problems.push( 'child must serve an existing criterion of its parent (R6)' );
		}
		if ( !( Date.parse( contract.deadline ) <= Date.parse( _parent.deadline ) - bufferMinutes * 60000 ) ) {
			_problems.push( 'child must finish before its parent, with buffer (R3)' );
		}
		// Every invariant of every ancestor, the same or stricter; values compared as canonical JSON, not by key order.
		for ( const ancestor of ancestors ) {
			for ( const item of ancestor.invariants() ) {
				if ( !contract.invariants().some( own => own.type === item.type && own.atLeastAsStrict( item ) ) ) {
					_problems.push( `child drops invariant ${item.type} of ${ancestor.id}` );
				}
			}
			for ( const item of ancestor.outcomes() ) {
				const _same = own => own.type === item.type && Hash.canonical( own.values ) === Hash.canonical( item.values );
				if ( contract.outcomes().some( _same ) ) {
					_problems.push( `child restates outcome ${item.id} of ${ancestor.id} (R5)` );
				}
			}
		}
		return _problems;
	}

} );
