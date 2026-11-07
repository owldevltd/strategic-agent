// In-process events. Handlers run in the order they subscribed; one that fails is reported to app.fail and never
// stops the others or the emitter.

app.define( 'Lib.Bus', [], () => class Bus {

	constructor() {
		this._handlers = new Map();
	}

	on( name, cb ) {
		if ( !this._handlers.has( name ) ) {
			this._handlers.set( name, new Set() );
		}
		this._handlers.get( name ).add( cb );
		return () => this.off( name, cb );
	}

	// A name without handlers leaves no entry behind, so names that come and go do not pile up.
	off( name, cb ) {
		const _set = this._handlers.get( name );
		if ( _set?.delete( cb ) && _set.size === 0 ) {
			this._handlers.delete( name );
		}
	}

	// Delivers to the handlers subscribed when the emit began: one added or removed by a handler counts from the
	// next emit on. An async handler that rejects is reported like one that throws.
	emit( name, data ) {
		const _set = this._handlers.get( name );
		if ( !_set ) { return; }
		for ( const cb of [ ..._set ] ) {
			try {
				const _result = cb( data );
				if ( _result && typeof _result.then === 'function' ) {
					_result.then( undefined, error => app.fail( error ) );
				}
			} catch ( error ) {
				app.fail( error );
			}
		}
	}

} );
