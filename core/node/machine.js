// Chapter 16: the states of a node and the only allowed transitions (table 16.1). Every transition is an event.
//   draft      the goal is drafted and checked (G1) and waits for the person's confirmation
//   confirmed  frozen; the loop starts
//   planning   a strategy is chosen and its plan checked (G2), or an open attempt is taken up again
//   executing  the plan runs move by move
//   waiting    the plan left something open: an expectation, a ticket, an approval, a child
//   judging    the judgment (16.4): done, another way, deeper, or escalate
//   closing    G6, the lesson, the books; bounded by the buffer
//   closed     final (Z5)
// Every state except the final ones may go to closing: root deadline, budget or an abort start the cascade (16.5).

app.define( 'Core.Node.Machine', [], () => class Machine {

	// Frozen: the table is the law of every node (Z3); nothing at run time may add a way out of closed.
	static TRANSITIONS = Object.freeze( {
		draft: Object.freeze( [ 'confirmed', 'closing' ] ),
		confirmed: Object.freeze( [ 'planning', 'closing' ] ),
		planning: Object.freeze( [ 'executing', 'judging', 'closing' ] ),
		executing: Object.freeze( [ 'waiting', 'judging', 'closing' ] ),
		waiting: Object.freeze( [ 'judging', 'closing' ] ),
		judging: Object.freeze( [ 'planning', 'waiting', 'closing' ] ),
		closing: Object.freeze( [ 'closed', 'judging' ] ),
		closed: Object.freeze( [] ),
	} );

	// Only the table's own states count: a name like "constructor" or "__proto__" (say, read from a damaged log) is no
	// state, and the answer is "no", never an error.
	static allowed( from, to ) {
		return typeof from === 'string' && Object.hasOwn( Machine.TRANSITIONS, from ) && Machine.TRANSITIONS[ from ].includes( to );
	}

	static known( state ) {
		return typeof state === 'string' && Object.hasOwn( Machine.TRANSITIONS, state );
	}

} );
