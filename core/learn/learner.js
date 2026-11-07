// Step 6 of the loop (4.1): learning is code with a proposal of the model. Code builds each lesson from the journal;
// the model may propose what it reads into an attempt, in the same fixed schema: which hypothesis of the attempt's
// wall held (a code of the diagnosis, 5.6). It sees only codes and ids, never text from the world. Every proposal
// passes G4: what fits the schema is written with the lesson; what does not is refused, and a person sees it as a
// suggestion (7.2: refused, or a proposal in a ticket). A proposal can never change a rule, a gate or a goal.

app.define( 'Core.Learn.Learner', [], () => class Learner {

	constructor( { provider = null } = {} ) {
		this.provider = provider;
	}

	// lessons: the code's lessons of one node. → [ { attempt, proposal } ] as the model gave them, or [].
	async propose( node, lessons, diagnosis ) {
		if ( !this.provider || !lessons.length ) { return []; }
		const _attempts = lessons.map( lesson => ( {
			attempt: lesson.attempt, strategy: lesson.strategy, result: lesson.result, cause: lesson.cause,
			contribution: lesson.contribution,
			hypotheses: ( diagnosis.of( lesson.cause ) || [] ).map( item => item.hypothesis ),
		} ) );
		const _answer = await this.provider.complete( {
			role: 'learner',
			instructions: 'Read how the attempts of this goal went. For an attempt that hit a wall, you may say which of its hypotheses held. '
				+ 'Each proposal is { "attempt": its number, "hypothesis": one of its hypotheses }. Propose nothing when unsure.',
			input: { goal: node.contract.spec.kind || 'goal', attempts: _attempts },
			// open: a proposal with keys the schema does not have still reaches G4, which refuses it and shows it to a person
			// as a suggestion (7.2); the provider must not drop it unseen.
			contract: { fields: { proposals: { type: 'records', fields: { attempt: 'a number', hypothesis: 'a code' }, open: true } } },
			node: node.id,
		} ).catch( () => ( { proposals: [] } ) );
		// G4: the step contract asks for the attempt's number. Only an integer is one; true, [1], "1", " 1 ", "0x1" or "1e0"
		// name no attempt (NaN matches none), so a malformed proposal is refused instead of reaching a real lesson.
		const _list = Array.isArray( _answer?.proposals ) ? _answer.proposals : [];
		return _list.map( proposal => ( { attempt: Number.isSafeInteger( proposal?.attempt ) ? proposal.attempt : NaN, proposal } ) );
	}

} );
