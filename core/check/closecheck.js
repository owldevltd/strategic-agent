// G6: closing is "really done" in six dimensions (2.3): functional (every evidence predicate holds, no open conflict),
// formal (the frozen contract is the confirmed one, immutable criteria unchanged, G-10), commercial (every attempt
// ended and booked), organisational (no ticket, move or outside action of this node still open), knowledge (the
// lesson is written) and structure (every child closed). After an abort the predicates are not the question; the
// clean-up is (16.3). The agent's own claim never counts.

app.define( 'Core.Check.CloseCheck', [], () => class CloseCheck {

	static GATE = 'G6';

	// context: what only the runner knows: open attempts, open tickets, open outside actions, the confirmed contract.
	check( node, { aborted = false, lessons = false, context = {} } = {} ) {
		const _results = node.contract.check( node.valid ? node.valid() : node.facts );
		const _dimensions = {
			functional: aborted ? [] : [
				..._results.filter( item => !item.met ).map( item => `${item.id} (${item.type}) not met: ${item.reason}` ),
				// A fact without data (a delivery, a conflict) is read as what it says, never a crash of G6.
				...( node.conflicts?.() || [] ).map( fact => `open conflict about ${fact?.data?.about ?? 'something'} (E5)` ),
			],
			formal: [
				...( context.confirmed && context.confirmed !== node.contract.hash ? [ 'the contract is not the one the person confirmed' ] : [] ),
				...( node.immutables && JSON.stringify( node.immutables ) !== JSON.stringify( node.contract.immutables() )
					? [ 'an immutable criterion changed since the first confirmation (G-10)' ] : [] ),
			],
			commercial: context.attemptsOpen ? [ `${context.attemptsOpen} attempt(s) not ended and booked` ] : [],
			organisational: [
				...( context.ticketsOpen ? [ `${context.ticketsOpen} ticket(s) still open` ] : [] ),
				...( node.plan?.pending ? [ 'a move is still running' ] : [] ),
				...( context.deliveriesOpen || [] ).map( id => `outside action ${id} not in an end state` ),
			],
			knowledge: lessons && !node.lessonWritten ? [ 'no lesson written (G4)' ] : [],
			structure: ( node.children || [] ).filter( child => child.state !== 'closed' ).map( child => `child ${child.id} still ${child.state}` ),
		};
		const _problems = Object.values( _dimensions ).flat();
		return { gate: CloseCheck.GATE, ok: _problems.length === 0, results: _results, problems: _problems, dimensions: _dimensions };
	}

} );
