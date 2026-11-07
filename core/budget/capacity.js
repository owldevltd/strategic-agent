// The daily capacity of the people (P6): a soft gate from the base setup, so that a large pot cannot buy a
// person's whole day. Before a ticket goes to a person its minutes are counted against the day. When the day is
// full, the ticket waits for the next day with room if its deadline allows it; otherwise it goes out marked.
// The day is the calendar day in the time zone of the base setup (timeZone, an IANA name such as Europe/Berlin; UTC
// when it names none), and dayStartsHour is an hour of that day there.

app.define( 'Core.Budget.Capacity', [ 'Lib.Missions' ], Missions => class Capacity {

	// file: the base setup (AGENCY_BASE, else catalog/base.json; see Lib.Missions.base).
	static load( file = undefined ) {
		const _base = Missions.base( file );
		const { dailyCapacityMin = 60, dayStartsHour = 8, timeZone } = _base;
		return new Capacity( { dailyMinutes: dailyCapacityMin ?? 60, dayStartsHour: dayStartsHour ?? 8, timeZone } );
	}

	constructor( { dailyMinutes = 60, dayStartsHour = 8, timeZone = 'UTC' } = {}, now = () => Date.now() ) {
		Object.assign( this, { dailyMinutes, dayStartsHour, now, timeZone: Capacity.zone( timeZone ) } );
		this.used = new Map();
	}

	// An IANA time zone the runtime knows; anything else stops the start, so no day is counted in a zone nobody meant.
	static zone( name = 'UTC' ) {
		const _name = name ?? 'UTC';
		if ( typeof _name !== 'string' || !_name ) { throw new RangeError( `timeZone: ${typeof _name === 'string' ? '""' : typeof _name} is no time zone` ); }
		try {
			return new Intl.DateTimeFormat( 'en-US', { timeZone: _name } ).resolvedOptions().timeZone;
		} catch {
			throw new RangeError( `timeZone: ${typeof _name === 'string' ? JSON.stringify( _name.slice( 0, 60 ) ) : typeof _name} is no time zone` );
		}
	}

	// The calendar day and the hour of a moment in a zone: { date: 'YYYY-MM-DD', hour, minute }.
	static local( time, timeZone = 'UTC' ) {
		const _parts = Object.fromEntries( new Intl.DateTimeFormat( 'en-CA', {
			timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
		} ).formatToParts( new Date( time ) ).map( part => [ part.type, part.value ] ) );
		return { date: `${_parts.year}-${_parts.month}-${_parts.day}`, hour: Number( _parts.hour ), minute: Number( _parts.minute ) };
	}

	// The moment a day of a zone reaches an hour: from the same wall clock read as UTC, less the zone's offset then.
	static at( date, hour, timeZone = 'UTC' ) {
		const _wall = Date.parse( `${date}T00:00:00Z` ) + hour * 3600000;
		let _time = _wall;
		for ( let i = 0; i < 2; i++ ) {
			const _seen = Capacity.local( _time, timeZone );
			_time += _wall - ( Date.parse( `${_seen.date}T00:00:00Z` ) + ( _seen.hour * 60 + _seen.minute ) * 60000 );
		}
		return _time;
	}

	// → { ok } now, { notBefore } on the first later day with room, or { marked } when the deadline does not allow
	// waiting for one. Minutes are a finite number of at least zero (text is read as its number); anything else is
	// counted nowhere, and the ticket goes out at once, marked, so a person still sees it.
	take( minutes, deadline = null ) {
		const _day = Capacity.day( this.now(), this.timeZone );
		const _used = this.used.get( _day ) || 0;
		const _minutes = typeof minutes === 'number' || ( typeof minutes === 'string' && minutes.trim() !== '' ) ? Number( minutes ) : NaN;
		if ( !Number.isFinite( _minutes ) || _minutes < 0 ) {
			return { marked: true, used: _used, of: this.dailyMinutes, invalid: true };
		}
		// A ticket of no minutes takes nobody's time: it goes out even on a day that is over its capacity.
		if ( _minutes === 0 || _used + _minutes <= this.dailyMinutes ) {
			this.used.set( _day, _used + _minutes );
			return { ok: true, used: _used + _minutes, of: this.dailyMinutes };
		}
		const _later = this._later( _day, _minutes, deadline );
		if ( _later ) {
			const _laterDay = Capacity.day( _later.getTime(), this.timeZone );
			this.used.set( _laterDay, ( this.used.get( _laterDay ) || 0 ) + _minutes );
			return { notBefore: _later.toISOString(), used: _used, of: this.dailyMinutes };
		}
		this.used.set( _day, _used + _minutes );
		return { marked: true, used: _used + _minutes, of: this.dailyMinutes };
	}

	// The start of the first day after today that still has room for the minutes, as long as the deadline lies more than
	// an hour after that start; a ticket larger than a whole day fits no day. Days without bookings always have room, so
	// the walk ends after the booked days.
	_later( today, minutes, deadline ) {
		const _deadline = deadline ? Date.parse( deadline ) : NaN;
		if ( !( minutes <= this.dailyMinutes ) || Number.isNaN( _deadline ) ) { return null; }
		const _start = new Date( `${today}T00:00:00Z` );
		for ( let days = 1; days <= this.used.size + 1; days++ ) {
			const _date = new Date( _start );
			_date.setUTCDate( _date.getUTCDate() + days );
			const _next = new Date( Capacity.at( _date.toISOString().slice( 0, 10 ), this.dayStartsHour, this.timeZone ) );
			if ( !( _deadline > _next.getTime() + 3600000 ) ) { return null; }
			if ( ( this.used.get( Capacity.day( _next.getTime(), this.timeZone ) ) || 0 ) + minutes <= this.dailyMinutes ) { return _next; }
		}
		return null;
	}

	static day( time, timeZone = 'UTC' ) {
		if ( timeZone === 'UTC' ) { return new Date( time ).toISOString().slice( 0, 10 ); }
		return Capacity.local( time, timeZone ).date;
	}

} );
