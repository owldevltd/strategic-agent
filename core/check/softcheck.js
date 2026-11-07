// Soft gates (chapters 7.3, 21): key/value from the user's base setup, plus learned preferences. The code knows every
// key: what a writer is told and how an outgoing text is checked. They are not walls but quality rules: writers get
// them as instructions; an outgoing text that still breaks one is reworked once, and if it still breaks it, the
// action goes on only marked, at the person's approval. Learned preferences never override the user's own values.
// A value the code cannot read is refused with its key named, never guessed into the opposite rule.

app.define( 'Core.Check.SoftCheck', [ 'Lib.Actions', 'Lib.Missions' ], Actions => class SoftCheck {

	static DAYS = [ 'sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat' ];

	// The ways a day is written, in English and in the paper's German (21: "keine_anrufe": ["sa", "so"]).
	static DAY_NAMES = {
		sun: [ 'sun', 'sunday', 'so', 'sonntag' ], mon: [ 'mon', 'monday', 'mo', 'montag' ], tue: [ 'tue', 'tuesday', 'di', 'dienstag' ],
		wed: [ 'wed', 'wednesday', 'mi', 'mittwoch' ], thu: [ 'thu', 'thursday', 'do', 'donnerstag' ], fri: [ 'fri', 'friday', 'fr', 'freitag' ],
		sat: [ 'sat', 'saturday', 'sa', 'samstag', 'sonnabend' ],
	};

	// The ways an address is written; the paper's own value is "sie".
	static ADDRESS = { formal: [ 'formal', 'sie', 'siezen' ], informal: [ 'informal', 'du', 'duzen' ] };

	// An amount of money in a text: a number next to a currency, either way round, also split over two lines or two
	// fields (a writer cannot hide one that way). Linear: a number only starts where no digit, point, comma or letter
	// stands before it, so a long run of digits is read once, not once per digit, and the digits of an id (C102) are
	// no amount.
	// Every currency sign Unicode knows (€, £, ¥, $, ₹, ₽, …) and the common codes.
	static CURRENCY = '\\p{Sc}|EUR|USD|GBP|CHF|JPY|INR|CNY|SEK|NOK|DKK|PLN|CZK';
	static PRICE = new RegExp( `(?<![\\d.,\\p{L}])[.,]*\\d[\\d.,]*\\s?(?:${SoftCheck.CURRENCY})|(?:${SoftCheck.CURRENCY})\\s?\\d[\\d.,]*`, 'iu' );

	// key → for which actions ("written": every action that carries a message; "outside": those that leave the company,
	// as the action table says, 7.3: every kind of rule holds everywhere), how its value is read, what the writer is
	// told, and what in a text breaks it (null: nothing).
	static KEYS = {
		address: {
			actions: 'written',
			read: value => SoftCheck.address( value ),
			says: value => ( value === 'formal' ? 'Address people formally.' : 'Address people informally.' ),
			find: () => null,
		},
		namePrices: {
			actions: 'outside',
			read: value => SoftCheck.flag( 'namePrices', value ),
			says: value => ( value ? '' : 'Never mention prices or amounts of money in messages to people outside the company.' ),
			find: ( value, texts ) => ( value ? null : texts.join( '\n' ).match( SoftCheck.PRICE )?.[ 0 ] || null ),
		},
		exclamations: {
			actions: 'written',
			read: value => SoftCheck.flag( 'exclamations', value ),
			says: value => ( value ? '' : 'Write politely and factually, without exclamation marks.' ),
			find: ( value, texts ) => ( !value && texts.some( text => text.includes( '!' ) ) ? '!' : null ),
		},
		noContactOn: {
			actions: 'outside',
			read: value => SoftCheck.days( value ),
			says: value => ( value.length ? `Never contact anyone outside the company on ${value.join( ', ' )}.` : '' ),
			find: ( value, _texts, now, timeZone ) => {
				const _day = SoftCheck.weekday( now, timeZone );
				return value.includes( _day ) ? _day : null;
			},
		},
	};

	// file: the base setup (AGENCY_BASE, else catalog/base.json; see Lib.Missions.base).
	static load( file = undefined ) {
		return new SoftCheck( app.get( 'Lib.Missions' ).base( file ) );
	}

	// The day of the week of a moment in the base setup's time zone (UTC when it names none): 'sun' to 'sat'.
	static weekday( now, timeZone = 'UTC' ) {
		const _name = new Intl.DateTimeFormat( 'en-US', { timeZone: timeZone || 'UTC', weekday: 'short' } ).format( now );
		return _name.slice( 0, 3 ).toLowerCase();
	}

	// base: the user's key/values; base.learned: preferences learned later, below the user's own values. Only the
	// code's own keys make rules: a key named like a property of every object (constructor, __proto__) is just a value.
	// A key set to null says nothing.
	// actions: the action table (Lib.Actions) that says which actions carry a message and which stay inside; without
	// one, the catalog's and the missions'.
	constructor( base = {}, actions = null ) {
		this.actions = actions || Actions.load();
		const { learned = {}, ...own } = base && typeof base === 'object' ? base : {};
		this.values = { ...( learned && typeof learned === 'object' ? learned : {} ), ...own };
		// The days of the base setup are those of its time zone; one the runtime does not know stops the start.
		this.timeZone = SoftCheck.zone( this.values.timeZone );
		const _known = ( [ key, value ] ) => Object.hasOwn( SoftCheck.KEYS, key ) && value !== null && value !== undefined;
		this.rules = Object.entries( this.values ).filter( _known ).map( ( [ key, given ] ) => {
			const _key = SoftCheck.KEYS[ key ];
			const _value = _key.read( given );
			return { id: key, value: _value, origin: Object.hasOwn( own, key ) ? 'user' : 'learned', ..._key, says: _key.says( _value ) };
		} );
	}

	static address( value ) {
		const _given = typeof value === 'string' ? value.trim().toLowerCase() : null;
		const _kind = Object.keys( SoftCheck.ADDRESS ).find( kind => SoftCheck.ADDRESS[ kind ].includes( _given ) );
		if ( !_kind ) { throw new Error( `address: ${SoftCheck.shown( value )} is neither formal (sie) nor informal (du)` ); }
		return _kind;
	}

	static flag( key, value ) {
		if ( typeof value !== 'boolean' ) { throw new Error( `${key}: ${SoftCheck.shown( value )} is neither true nor false` ); }
		return value;
	}

	// Quiet days: a list of days (one day alone is read as a list of one), each in any of its spellings.
	static days( value ) {
		const _list = typeof value === 'string' ? [ value ] : value;
		if ( !Array.isArray( _list ) ) { throw new Error( `noContactOn: ${SoftCheck.shown( value )} is no list of days` ); }
		const _codes = _list.map( ( day ) => {
			const _given = typeof day === 'string' ? day.trim().toLowerCase() : null;
			const _code = SoftCheck.DAYS.find( code => SoftCheck.DAY_NAMES[ code ].includes( _given ) );
			if ( !_code ) { throw new Error( `noContactOn: ${SoftCheck.shown( day )} is no day of the week` ); }
			return _code;
		} );
		return [ ...new Set( _codes ) ];
	}

	static zone( name ) {
		const _name = name ?? 'UTC';
		if ( typeof _name !== 'string' || !_name ) { throw new Error( `timeZone: ${SoftCheck.shown( _name )} is no time zone` ); }
		try {
			return new Intl.DateTimeFormat( 'en-US', { timeZone: _name } ).resolvedOptions().timeZone;
		} catch {
			throw new Error( `timeZone: ${SoftCheck.shown( _name )} is no time zone` );
		}
	}

	static shown( value ) {
		return typeof value === 'string' ? JSON.stringify( value.slice( 0, 40 ) ) : typeof value;
	}

	// Whether a rule holds for an action: a written rule for every action that carries a message, an outside rule for
	// those of them the table does not mark as staying inside the company. An action the table does not know carries
	// nothing it could say.
	applies( rule, action ) {
		return rule.actions === 'outside' ? this.actions.outside( action ) : this.actions.matches( 'carries:message', action );
	}

	instructions( action = null ) {
		const _rules = this.rules.filter( rule => rule.says && ( !action || this.applies( rule, action ) ) );
		return _rules.length ? `Rules of the user's base setup: ${_rules.map( rule => rule.says ).join( ' ' )}` : '';
	}

	check( action, params, now = new Date() ) {
		const _texts = SoftCheck.texts( params );
		return this.rules.filter( rule => this.applies( rule, action ) ).flatMap( ( rule ) => {
			const _found = rule.find( rule.value, _texts, now, this.timeZone );
			return _found ? [ { id: rule.id, says: rule.says, found: _found } ] : [];
		} );
	}

	// Every text an action would carry, also inside lists and nested objects, in their order; numbers are no text.
	// Walked with a stack of its own, so no nesting is too deep and no object is read twice.
	static texts( params ) {
		const _out = [];
		const _seen = new Set();
		const _stack = [ params ];
		while ( _stack.length ) {
			const _value = _stack.pop();
			if ( typeof _value === 'string' ) {
				_out.push( _value );
			} else if ( _value && typeof _value === 'object' && !_seen.has( _value ) ) {
				_seen.add( _value );
				const _items = Object.values( _value );
				for ( let i = _items.length - 1; i >= 0; i-- ) { _stack.push( _items[ i ] ); }
			}
		}
		return _out;
	}

} );
