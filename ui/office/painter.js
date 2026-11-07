// Draws sprites from Ui.Office.Sprites onto a canvas, pixel for pixel at an integer scale, never smoothed.
// Each sprite and colour variant is turned into a small image once and then only copied.

app.define( 'Ui.Office.Painter', [ 'Ui.Office.Sprites' ], Sprites => class Painter {

	constructor( canvas, scale = 3 ) {
		this.canvas = canvas;
		this.ctx = canvas.getContext( '2d' );
		this.scale = scale;
		this._cache = new Map();
	}

	// swap: a palette variant (Sprites.SWAPS), fill: the colour for '#' (labels).
	image( grid, { swap = null, fill = null } = {} ) {
		const _key = `${Sprites.key( grid )}|${swap}|${fill}`;
		if ( this._cache.has( _key ) ) { return this._cache.get( _key ); }
		const _palette = { ...Sprites.PALETTE, ...( Sprites.SWAPS[ swap ] || {} ), '#': fill };
		const _image = document.createElement( 'canvas' );
		_image.width = grid[ 0 ].length;
		_image.height = grid.length;
		const _ctx = _image.getContext( '2d' );
		grid.forEach( ( row, y ) => [ ...row ].forEach( ( char, x ) => {
			if ( char === '.' || !_palette[ char ] ) { return; }
			_ctx.fillStyle = _palette[ char ];
			_ctx.fillRect( x, y, 1, 1 );
		} ) );
		this._cache.set( _key, _image );
		return _image;
	}

	draw( grid, x, y, { swap = null, fill = null, scale = this.scale, flip = false } = {} ) {
		const _image = this.image( grid, { swap, fill } );
		const _w = _image.width * scale;
		const _h = _image.height * scale;
		this.ctx.imageSmoothingEnabled = false;
		this.ctx.save();
		if ( flip ) {
			this.ctx.translate( Math.round( x ) + _w, Math.round( y ) );
			this.ctx.scale( -1, 1 );
			this.ctx.drawImage( _image, 0, 0, _w, _h );
		} else {
			this.ctx.drawImage( _image, Math.round( x ), Math.round( y ), _w, _h );
		}
		this.ctx.restore();
		return { w: _w, h: _h };
	}

	// Fills an area with a tile, e.g. the floor.
	tile( grid, x, y, columns, rows, options = {} ) {
		const _size = grid[ 0 ].length * this.scale;
		for ( let row = 0; row < rows; row++ ) {
			for ( let column = 0; column < columns; column++ ) {
				this.draw( grid, x + column * _size, y + row * grid.length * this.scale, options );
			}
		}
	}

	// A speech bubble in the style of the sprites: square corners, outline, a small tail.
	bubble( text, x, y, { tone = 'plain', size = 13 } = {} ) {
		const _ctx = this.ctx;
		const _colours = { plain: [ '#ffffff', '#23213a' ], no: [ '#ffe3e1', '#b3261e' ], ok: [ '#e2f6ea', '#1f7a4d' ], wait: [ '#fff4d6', '#8a5a00' ] }[ tone ];
		_ctx.font = `bold ${size}px ui-monospace, Menlo, Consolas, monospace`;
		const _w = Math.ceil( _ctx.measureText( text ).width ) + 14;
		const _h = size + 12;
		// Bubbles stay on the canvas, also for figures at the edge.
		const _x = Math.round( Math.min( Math.max( x - _w / 2, 4 ), this.canvas.width - _w - 4 ) );
		const _y = Math.round( Math.max( y - _h - 8, 4 ) );
		_ctx.fillStyle = '#23213a';
		_ctx.fillRect( _x - 2, _y - 2, _w + 4, _h + 4 );
		const _tail = Math.min( Math.max( Math.round( x ), _x + 6 ), _x + _w - 6 );
		_ctx.fillRect( _tail - 4, _y + _h, 8, 6 );
		_ctx.fillStyle = _colours[ 0 ];
		_ctx.fillRect( _x, _y, _w, _h );
		_ctx.fillRect( _tail - 2, _y + _h, 4, 4 );
		_ctx.fillStyle = _colours[ 1 ];
		_ctx.fillText( text, _x + 7, _y + size + 3 );
	}

} );
