// The pixel office: our room with its stations, the neighbour's room next door, and the street outside where the
// world lives. It draws itself every frame; the director tells figures where to go and what to show. All times
// shrink with speed, so a backlog of events plays faster instead of falling behind.

app.define( 'Ui.Office.Stage', [ 'Ui.Office.Sprites', 'Ui.Office.Painter', 'Ui.Office.Actor' ], ( Sprites, Painter, Actor ) => class Stage {

	static TILE = 48;
	static WIDTH = 22;
	static HEIGHT = 10;

	// Where figures walk to (feet points, in tiles).
	static POINTS = {
		home: { x: 7, y: 5.3 }, vault: { x: 2.6, y: 3.7 }, sandbox: { x: 5.6, y: 3.7 }, desk: { x: 10.4, y: 4.5 },
		inbox: { x: 2.1, y: 6.7 }, gate: { x: 12.4, y: 6.6 }, door: { x: 12.5, y: 8.1 }, neighbour: { x: 18.5, y: 5.2 },
		neighbourDoor: { x: 18.6, y: 8.1 }, slot: { x: 1.2, y: 7.9 },
	};

	constructor( canvas ) {
		canvas.width = Stage.WIDTH * Stage.TILE;
		canvas.height = Stage.HEIGHT * Stage.TILE;
		this.canvas = canvas;
		this.painter = new Painter( canvas, 3 );
		this.speed = 1;
		this.agents = new Map();
		this.effects = [];
		this.counters = { ours: 0, theirs: 0 };
		this.state = { sandbox: false, inbox: 0 };
	}

	// scene: what the vault holds, who approves, who lives outside (the mission's office data).
	setMission( id, scene ) {
		this.mission = id;
		this.scene = { vault: 'vault', desk: 'a person approves', street: [], teams: {}, ...scene };
		this.agents.clear();
		this.effects = [];
		this.state = { sandbox: false, inbox: 0 };
		this.person = new Actor( { id: 'person', sprite: Sprites.PERSON, x: 10.5, y: 2.85, name: this.scene.desk } );
		this.guard = new Actor( { id: 'guard', sprite: Sprites.GUARD, x: 13.3, y: 7.3, name: 'gate' } );
		this.neighbour = new Actor( { id: 'neighbour', sprite: Sprites.AGENT, step: Sprites.AGENT_STEP, swap: 'neighbour', ...Stage.POINTS.neighbour } );
		this.street = new Map( this.scene.street.map( item => [ item.id, new Actor( {
			id: item.id, sprite: Sprites[ item.sprite || 'PERSON' ], swap: item.swap || null, x: item.x, y: 9.75, name: item.name || item.id,
		} ) ] ) );
	}

	start() {
		let _last = performance.now();
		const _frame = ( now ) => {
			const _dt = Math.min( 0.1, ( now - _last ) / 1000 );
			_last = now;
			this._figures().forEach( actor => actor.update( _dt, this.speed ) );
			this._draw( now );
			requestAnimationFrame( _frame );
		};
		requestAnimationFrame( _frame );
	}

	// The figure of a node: the root is our agent, a child a smaller clone that appears next to its parent.
	agent( nodeId, { depth = 0, parent = null } = {} ) {
		if ( !this.agents.has( nodeId ) ) {
			const _parent = parent && this.agents.get( parent );
			const _start = _parent ? { x: _parent.x + 0.8, y: _parent.y + 0.2 } : { ...Stage.POINTS.home };
			this.agents.set( nodeId, new Actor( {
				id: nodeId, sprite: Sprites.AGENT, step: Sprites.AGENT_STEP, scale: depth ? 2 : 3, ..._start, name: depth ? 'child' : 'agent',
			} ) );
			this.agents.get( nodeId ).depth = depth;
		}
		return this.agents.get( nodeId );
	}

	at( name ) {
		return typeof name === 'string' ? Stage.POINTS[ name ] : name;
	}

	// A place for each child next to the home spot, so siblings do not stand on each other.
	homeOf( actor ) {
		if ( !actor.depth ) { return Stage.POINTS.home; }
		const _index = [ ...this.agents.values() ].filter( item => item.depth ).indexOf( actor );
		return { x: 8.4 + ( _index % 5 ) * 0.9, y: 5.9 + Math.floor( _index / 5 ) * 0.6 };
	}

	walk( actor, place ) {
		const _to = this.at( place );
		return actor.walkTo( _to.x, _to.y );
	}

	wait( ms ) {
		return new Promise( resolve => setTimeout( resolve, ms / this.speed ) );
	}

	say( actor, text, tone = 'plain', ms = 2200 ) {
		actor.say( Stage.short( text ), tone, performance.now() + ms / this.speed );
	}

	// A thing flies from one place to another on an arc; → when it landed.
	fly( sprite, from, to, { ms = 800, scale = 3, arc = 1 } = {} ) {
		const _from = this.at( from );
		const _to = this.at( to );
		return new Promise( ( resolve ) => {
			const _start = performance.now();
			const _length = ms / this.speed;
			this.effects.push( {
				until: _start + _length,
				draw: ( p, now ) => {
					const _f = Math.min( 1, ( now - _start ) / _length );
					const _x = ( _from.x + ( _to.x - _from.x ) * _f ) * Stage.TILE;
					const _y = ( _from.y + ( _to.y - _from.y ) * _f - Math.sin( _f * Math.PI ) * arc ) * Stage.TILE;
					p.draw( sprite, _x - ( sprite[ 0 ].length * scale ) / 2, _y - sprite.length * scale - 20, { scale } );
				},
				done: resolve,
			} );
		} );
	}

	// A wall rises where a refusal stopped something, with the reason on it.
	wall( place, text, { ms = 3200 } = {} ) {
		const _at = this.at( place );
		const _start = performance.now();
		const _length = ms / this.speed;
		this.effects.push( {
			until: _start + _length,
			draw: ( p, now ) => {
				const _rise = Math.min( 1, ( now - _start ) / ( 300 / this.speed ) );
				const _h = Math.round( 64 * _rise );
				const _x = _at.x * Stage.TILE - 16;
				const _y = _at.y * Stage.TILE - _h;
				p.ctx.save();
				p.ctx.beginPath();
				p.ctx.rect( _x, _y, 32, _h );
				p.ctx.clip();
				p.draw( Sprites.WALL, _x, _at.y * Stage.TILE - 64, { scale: 2 } );
				p.draw( Sprites.WALL, _x, _at.y * Stage.TILE - 32, { scale: 2 } );
				p.ctx.restore();
				if ( _rise === 1 ) { p.bubble( Stage.short( text, 46 ), _at.x * Stage.TILE, _y - 2, { tone: 'no' } ); }
			},
		} );
		return this.wait( 900 );
	}

	// A tick or a cross over a figure or a place for a moment.
	mark( place, ok, { ms = 1600 } = {} ) {
		const _top = actor => actor.y - ( actor.sprite.length * actor.scale ) / Stage.TILE - 0.2;
		const _at = place instanceof Actor ? { x: place.x, y: _top( place ) } : this.at( place );
		const _until = performance.now() + ms / this.speed;
		this.effects.push( {
			until: _until,
			draw: p => p.draw( ok ? Sprites.STAMP : Sprites.CROSS, _at.x * Stage.TILE - 12, _at.y * Stage.TILE - 30, { scale: 3 } ),
		} );
	}

	puff( place ) {
		const _at = this.at( place );
		const _start = performance.now();
		const _length = 500 / this.speed;
		this.effects.push( {
			until: _start + _length,
			draw: ( p, now ) => {
				const _f = ( now - _start ) / _length;
				p.ctx.fillStyle = `rgba(255,255,255,${0.8 * ( 1 - _f )})`;
				for ( let i = 0; i < 6; i++ ) {
					const _a = ( i / 6 ) * Math.PI * 2;
					const _px = _at.x * Stage.TILE + Math.cos( _a ) * 30 * _f;
					const _py = _at.y * Stage.TILE - 30 + Math.sin( _a ) * 20 * _f;
					p.ctx.fillRect( _px - 4, _py - 4, 8, 8 );
				}
			},
		} );
	}

	_figures() {
		return [ this.person, this.guard, this.neighbour, ...this.street.values(), ...this.agents.values() ].filter( Boolean );
	}

	_draw( now ) {
		const p = this.painter;
		const T = Stage.TILE;
		p.ctx.fillStyle = '#1c1b29';
		p.ctx.fillRect( 0, 0, this.canvas.width, this.canvas.height );
		this._room( p, T );
		const _figures = this._figures().sort( ( a, b ) => a.y - b.y );
		for ( const actor of _figures ) {
			actor.draw( p, T, now );
			if ( actor === this.person ) {
				p.draw( Sprites.DESK, 9.5 * T, 2.45 * T );
			}
		}
		this.effects = this.effects.filter( ( effect ) => {
			effect.draw( p, now );
			if ( now < effect.until ) { return true; }
			effect.done?.();
			return false;
		} );
		_figures.forEach( actor => actor.drawBubble( p, T ) );
	}

	_room( p, T ) {
		const _ctx = p.ctx;
		p.tile( Sprites.BACKWALL, 0, 0, 16, 2 );
		p.tile( Sprites.FLOOR, 0, 2 * T, 16, 6 );
		p.tile( Sprites.BACKWALL, 16 * T, 0, 6, 2, { swap: null } );
		p.tile( Sprites.FLOOR, 16 * T, 2 * T, 6, 6 );
		_ctx.fillStyle = '#23213a';
		_ctx.fillRect( 16 * T - 3, 0, 6, 8 * T );
		// The bottom wall with our door (the gate), the mail slot and the neighbour's door.
		_ctx.fillRect( 0, 7.8 * T, Stage.WIDTH * T, 0.2 * T );
		_ctx.fillStyle = '#3a394f';
		_ctx.fillRect( 0, 8 * T, Stage.WIDTH * T, 2 * T );
		_ctx.fillStyle = '#46455e';
		_ctx.fillRect( 0, 8 * T, Stage.WIDTH * T, 0.25 * T );
		for ( const [ x, w ] of [ [ 11.8, 1.4 ], [ 18, 1.2 ] ] ) {
			_ctx.fillStyle = '#c8c2b6';
			_ctx.fillRect( x * T, 7.8 * T, w * T, 0.45 * T );
		}
		_ctx.fillStyle = '#23213a';
		_ctx.fillRect( 1 * T, 7.82 * T, 0.6 * T, 0.12 * T );
		this._stations( p, T );
		this._captions( p, T );
	}

	_stations( p, T ) {
		const _ctx = p.ctx;
		p.draw( Sprites.VAULT, 1.85 * T, 1.3 * T );
		p.draw( Sprites.SANDBOX, 4.85 * T, 1.3 * T );
		if ( this.state.sandbox ) {
			_ctx.strokeStyle = '#f4c542';
			_ctx.lineWidth = 4;
			_ctx.strokeRect( 4.85 * T + 6, 1.3 * T + 3, 36, 36 );
		}
		p.draw( Sprites.PLANT, 7.4 * T, 1.4 * T );
		p.draw( Sprites.PLANT, 14.6 * T, 1.4 * T );
		p.draw( Sprites.INBOX, 1.4 * T, 5.9 * T );
		for ( let i = 0; i < Math.min( this.state.inbox, 4 ); i++ ) {
			p.draw( Sprites.LETTER, 1.6 * T + i * 4, 5.75 * T - i * 5, { scale: 3 } );
		}
		p.draw( Sprites.VAULT, 19.3 * T, 1.3 * T );
	}

	_captions( p, T ) {
		this._caption( p, this.scene.vault, 1.8 * T, 2.85 * T );
		this._caption( p, 'sandbox · no network', 4.4 * T, 2.85 * T );
		this._caption( p, this.scene.desk, 9.1 * T, 3.75 * T );
		this._caption( p, 'inbox', 1.5 * T, 7.6 * T );
		this._caption( p, 'gate', 12.3 * T, 7.6 * T );
		this._caption( p, 'neighbour office · same model, no gate', 16.3 * T, 7.6 * T );
		this._caption( p, 'outside', 0.2 * T, 8.45 * T );
		for ( const actor of this.street.values() ) {
			if ( actor.name && actor.name !== actor.id ) { this._caption( p, actor.name, actor.x * T - 24, 9.95 * T ); }
		}
		// The counters are the demo's (AGENCY_DEMO=1); without it there are none.
		if ( this.counters ) {
			this._sign( p, `ours: ${this.counters.ours}`, 10.4 * T, 0.55 * T, '#1f7a4d' );
			this._sign( p, `next door: ${this.counters.theirs}`, 16.5 * T, 0.55 * T, '#b3261e' );
		}
	}

	_caption( p, text, x, y ) {
		p.ctx.font = 'bold 12px ui-monospace, Menlo, monospace';
		const _w = p.ctx.measureText( text ).width + 8;
		p.ctx.fillStyle = 'rgba(35,33,58,.78)';
		p.ctx.fillRect( x - 4, y - 12, _w, 17 );
		p.ctx.fillStyle = '#fff';
		p.ctx.fillText( text, x, y );
	}

	_sign( p, text, x, y, colour ) {
		p.ctx.font = 'bold 15px ui-monospace, Menlo, monospace';
		const _w = p.ctx.measureText( text ).width + 14;
		p.ctx.fillStyle = '#23213a';
		p.ctx.fillRect( x - 2, y - 20, _w + 4, 28 );
		p.ctx.fillStyle = '#ffffff';
		p.ctx.fillRect( x, y - 18, _w, 24 );
		p.ctx.fillStyle = colour;
		p.ctx.fillText( text, x + 7, y );
	}

	static short( text, max = 40 ) {
		const _text = String( text ?? '' ).replace( /\s+/g, ' ' ).trim();
		return _text.length > max ? `${_text.slice( 0, max - 1 )}…` : _text;
	}

} );
