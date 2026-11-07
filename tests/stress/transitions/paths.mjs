// Paths through the state machine that the transition tests reuse: each is the rig options of a goal that walks a
// known route of table 16.1. A test names the path, which occurrence of its transition it hooks (nth) and on which
// node (root or child), and what the goal must end with.
import { out, strategy, REPORT, measured, QUANTITY } from './rig.mjs';

export const ALPHA = strategy( 'alpha', [ 'stress.measure' ] );
export const BETA = strategy( 'beta', [ 'stress.measure' ], { class: 'widen', price: 2 } );
// The precondition a wall names; a child goal measures it.
export const P1 = { id: 'p1', type: 'number_in_range', values: { quantity: 'stress:p', min: 1 } };
export const retry = ticket => ( ticket.options.includes( 'try once more' ) ? 'try once more' : ticket.recommendation );
export const silent = () => null;
const ASK = strategy( 'alpha', [ 'stress.ask', 'stress.measure' ] );

export const PATHS = {
	// planning → executing → judging (U1) → closing → closed
	direct: { script: { 'stress.measure': [ out.fact() ] } },
	// a wall of the strategy, another strategy (U3)
	other: { script: { 'stress.measure': [ out.wall( 'not_reached' ), out.fact() ] } },
	// a move that fails is a wall like any other
	broken: { script: { 'stress.measure': [ out.fail( 'the tool broke' ), out.fact() ] } },
	// a person is asked: executing → waiting → judging → planning (the open attempt goes on) → executing
	ask: { strategies: [ ASK ], script: { 'stress.ask': [ out.after( 5, out.none() ) ], 'stress.measure': [ out.fact() ] } },
	// two people in a row
	askTwice: {
		strategies: [ strategy( 'alpha', [ 'stress.ask', 'stress.ask', 'stress.measure' ] ) ],
		script: { 'stress.ask': [ out.after( 5, out.none() ) ], 'stress.measure': [ out.fact() ] },
	},
	// a wait for an answer from outside
	wait: {
		strategies: [ strategy( 'alpha', [ 'stress.wait', 'stress.measure' ] ) ],
		script: { 'stress.wait': [ out.after( 5, out.none() ) ], 'stress.measure': [ out.fact() ] },
	},
	// a report through the gate with a person's approval (the token)
	report: { strategies: [ REPORT ] },
	// U2: a missing precondition becomes a child; once it is met the strategy runs again
	deeper: { strategies: [ ALPHA ], script: { 'stress.measure@0': [ out.wall( 'precondition_missing', P1 ), out.fact() ], 'stress.measure@1': [ out.fact() ] } },
	// U4: the only strategy hits a wall, a person closes the goal
	escalate: { strategies: [ ALPHA ], script: { 'stress.measure': [ out.wall( 'not_reached' ) ] } },
	// U4: the person says "try once more"
	retry: { strategies: [ ALPHA ], person: retry, script: { 'stress.measure': [ out.wall( 'not_reached' ), out.fact() ] } },
	// 19: the review of an attempt that waits for a signal; without one another strategy is chosen
	review: {
		strategies: [ strategy( 'alpha', [ 'stress.ask', 'stress.measure' ], { tSignalH: 0.00002 } ), strategy( 'beta', [ 'stress.measure' ], { class: 'remind' } ) ],
		script: { 'stress.ask': [ out.gated( 'never', out.none() ) ], 'stress.measure': [ out.fact() ] },
	},
	// A3: a move runs past its lease; another strategy follows
	lease: {
		strategies: [ strategy( 'alpha', [ 'stress.slow' ] ), BETA ],
		script: { 'stress.slow': [ out.hang() ], 'stress.measure': [ out.fact() ] },
	},
	// a person who never answers a question the attempt waits for; the review ends it (19)
	unanswered: {
		strategies: [ strategy( 'alpha', [ 'stress.ask', 'stress.measure' ], { tSignalH: 0.00002 } ), strategy( 'beta', [ 'stress.measure' ], { class: 'remind' } ) ],
		script: { 'stress.ask': [ out.gated( 'never', out.none() ) ], 'stress.measure': [ out.fact() ] },
	},
};

// A path with more options.
export const path = ( name, more = {} ) => ( { ...PATHS[ name ], ...more } );

// A fact about the root's quantity from another origin with another value: E5 makes a conflict.
export const conflicting = ( value = 0 ) => measured( value, { source: 'mail other', origin: 'other', data: { quantity: QUANTITY, value, about: QUANTITY } } );
