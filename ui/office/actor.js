// One figure in the office: an agent (a node of the tree), a person, the guard. Positions are in tiles, the
// point is where the feet stand. A figure walks to a target, carries labels and maybe a thing, and can say
// something in a bubble for a while.

app.define( 'Ui.Office.Actor', [ 'Ui.Office.Sprites' ], Sprites => class Actor {

	constructor( { id, sprite = Sprites.PERSON, step = null, swap = null, scale = 3, x = 0, y = 0, name = '' } ) {
		Object.assign( this, { id, sprite, step, swap, scale, x, y, name } );
		this.labels = [];
		this.carry = null;
		this.bubble = null;
		this.target = null;
		this.facing = 1;
		this.alpha = 1;
		this.marks = [];
		this._arrive = [];
	}

	// → a promise that resolves when the figure stands at the target.
	walkTo( x, y ) {
		this.target = { x, y };
		return new Promise( resolve => this._arrive.push( resolve ) );
	}

	say( text, tone = 'plain', until = Infinity ) {
		this.bubble = { text, tone, until };
	}

	update( dt, speed ) {
		if ( this.bubble && performance.now() > this.bubble.until ) {
			this.bubble = null;
		}
		if ( !this.target ) { return; }
		const _dx = this.target.x - this.x;
		const _dy = this.target.y - this.y;
		const _distance = Math.hypot( _dx, _dy );
		const _step = 4.5 * speed * dt;
		if ( _distance <= _step ) {
			this.x = this.target.x;
			this.y = this.target.y;
			this.target = null;
			this._arrive.splice( 0 ).forEach( resolve => resolve() );
			return;
		}
		if ( Math.abs( _dx ) > 0.01 ) { this.facing = Math.sign( _dx ); }
		this.x += ( _dx / _distance ) * _step;
		this.y += ( _dy / _distance ) * _step;
	}

	// Where the figure is drawn, in pixels: the sprite stands on its feet point.
	box( tile ) {
		const _w = this.sprite[ 0 ].length * this.scale;
		const _h = this.sprite.length * this.scale;
		return { x: this.x * tile - _w / 2, y: this.y * tile - _h, w: _w, h: _h };
	}

	draw( painter, tile, now ) {
		const _box = this.box( tile );
		const _walking = Boolean( this.target ) && this.step;
		const _grid = _walking && Math.floor( now / 160 ) % 2 ? this.step : this.sprite;
		painter.ctx.globalAlpha = this.alpha;
		painter.draw( _grid, _box.x, _box.y, { swap: this.swap, scale: this.scale, flip: this.facing < 0 } );
		const _bob = Math.round( Math.sin( now / 220 ) * 2 );
		this.labels.forEach( ( label, i ) => {
			painter.draw( Sprites.LABEL, _box.x + _box.w - 6 + i * 16, _box.y - 10 + _bob, { fill: Sprites.LABELS[ label ] || '#999', scale: 3 } );
		} );
		if ( this.carry ) {
			painter.draw( this.carry, _box.x + _box.w - 10, _box.y + _box.h * 0.45, { scale: 3 } );
		}
		this.marks.forEach( ( mark, i ) => painter.draw( mark, _box.x - 22 - i * 4, _box.y + 4, { scale: 3 } ) );
		painter.ctx.globalAlpha = 1;
	}

	drawBubble( painter, tile ) {
		if ( !this.bubble ) { return; }
		const _box = this.box( tile );
		painter.bubble( this.bubble.text, _box.x + _box.w / 2, _box.y - ( this.labels.length ? 14 : 2 ), { tone: this.bubble.tone } );
	}

} );
