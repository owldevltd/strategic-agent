// The cause codes of walls (16.4) are catalog data: what each means, which gate rules produce it, and whether it
// belongs to the strategy (then another strategy may answer it, U3). Walls are compared by these codes only.

app.define( 'Core.Move.Causes', [], () => class Causes {

	static load( file = 'catalog/causes.json' ) {
		const _path = app.lib( 'node:path' ).join( app.root, file );
		return new Causes( JSON.parse( app.lib( 'node:fs' ).readFileSync( _path, 'utf8' ) ) );
	}

	// A broken table is refused at load with the name of the broken entry, never half read. A gate rule belongs to one
	// cause; when two claim it, the first wins and validate() reports the second.
	constructor( table ) {
		if ( !table || typeof table !== 'object' || Array.isArray( table ) ) { throw new Error( 'the cause catalog is no object of causes' ); }
		for ( const [ cause, entry ] of Object.entries( table ) ) {
			if ( !entry || typeof entry !== 'object' || Array.isArray( entry ) ) { throw new Error( `cause ${cause}: its entry is no object` ); }
			if ( entry.rules !== undefined && !( Array.isArray( entry.rules ) && entry.rules.every( rule => typeof rule === 'string' ) ) ) {
				throw new Error( `cause ${cause}: its rules are no list of rule names` );
			}
		}
		this.table = table;
		this._byRule = new Map();
		this._duplicates = [];
		for ( const [ cause, entry ] of Object.entries( table ) ) {
			for ( const rule of entry.rules || [] ) {
				if ( this._byRule.has( rule ) ) {
					this._duplicates.push( `the gate rule ${rule} belongs to ${this._byRule.get( rule )} and to ${cause}; ${this._byRule.get( rule )} counts` );
				} else {
					this._byRule.set( rule, cause );
				}
			}
		}
	}

	codes() {
		return Object.keys( this.table );
	}

	// The cause of a refusal by a gate rule; an unknown rule keeps its own name.
	ofRule( rule ) {
		return this._byRule.get( rule ) || rule;
	}

	ofStrategy( cause ) {
		return typeof cause === 'string' && Object.hasOwn( this.table, cause ) && this.table[ cause ].strategy === true;
	}

	// → the problems of the table: a code the memory and the diagnosis cannot read, a meaning missing, a strategy flag
	// that is no boolean, a gate rule claimed by two causes.
	validate() {
		const _problems = [];
		for ( const [ cause, entry ] of Object.entries( this.table ) ) {
			if ( !/^[a-z][a-z_]{1,40}$/.test( cause ) ) { _problems.push( `cause ${cause}: the code must be lower case letters and _` ); }
			if ( typeof entry.says !== 'string' || !entry.says.trim() ) { _problems.push( `cause ${cause}: says what it means` ); }
			if ( typeof entry.strategy !== 'boolean' ) { _problems.push( `cause ${cause}: strategy must be true or false` ); }
		}
		return [ ..._problems, ...this._duplicates ];
	}

} );
