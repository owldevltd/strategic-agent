// The gate in the same process, behind exactly the interface the core uses over HTTP (Core.Outbound.GateClient).
// For tests and single-process runs only. The Egress is held in a private field: the core holding a Local has no
// way to confirm a goal, approve an action or add master data, not even one property away.

app.define( 'Gate.Local', [], () => class Local {

	#egress;

	constructor( egress ) {
		this.#egress = egress;
	}

	async propose( contract ) {
		return this.#egress.propose( contract.canonical(), contract.rules(), contract.hash );
	}

	async contract( hash ) {
		return this.#egress.store.contract( hash );
	}

	async withdrawContract( hash ) {
		return this.#egress.withdrawContract( hash );
	}

	async submit( request ) {
		return this.#egress.submit( request );
	}

	async delivery( id ) {
		return this.#egress.store.delivery( id );
	}

	async withdraw( id ) {
		return this.#egress.withdraw( id );
	}

	// O9 at a restart: every delivery of one contract, also one whose record the dying core lost.
	async deliveries( contract ) {
		return typeof contract === 'string' ? this.#egress.store.deliveries( contract ) : [];
	}

	async redeem( request ) {
		return this.#egress.redeem( request );
	}

	async unclear() {
		return this.#egress.unclear();
	}

	// What the agent proposes for the operator to decide (Gate.Proposals); deciding is not the core's.
	async proposeAt( request ) {
		return this.#egress.proposals.submit( request );
	}

	async gateProposal( id ) {
		return this.#egress.proposals.get( id );
	}

	async gateProposals( { status = 'proposed', scope = null } = {} ) {
		return this.#egress.proposals.list( status, scope );
	}

	async learnedActions() {
		return this.#egress.proposals.learned();
	}

	async lease( request ) {
		return this.#egress.lease( request );
	}

	async beat( id, fence ) {
		return this.#egress.leases.beat( id, fence );
	}

	// Answers like the HTTP gate: { ok } (A4: only with the lease's fencing token).
	async release( id, fence ) {
		return this.#egress.leases.release( id, fence );
	}

	async outbox( target ) {
		return this.#egress.channels.default.messages( target );
	}

} );
