// Outcome: a message of the given action (a report, by default) has reached the recipient. Evidence is the gate's
// receipt for that delivery, an observation, not the agent's claim that it sent something. The topic is part of
// what the person confirms, but the predicate ignores it: receipts carry no free text, so no receipt can show what a
// message was about.

app.define( 'Core.Criteria.ReportDelivered', [ 'Core.Criteria.Criterion' ], Criterion => class ReportDelivered extends Criterion {

	static TYPE = 'report_delivered';
	static KIND = 'outcome';
	static DESCRIBE = 'a report (or another message) on the topic has reached the recipient';
	static PARAMS = {
		to: { type: 'string', describe: 'recipient, a team or a role, e.g. hr or the requester' },
		topic: { type: 'string', describe: 'what the report is about' },
		action: { type: 'string', values: '@actions', optional: true, describe: 'the kind of message, a report unless said otherwise' },
	};

	// The channel that delivers this evidence (K4): an outgoing action of this kind through the gate.
	static EVIDENCE = [ 'delivered' ];

	check( facts, now = Date.now() ) {
		const _actions = app.get( 'Lib.Actions' ).load();
		const _receipt = Criterion.deliveries( this.evidence( facts, now ), action => _actions.matches( this.values.action || 'report', action ) )
			.find( fact => fact.data.to === this.values.to );
		return { met: Boolean( _receipt ), evidence: _receipt ? [ _receipt.id ] : [], reason: _receipt ? '' : 'no confirmed delivery' };
	}

} );
