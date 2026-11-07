// The pixel art of the office, as data: every sprite is a grid of characters, every character a colour of the
// palette ('.' is transparent). No image files, nothing borrowed. Variants are palette swaps: the neighbour's
// agent is ours in red, a child is ours drawn smaller, the people of the company differ in hair and shirt.

app.define( 'Ui.Office.Sprites', [], () => class Sprites {

	static PALETTE = {
		k: '#23213a', // outline
		w: '#eef1f5', // light shell, paper
		g: '#9aa4b2', // grey
		G: '#6b7584', // dark grey
		c: '#62d6e8', // visor
		d: '#17617a', // visor eyes
		t: '#2fae92', // agent body
		T: '#1f7b68', // agent body shade
		y: '#f4c542', // brass, badge
		Y: '#fff1a8', // brass highlight
		s: '#f2c39b', // skin
		S: '#d49a74', // skin shade
		h: '#5b3a2a', // hair brown
		p: '#5b7fd6', // shirt
		P: '#3f5fb0', // shirt shade
		D: '#2d3350', // trousers
		b: '#2f4f9a', // guard uniform
		B: '#203872', // guard shade
		m: '#c9b9a6', // mortar
		R: '#b5523b', // brick
		r: '#8e3b2a', // brick shade
		O: '#a8703f', // wood
		o: '#c98f55', // wood light
		a: '#bfe6f3', // glass
		A: '#ffffff', // glass highlight
		n: '#e8c98a', // sand
		N: '#c9a35f', // sand shade
		e: '#e5484d', // red, label confidential
		f: '#f08c2e', // orange, label foreign
		v: '#3fbf6f', // green, label aggregate, check
		u: '#4c8df0', // blue, label own
		l: '#7fbf5a', // leaf
		L: '#4e8c3a', // leaf shade
		z: '#d7d2c8', // floor light
		Z: '#c8c2b6', // floor dark
		x: '#e9e4da', // wall
		X: '#d3ccbf', // wall shade
	};

	// Palette swaps for variants of one drawing.
	static SWAPS = {
		neighbour: { t: '#d9534f', T: '#9e3431', c: '#f6b26b', d: '#8a4a12' },
		blond: { h: '#e2b85c' },
		red: { h: '#b4472e', p: '#c2577a', P: '#93405c' },
		dark: { h: '#2a1d16', p: '#3d9c8c', P: '#2c7569' },
		grey: { h: '#9a9a9a', p: '#8a6bc2', P: '#664f94' },
	};

	static AGENT = [
		'................',
		'.....kkkkkk.....',
		'....kwwwwwwk....',
		'...kwwwwwwwwk...',
		'...kwkkkkkkwk...',
		'...kwkcccckwk...',
		'...kwkdccdkwk...',
		'...kwkkkkkkwk...',
		'...kgwwwwwwgk...',
		'....kggggggk....',
		'.....kTTTTk.....',
		'...kkttttttkk...',
		'..kgkttyyttkgk..',
		'..kgkTTTTTTkgk..',
		'....kTTkkTTk....',
		'....kkk..kkk....',
	];

	static AGENT_STEP = [
		'................',
		'.....kkkkkk.....',
		'....kwwwwwwk....',
		'...kwwwwwwwwk...',
		'...kwkkkkkkwk...',
		'...kwkcccckwk...',
		'...kwkdccdkwk...',
		'...kwkkkkkkwk...',
		'...kgwwwwwwgk...',
		'....kggggggk....',
		'.....kTTTTk.....',
		'...kkttttttkk...',
		'..kgkttyyttkgk..',
		'..kgkTTTTTTkgk..',
		'...kTTk..kTTk...',
		'...kkk....kkk...',
	];

	static PERSON = [
		'................',
		'.....kkkkkk.....',
		'....khhhhhhk....',
		'...khhhhhhhhk...',
		'...khsssssshk...',
		'...kssksskssk...',
		'...kssssssssk...',
		'...ksssSSsssk...',
		'....kSSSSSSk....',
		'.....kssssk.....',
		'...kkppppppkk...',
		'..kskppwwppksk..',
		'..kskppppppksk..',
		'..kskPPPPPPksk..',
		'....kDDkkDDk....',
		'....kkk..kkk....',
	];

	static GUARD = [
		'................',
		'.....kkkkkk.....',
		'....kbbbbbbk....',
		'...kbbbyybbbk...',
		'..kkkkkkkkkkkk..',
		'...kssksskssk...',
		'...kssssssssk...',
		'...ksskkkkssk...',
		'....kSSSSSSk....',
		'.....kssssk.....',
		'...kkbbbbbbkk...',
		'..kbkbbyybbkbk..',
		'..kskbbbbbbksk..',
		'..kskBBBBBBksk..',
		'....kDDkkDDk....',
		'....kkk..kkk....',
	];

	static INBOX = [
		'................',
		'................',
		'.....kkkkkkk....',
		'.....kwwwwwk....',
		'...kkkkkkkkwk...',
		'...kwwwwwwkwk...',
		'...kwkwwkwkk....',
		'..kkkkkkkkkkkk..',
		'..kOOOOOOOOOOk..',
		'..kOooooooooOk..',
		'..kOOOOOOOOOOk..',
		'..kkkkkkkkkkkk..',
		'...kk......kk...',
		'...kk......kk...',
		'................',
		'................',
	];

	static VAULT = [
		'................',
		'..kkkkkkkkkkkk..',
		'..kGGGGGGGGGGk..',
		'..kGkkkkkkkkGk..',
		'..kGkggggggkGk..',
		'..kGkgkkkkgkGk..',
		'..kGkgkyykgkyk..',
		'..kGkgkyykgkyk..',
		'..kGkgkkkkgkGk..',
		'..kGkggggggkGk..',
		'..kGkkkkkkkkGk..',
		'..kGGGGGGGGGGk..',
		'..kkkkkkkkkkkk..',
		'...kk......kk...',
		'................',
		'................',
	];

	static SANDBOX = [
		'................',
		'..kkkkkkkkkkkk..',
		'..kaAaaaaaaaak..',
		'..kaaAaaaaaaak..',
		'..kaaaaaaaaaak..',
		'..kaaaakkaaaak..',
		'..kaaakggkaaak..',
		'..kaaaakkaaaak..',
		'..kaannnnnnaak..',
		'..knnnnNnnnnnk..',
		'..knNnnnnnNnnk..',
		'..kkkkkkkkkkkk..',
		'..kGGGGGGGGGGk..',
		'..kkkkkkkkkkkk..',
		'...kk......kk...',
		'................',
	];

	static WALL = [
		'mmmmmmmmmmmmmmmm',
		'RRRRRRRmRRRRRRRm',
		'RRRRRRRmRRRRRRRm',
		'rrrrrrrmrrrrrrrm',
		'mmmmmmmmmmmmmmmm',
		'RRRmRRRRRRRmRRRR',
		'RRRmRRRRRRRmRRRR',
		'rrrmrrrrrrrmrrrr',
		'mmmmmmmmmmmmmmmm',
		'RRRRRRRmRRRRRRRm',
		'RRRRRRRmRRRRRRRm',
		'rrrrrrrmrrrrrrrm',
		'mmmmmmmmmmmmmmmm',
		'RRRmRRRRRRRmRRRR',
		'RRRmRRRRRRRmRRRR',
		'rrrmrrrrrrrmrrrr',
	];

	static DOOR = [
		'..kkkkkkkkkkkk..',
		'..kOOOOOOOOOOk..',
		'..kOkkkkkkkkOk..',
		'..kOkaaaaaakOk..',
		'..kOkaAaaaakOk..',
		'..kOkaaaaaakOk..',
		'..kOkkkkkkkkOk..',
		'..kOooooooooOk..',
		'..kOooooooooOk..',
		'..kOooooooyyOk..',
		'..kOooooooyyOk..',
		'..kOooooooooOk..',
		'..kOooooooooOk..',
		'..kOooooooooOk..',
		'..kOOOOOOOOOOk..',
		'..kkkkkkkkkkkk..',
	];

	static DESK = [
		'................................',
		'................................',
		'................................',
		'..........kkkkkkkkkkkk..........',
		'..........kGGGGGGGGGGk..........',
		'..........kGccccccccGk..........',
		'..........kGccccccccGk..........',
		'..........kGccccccccGk..........',
		'..........kGGGGGGGGGGk..........',
		'..............kGGk..............',
		'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
		'kooooooooooooooooooooooooooooook',
		'kOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOk',
		'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
		'.kOk........................kOk.',
		'.kOk........................kOk.',
	];

	static PLANT = [
		'................',
		'.......ll.......',
		'....l.lLll.l....',
		'...lLllLlllLl...',
		'....llLllLLl....',
		'...lLllLllLll...',
		'....llLlLllL....',
		'.....LllLll.....',
		'......LLL.......',
		'.....kkkkkk.....',
		'....kOooooOk....',
		'....kOooooOk....',
		'.....kOooOk.....',
		'.....kOOOOk.....',
		'......kkkk......',
		'................',
	];

	static FLOOR = [
		'zzzzzzzzzzzzzzzZ',
		'zzzzzzzzzzzzzzzZ',
		'zzzzzzzzzzzzzzzZ',
		'ZZZZZZZZZZZZZZZZ',
		'zzzzzzzZzzzzzzzz',
		'zzzzzzzZzzzzzzzz',
		'zzzzzzzZzzzzzzzz',
		'ZZZZZZZZZZZZZZZZ',
		'zzzzzzzzzzzzzzzZ',
		'zzzzzzzzzzzzzzzZ',
		'zzzzzzzzzzzzzzzZ',
		'ZZZZZZZZZZZZZZZZ',
		'zzzzzzzZzzzzzzzz',
		'zzzzzzzZzzzzzzzz',
		'zzzzzzzZzzzzzzzz',
		'ZZZZZZZZZZZZZZZZ',
	];

	static BACKWALL = [
		'xxxxxxxxxxxxxxxx',
		'xxxxxxxxxxxxxxxx',
		'xxxxxxxxxxxxxxxx',
		'xxxxxxxxxxxxxxxx',
		'xxxxxxxxxxxxxxxx',
		'xxxxxxxxxxxxxxxx',
		'xxxxxxxxxxxxxxxx',
		'xxxxxxxxxxxxxxxx',
		'xxxxxxxxxxxxxxxx',
		'xxxxxxxxxxxxxxxx',
		'XXXXXXXXXXXXXXXX',
		'XXXXXXXXXXXXXXXX',
		'OOOOOOOOOOOOOOOO',
		'oooooooooooooooo',
		'OOOOOOOOOOOOOOOO',
		'kkkkkkkkkkkkkkkk',
	];

	static LETTER = [
		'kkkkkkkk',
		'kwkwwkwk',
		'kwwkkwwk',
		'kwwwwwwk',
		'kwwwwwwk',
		'kkkkkkkk',
	];

	static LETTER_KEY = [
		'kkkkkkkk...',
		'kwkwwkwk...',
		'kwwkkwwkkk.',
		'kwwwwwwkyyk',
		'kwwwwwwkkk.',
		'kkkkkkkk...',
	];

	static REPORT = [
		'kkkkkk..',
		'kwwwwkk.',
		'kwkkwwwk',
		'kwwwwwwk',
		'kwkkkkwk',
		'kwwwwwwk',
		'kwkkkkwk',
		'kkkkkkkk',
	];

	static COIN = [
		'..kkkk..',
		'.kyYyyk.',
		'kyYyyyyk',
		'kyyyyyyk',
		'kyyyyyyk',
		'kyyyyyyk',
		'.kyyyyk.',
		'..kkkk..',
	];

	static STAMP = [
		'.......v',
		'......vv',
		'v....vv.',
		'vv..vv..',
		'.vvvv...',
		'..vv....',
	];

	static CROSS = [
		'ee....ee',
		'eee..eee',
		'.eeeeee.',
		'..eeee..',
		'.eeeeee.',
		'eee..eee',
		'ee....ee',
	];

	static LABEL = [
		'kkkkk',
		'k###k',
		'k###k',
		'k###k',
		'kkkkk',
	];

	static LABELS = { confidential: '#e5484d', foreign: '#f08c2e', aggregate: '#3fbf6f', own: '#4c8df0' };

	// A stable key for the image cache.
	static key( grid ) {
		if ( !Sprites._keys ) { Sprites._keys = new Map(); }
		if ( !Sprites._keys.has( grid ) ) { Sprites._keys.set( grid, Sprites._keys.size ); }
		return Sprites._keys.get( grid );
	}

} );
