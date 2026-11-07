// A criterion of a contract. Every type has four jobs:
//   check( facts )  the evidence predicate: is the criterion met, and by which facts
//   flowRules()     data-flow rules the plan check (G2) enforces before anything runs
//   gateRules()     rules the gate enforces by itself, without asking the core
//   allows()        what the goal explicitly allows that 10.4 forbids by default (confidential data leaving as a group)
// A contract is a list of criteria, so the rules for a new goal follow from its criteria without new code.
//
// KIND 'outcome' is something to achieve (closing needs evidence for it); 'invariant' must hold the whole time
// and is mostly enforced through rules; 'soft' is free text an AI reviewer assesses, and never closes alone (14).
// Every criterion has an id, its own deadline ("bis"), an origin (client, catalog, agent), whether it is immutable
// and, for criteria of the agent, the criterion of the client it serves (14.1, 3.3). EVIDENCE names the kinds of
// fact its predicate accepts, so G1 can see whether any channel can deliver them (K4).

app.define( 'Core.Criteria.Criterion', [ 'Lib.Actions', 'Lib.Hash' ], ( _Actions, Hash ) => class Criterion {

	static TYPE = 'criterion';
	static KIND = 'outcome';
	static DESCRIBE = '';
	static INTERNAL = false;
	static PARAMS = {};
	static EVIDENCE = [];
	// A window that may end after the criterion's own deadline (a commitment for a later date, K2).
	static WINDOW_AFTER_DEADLINE = false;

	constructor( spec ) {
		this.id = spec.id;
		this.type = spec.type;
		this.values = spec.values && typeof spec.values === 'object' && !Array.isArray( spec.values ) ? spec.values : {};
		this.immutable = Boolean( spec.immutable );
		this.deadline = spec.deadline || null;
		// Layer 1 comes from the client and from the catalog of the process kind; layer 2 from the agent (chapter 3.3).
		this.origin = spec.origin || 'client';
		this.serves = spec.serves || null;
		// K4, 3.4: no channel can deliver the evidence this type needs, so a person is the channel.
		this.byPerson = Boolean( spec.byPerson );
	}

	// The predicate, plus what follows from time: a criterion whose own deadline has passed unmet cannot be met any more
	// (16.4, U4). A type may also report a fact that makes it impossible.
	verdict( facts, now = Date.now() ) {
		// K4: the person's latest answer to this criterion counts; a later "no" takes back an earlier "yes".
		const _answer = this.byPerson && Criterion.latest( this.evidence( facts, now ).filter( fact => fact.kind === 'confirmation'
			&& fact.evidenceClass === 'confirmation' && fact.data?.criterion === this.id ) );
		if ( _answer && _answer.data.choice === 'yes' ) {
			return { met: true, evidence: [ _answer.id ], reason: 'confirmed by a person (K4)' };
		}
		// Everything is judged at the verdict's own time: validity, deadlines, what arrived when.
		const _result = this.check( facts, now );
		const _late = !_result.met && this.deadline && now > Criterion.time( this.deadline );
		return _late ? { ..._result, impossible: true, reason: `${_result.reason}; its deadline has passed`.replace( /^; /, '' ) } : _result;
	}

	get kind() {
		return this.constructor.KIND;
	}

	validate() {
		const _problems = [];
		const _params = this.constructor.PARAMS;
		for ( const [ name, param ] of Object.entries( _params ) ) {
			const _problem = Criterion.checkParam( this.values[ name ], param );
			if ( _problem ) {
				_problems.push( `${this.id}: ${name} ${_problem}` );
			}
		}
		// 3.2: a value the type does not declare would be frozen into the hash and fill slots of plans unseen; refused.
		for ( const name of Object.keys( this.values ).filter( key => !Object.hasOwn( _params, key ) ) ) {
			_problems.push( `${this.id}: ${name.slice( 0, 40 )} is no parameter of ${this.type}` );
		}
		return _problems;
	}

	check( _facts, _now ) {
		return { met: false, evidence: [], reason: 'no evidence predicate' };
	}

	flowRules() {
		return [];
	}

	gateRules() {
		return [];
	}

	allows() {
		return [];
	}

	// Whether this criterion admits a commitment of the given kind (a payment, a promise) made by the given move (6.2).
	admits( _commitment, _move = null ) {
		return false;
	}

	// K4: can a channel deliver the evidence this type needs? delivered is the Set of fact kinds the moves deliver.
	static channelled( delivered ) {
		return this.EVIDENCE.some( kind => delivered.has( kind ) );
	}

	// The facts that count for this criterion: valid ones (B2), and for an outcome none that arrived after its own
	// deadline. An invariant must hold the whole time, so a breach after its deadline still counts. A fact whose time or
	// validity cannot be read counts for nothing (fail closed).
	evidence( facts, now = Date.now() ) {
		const _until = this.deadline && this.kind !== 'invariant' ? Criterion.time( this.deadline ) : Infinity;
		const _unreadable = value => value !== undefined && value !== null && Number.isNaN( Criterion.time( value ) );
		return ( Array.isArray( facts ) ? facts : [] ).filter( fact => fact && typeof fact === 'object' && !fact.superseded
			&& !_unreadable( fact.time ) && !_unreadable( fact.validUntil )
			&& !( Criterion.time( fact.validUntil ) < now ) && !( Criterion.time( fact.time ) > _until ) );
	}

	// The gate's receipts for actions of the given selectors; the observation behind every invariant. B1: the same
	// receipt delivered twice (same id; a node never stores two facts under one id) is one receipt.
	static deliveries( facts, matches ) {
		const _seen = new Set();
		return facts.filter( ( fact ) => {
			if ( fact.kind !== 'delivered' || fact.evidenceClass !== 'observation' || !fact.data || typeof fact.data !== 'object' || !matches( fact.data.action ) ) {
				return false;
			}
			if ( fact.id === undefined || fact.id === null ) { return true; }
			if ( _seen.has( fact.id ) ) { return false; }
			_seen.add( fact.id );
			return true;
		} );
	}

	// The gate's receipts of releases: every receipt, whatever its action, that names a group as a list. A message without
	// a group is no release; one with a group that is no list never left with confidential data (10.4).
	static releases( facts ) {
		return Criterion.deliveries( facts, () => true ).filter( fact => Array.isArray( fact.data.cohort ) );
	}

	// The fact measured or read last: by its own time as an instant, not by the order it arrived in; of equal times the
	// one that arrived last. A fact without a time ranks before every fact with one.
	static latest( facts ) {
		let _latest = null;
		let _at = -Infinity;
		for ( const fact of facts ) {
			const _time = Criterion.time( fact.time );
			const _rank = Number.isNaN( _time ) ? -Infinity : _time;
			if ( _rank >= _at ) {
				_latest = fact;
				_at = _rank;
			}
		}
		return _latest;
	}

	// The same facts ordered by their own time (stable: equal times keep the order they arrived in).
	static byTime( facts ) {
		const _rank = ( fact ) => {
			const _time = Criterion.time( fact.time );
			return Number.isNaN( _time ) ? -Infinity : _time;
		};
		return [ ...facts ].sort( ( a, b ) => ( _rank( a ) === _rank( b ) ? 0 : _rank( a ) - _rank( b ) ) );
	}

	// An id or key as the gate reads it: a non-empty text (NFC, trimmed) or a finite number as its text, so 4711 and
	// '4711' are the same; anything else is no key → ''.
	static key( value ) {
		if ( typeof value === 'number' && Number.isFinite( value ) ) { return String( value ); }
		return typeof value === 'string' ? value.normalize( 'NFC' ).trim() : '';
	}

	// The people of a group as the gate counts them: distinct ids. → a Set, or null when one entry is no id (null, '',
	// an object), which refuses the whole group (fail closed).
	static people( cohort ) {
		const _ids = new Set();
		for ( const item of cohort ) {
			const _id = Criterion.key( item );
			if ( !_id ) { return null; }
			_ids.add( _id );
		}
		return _ids;
	}

	// An amount in whole cents as the gate reads it: a finite number of at least 0, or text that is one. → cents, or
	// null for anything that is no amount (negative, NaN, '1.000,50').
	static cents( value ) {
		const _number = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test( value ) ? Number( value ) : NaN;
		const _cents = Number.isFinite( _number ) && _number >= 0 ? Math.round( _number * 100 ) : NaN;
		return Number.isFinite( _cents ) ? _cents : null;
	}

	// A parameter of a receipt: only its own fields, never a name of Object.prototype.
	static param( data, name ) {
		const _params = data?.params && typeof data.params === 'object' ? data.params : {};
		return typeof name === 'string' && Object.hasOwn( _params, name ) ? _params[ name ] : undefined;
	}

	describe() {
		const { id, type, kind, values, immutable, deadline, origin, serves, byPerson } = this;
		return { id, type, kind, values, immutable, deadline, origin, serves, byPerson };
	}

	// K2: a window is a pair of times, the start before the end.
	static window( value ) {
		if ( !Array.isArray( value ) || value.length !== 2 || value.some( item => Number.isNaN( Criterion.time( item ) ) ) ) {
			return 'must be a window [from, to]';
		}
		return Criterion.time( value[ 0 ] ) < Criterion.time( value[ 1 ] ) ? null : 'starts after it ends (K2)';
	}

	// A time in ISO 8601 with its zone (Z or an offset), on a day that exists; core and gate read it the same in every
	// time zone. → milliseconds, or NaN.
	static time( value ) {
		const _match = typeof value === 'string'
			&& value.match( /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/ );
		if ( !_match ) { return NaN; }
		const [ , _y, _m, _d, _h, _min ] = _match.map( Number );
		const _last = new Date( Date.UTC( _y, _m, 0 ) ).getUTCDate();
		if ( _m < 1 || _m > 12 || _d < 1 || _d > _last || _h > 23 || _min > 59 ) { return NaN; }
		return Date.parse( value );
	}

	// Inside the window, both ends included; a time that cannot be read is never inside.
	static inWindow( time, window ) {
		const _t = Criterion.time( time );
		return !window || ( _t >= Criterion.time( window[ 0 ] ) && _t <= Criterion.time( window[ 1 ] ) );
	}

	// Is this rule at least as strict as other (same type)? Equal values by default; types with a size override it.
	atLeastAsStrict( other ) {
		return this.type === other?.type && Hash.canonical( this.values ) === Hash.canonical( other.values );
	}

	// '@actions' stands for every action of the action table and every class of actions.
	static values( param ) {
		if ( param.values !== '@actions' ) { return param.values || null; }
		const _actions = app.get( 'Lib.Actions' ).load();
		const _classes = [ ...new Set( Object.values( _actions.table ).flatMap( entry => ( entry.carries || [] ).map( item => `carries:${item}` ) ) ) ];
		return [ ...Object.keys( _actions.table ), ..._classes, 'outward' ];
	}

	static checkParam( value, param ) {
		if ( value === undefined || value === null || value === '' ) {
			return param.optional ? null : 'is missing';
		}
		const _check = Criterion.CHECKS[ param.type ];
		return _check ? _check( value, param ) : null;
	}

	static least( param ) {
		return param.min === undefined ? '' : ` >= ${param.min}`;
	}

	// One check per parameter type; each answers with a problem or null.
	static CHECKS = {
		integer: ( value, param ) => ( !Number.isInteger( value ) || value < ( param.min ?? -Infinity ) ? `must be an integer${Criterion.least( param )}` : null ),
		number: ( value, param ) => ( typeof value !== 'number' || Number.isNaN( value ) || value < ( param.min ?? -Infinity )
			? `must be a number${Criterion.least( param )}` : null ),
		list: ( value, param ) => {
			const _values = Criterion.values( param );
			if ( !Array.isArray( value ) || !value.length ) { return 'must be a non-empty list'; }
			if ( _values ) { return [ ...value ].some( item => !_values.includes( item ) ) ? `may only contain ${_values.join( ', ' )}` : null; }
			// An empty entry (null, a hole, '') names nothing: no item, no outcome.
			return [ ...value ].some( item => item === null || item === undefined || item === '' ) ? 'may not contain empty entries' : null;
		},
		string: ( value, param ) => {
			const _values = Criterion.values( param );
			if ( typeof value !== 'string' ) { return 'must be text'; }
			return _values && !_values.includes( value ) ? `must be one of ${_values.join( ', ' )}` : null;
		},
		datetime: value => ( Number.isNaN( Criterion.time( value ) ) ? 'must be a date and time in ISO 8601 with its zone' : null ),
		window: value => Criterion.window( value ),
		boolean: value => ( typeof value === 'boolean' ? null : 'must be true or false' ),
		object: value => ( value && typeof value === 'object' && !Array.isArray( value ) ? null : 'must be an object' ),
	};

} );
