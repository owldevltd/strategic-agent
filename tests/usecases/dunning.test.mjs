// Case 11 of tests/usecases/CASES.md: a weekly dunning run, through the real loop and the real gate, with the stub model
// and a scripted person. The mission and this test were written by an agent that knew nothing of the engine but the
// README and docs/missions.md, as a company's developer would. The person approves every action unread and answers
// every ticket with its recommendation: whatever the AR team lead's rules need must hold without the person checking.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AGENCY_MISSIONS = 'missions,tests/usecases';
const { office, Mission, app } = await import( '../office.mjs' );
const [ Db, EventLog ] = await app.use( [ 'Lib.Db', 'Lib.EventLog' ] );

const wait = ms => new Promise( resolve => setTimeout( resolve, ms ) );
// A deadline that does not keep the test process alive once the run is over.
const within = ( promise, ms, fallback = null ) => Promise.race( [ promise, new Promise( ( resolve ) => {
	setTimeout( () => resolve( fallback ), ms ).unref();
} ) ] );
const until = async ( check, ms = 30000 ) => {
	for ( const end = Date.now() + ms; Date.now() < end; await wait( 20 ) ) {
		const _value = check();
		if ( _value ) { return _value; }
	}
	return null;
};
const sent = ( o, action ) => o.gateDb.all( 'SELECT * FROM outbox WHERE action = :action ORDER BY time', { action } )
	.map( row => ( { target: row.target, address: row.address, ...JSON.parse( row.params ) } ) );
const deliveries = ( o, action ) => o.gateDb.all( 'SELECT * FROM deliveries WHERE action = :action', { action } )
	.map( row => ( { ...row, params: JSON.parse( row.params ), reasons: row.reasons && JSON.parse( row.reasons ) } ) );
const approvalOf = ( o, delivery ) => o.gateDb.get( 'SELECT * FROM approvals WHERE delivery = :delivery', { delivery } );
const cases = o => [ ...o.runner.nodes.values() ].filter( node => node.contract.spec?.kind === 'request' );

// The week as the data says it (what a careful clerk finds by hand in the ERP export and the bank statement).
const REMINDED = { 'AR-2026-0391': 'C102', 'AR-2026-0402': 'C103', 'AR-2026-0405': 'C104', 'AR-2026-0409': 'C105', 'AR-2026-0411': 'C107', 'AR-2026-0426': 'C108' };
const PAID = [ 'AR-2026-0388', 'AR-2026-0414' ];
const NOT_DUE = [ 'AR-2026-0417', 'AR-2026-0420', 'AR-2026-0423', 'AR-2026-0430' ];
const ON_FILE = {
	C101: 'ap@brightline-logistics.example', C102: 'rechnungen@kessler-mb.example', C103: 'accounts@nordlicht-foods.example',
	C104: 'payables@vantage-retail.example', C105: 'billing@okafor-design.example', C106: 'finance@meridian-health.example',
	C107: 'invoice@halvorsen-marine.example', C108: 'compta@petit-fils.example',
};
const THREAT = /legal|lawyer|court|fee|interest|collection|agency|enforce|penalt|final notice|last warning|!/i;

// The replies, as they come in, and what the run did not do by itself.
async function replies( o, _tickets ) {
	// The replies, as they come in: four customers answer, two (Nordlicht, Petit & Fils) do not.
	const _done = await until( () => cases( o ).length >= 4 && cases( o ).every( node => node.state === 'closed' ) && sent( o, 'reply' ).length >= 4, 60000 );
	assert.ok( _done, `cases: ${cases( o ).map( node => `${node.contract.goal} ${node.state} ${node.result?.status}` ).join( '; ' )}` );
	for ( const node of cases( o ) ) { assert.equal( node.result?.status, 'fulfilled', `${node.contract.goal}: ${JSON.stringify( node.result )}` ); }
	const _replies = Object.fromEntries( sent( o, 'reply' ).map( item => [ item.target, item ] ) );
	assert.deepEqual( Object.keys( _replies ).sort(), [ 'C102', 'C104', 'C105', 'C107' ] );
	for ( const item of Object.values( _replies ) ) {
		assert.equal( item.address, ON_FILE[ item.target ], 'every answer goes to the contact on file' );
		assert.doesNotMatch( item.body, THREAT );
	}
	// "We paid last Friday", and the payment is there (booked after the run's bank export): found, thanked, paid.
	assert.match( _replies.C104.body, /found your payment for invoice AR-2026-0405, booked on 6 November 2026/ );
	const _claim = cases( o ).find( node => node.contract.spec.scope?.from === 'C104' );
	assert.ok( _claim.facts.some( fact => fact.kind === 'item_resolved' && fact.data.outcome === 'paid' && fact.evidenceClass === 'observation' ) );
	// "We paid last Friday", and it is not there: a polite answer that asks for the remittance advice.
	assert.match( _replies.C107.body, /remittance advice/ );
	assert.doesNotMatch( _replies.C107.body, /settled/ );
	// A dispute goes to a colleague with the customer's reason; the customer hears it is being looked at.
	const _dispute = _tickets.find( ticket => /disputes invoice AR-2026-0391/.test( ticket.question ) );
	assert.ok( _dispute, `tickets: ${_tickets.map( ticket => ticket.question ).join( ' | ' )}` );
	assert.match( JSON.stringify( _dispute.excerpt ), /spindle unit/ );
	assert.match( _replies.C102.body, /colleague, who is looking into it/ );
	// "Send it to my private address": no; the customer hears we keep the billing address on file. Nothing went there.
	assert.match( _replies.C105.body, /only to the billing address we have on file/ );
	const _all = o.gateDb.all( 'SELECT target, address, params FROM outbox' );
	assert.ok( _all.every( row => !/freemail/.test( `${row.target} ${row.address} ${row.params}` ) ), 'nothing to the private address' );
	// No reply, nothing more this week: one reminder each, no second message.
	assert.equal( o.gateDb.all( 'SELECT * FROM outbox WHERE target IN ( \'C103\', \'C108\' )' ).length, 2 );

	// Rule 4: nothing beyond a friendly reminder happened by itself: only reminders, replies and the one report left.
	assert.deepEqual( [ ...new Set( o.gateDb.all( 'SELECT action FROM outbox' ).map( row => row.action ) ) ].sort(), [ 'reminder', 'reply', 'report' ] );
	// No invoice was handed over or escalated by the system; the only tickets were the dispute (and calibration samples).
	assert.ok( !_tickets.some( ticket => /could not be settled|could not be given/.test( ticket.question ) ),
		_tickets.map( ticket => ticket.question ).join( ' | ' ) );
}

test( 'week 45: six friendly reminders, two found paid, four not yet due; the lead gets counts; every reply handled', async () => {
	const _seen = [];
	const _tickets = [];
	const o = await office( {
		mission: Mission.load( 'dunning' ),
		// The person approves everything unread; the rules must hold without them.
		approve: ( approval ) => {
			_seen.push( approval );
			return true;
		},
		person: ( ticket ) => {
			if ( !_tickets.some( item => item.id === ticket.id ) ) { _tickets.push( ticket ); }
			return ticket.recommendation ?? ticket.options[ 0 ];
		},
	} );
	try {
		const _root = await within( o.run(), 90000 );
		assert.ok( _root, 'the weekly run ended in time' );
		assert.equal( _root.result?.status, 'fulfilled', JSON.stringify( _root.result ) );

		// Every overdue invoice has an outcome for this week, on evidence: the gate's receipt or the trusted tool's finding.
		const _outcomes = Object.fromEntries( _root.facts.filter( fact => fact.kind === 'item_resolved' )
			.map( fact => [ String( fact.data.item ).split( ':' )[ 0 ], [ fact.data.outcome, fact.evidenceClass ] ] ) );
		const _child = id => _root.children.find( node => node.contract.id.includes( id ) );
		const _why = id => JSON.stringify( _child( id )?.walls?.map( wall => [ wall.cause, wall.reason ] ) );
		for ( const id of Object.keys( REMINDED ) ) { assert.deepEqual( _outcomes[ id ], [ 'reminded', 'observation' ], `${id} ${_why( id )}` ); }
		for ( const id of PAID ) { assert.deepEqual( _outcomes[ id ], [ 'paid', 'observation' ], `${id} ${_why( id )}` ); }
		for ( const id of NOT_DUE ) { assert.deepEqual( _outcomes[ id ], [ 'not_due', 'observation' ], `${id} ${_why( id )}` ); }

		// Rules 1 and 2: one reminder for each overdue unpaid invoice, none for a paid one (also the sloppy reference
		// "re 2026/388"), none for one only 14 days past due; the same amount from Meridian does not pay Nordlicht's.
		const _reminders = sent( o, 'reminder' );
		assert.deepEqual( _reminders.map( item => item.invoiceId ).sort(), Object.keys( REMINDED ).sort() );
		// Rule 3: each to that invoice's customer, at the billing address on file, resolved by the gate.
		for ( const item of _reminders ) {
			assert.equal( item.target, REMINDED[ item.invoiceId ], item.invoiceId );
			assert.equal( item.address, ON_FILE[ item.target ], item.invoiceId );
		}
		// The reminder names the invoice, the amount and the due date; rule 4: friendly, nothing about legal steps or fees.
		const _big = _reminders.find( item => item.invoiceId === 'AR-2026-0391' );
		assert.match( _big.body, /AR-2026-0391/ );
		assert.match( _big.body, /14,800\.00 EUR/ );
		assert.match( _big.body, /9 October 2026/ );
		for ( const item of _reminders ) { assert.doesNotMatch( item.body, THREAT, item.invoiceId ); }

		// Rule 5: every reminder, the one above 10,000 EUR among them, went out only after a person approved exactly it;
		// the person saw the amount and the resolved address.
		for ( const row of deliveries( o, 'reminder' ).filter( item => item.status === 'executed' ) ) {
			const _approval = approvalOf( o, row.id );
			assert.ok( _approval && _approval.decidedBy === 'test-person' && [ 'approved', 'consumed' ].includes( _approval.status ), row.params.invoiceId );
		}
		const _shown = _seen.find( item => item.summary?.action === 'reminder' && item.summary?.params?.invoiceId === 'AR-2026-0391' );
		assert.equal( _shown?.summary?.params?.amount, 14800 );
		assert.equal( _shown?.summary?.address, ON_FILE.C102 );

		// The lead's summary, with counts.
		const _reports = sent( o, 'report' );
		assert.equal( _reports.length, 1 );
		assert.equal( _reports[ 0 ].target, 'ar-lead' );
		assert.match( _reports[ 0 ].body, /6 reminded, 2 found paid/ );
		assert.match( _reports[ 0 ].body, /4 not more than 14 days past due/ );

		await replies( o, _tickets );
	} finally {
		o.stop();
	}
} );

test( 'a crash while a reminder waits for approval: after the restart every invoice still has exactly one reminder', async () => {
	// The person holds back the approval of AR-2026-0426's reminder; by then five reminders have gone out.
	const _held = approval => approval.summary?.action === 'reminder' && approval.summary?.params?.invoiceId === 'AR-2026-0426';
	const quiet = ( mission ) => { mission.world = null; };
	const _first = await office( { mission: Mission.load( 'dunning' ), edit: quiet, approve: approval => ( _held( approval ) ? null : true ) } );
	_first.run().catch( () => {} );
	const _pending = await until( () => _first.egress.pendingApprovals().find( _held ), 60000 );
	assert.ok( _pending, 'the reminder of AR-2026-0426 waits for its approval' );
	assert.equal( sent( _first, 'reminder' ).length, 5 );
	_first.crash();

	const _second = await office( { mission: Mission.load( 'dunning' ), edit: quiet, share: _first, resume: true } );
	try {
		const [ _root ] = await within( _second.resumed, 90000, [ null ] );
		assert.equal( _root?.result?.status, 'fulfilled', JSON.stringify( _root?.result ) );
		const _reminders = sent( _second, 'reminder' );
		assert.deepEqual( _reminders.map( item => item.invoiceId ).sort(), Object.keys( REMINDED ).sort(), 'exactly one reminder per overdue unpaid invoice' );
		const _executed = deliveries( _second, 'reminder' ).filter( item => item.status === 'executed' );
		assert.equal( _executed.length, 6 );
		assert.equal( _first.egress.store.delivery( _pending.delivery ).status, 'not_sent', 'the dead core\'s pending reminder was withdrawn' );
		assert.equal( sent( _second, 'report' ).length, 1 );
	} finally {
		_second.stop();
	}
} );

// The rules must hold when the mission's own plan is wrong, not only on the happy path. Each run below breaks one part
// of the mission (as a careless edit would) and checks what the gate or the trusted tool still stops.
const quietly = edit => ( mission ) => {
	mission.world = null;
	edit( mission );
};
const strategy = ( mission, id ) => mission.strategies.find( item => item.id === id );
async function week( edit, { share = null } = {} ) {
	const _tickets = [];
	const o = await office( {
		mission: Mission.load( 'dunning' ), edit: quietly( edit ), share,
		person: ( ticket ) => {
			if ( !_tickets.some( item => item.id === ticket.id ) ) { _tickets.push( ticket ); }
			return ticket.recommendation ?? ticket.options[ 0 ];
		},
	} );
	const _root = await within( o.run(), 90000 );
	o.stop();
	return { o, root: _root, tickets: _tickets };
}
const refusals = ( o, action ) => deliveries( o, action ).filter( item => item.status === 'refused' );

test( 'rule 3 at the gate: a plan that names the wrong customer reaches no one but that customer\'s own invoice', async () => {
	// A careless edit sends every reminder to C105 (Okafor). The cohort from the trusted ERP read names the invoice's
	// customer, and the gate sends data about C102 only to the contact on file for C102.
	const { o } = await week( ( mission ) => { strategy( mission, 'friendly-reminder' ).steps[ 1 ].target = 'C105'; } );
	const _reminders = sent( o, 'reminder' );
	assert.deepEqual( _reminders.map( item => [ item.invoiceId, item.address ] ), [ [ 'AR-2026-0409', ON_FILE.C105 ] ] );
	const _refused = refusals( o, 'reminder' );
	assert.equal( _refused.length, 5 );
	assert.ok( _refused.every( item => item.reasons.some( reason => /not the address on file for C10[2-8]/.test( reason.reason ) ) ),
		JSON.stringify( _refused.map( item => item.reasons ) ) );
} );

test( 'rule 3 at the gate: a plan that names the private address from a customer\'s mail sends nothing there', async () => {
	const { o } = await week( ( mission ) => { strategy( mission, 'friendly-reminder' ).steps[ 1 ].target = 'tunde.okafor@freemail.example'; } );
	assert.deepEqual( sent( o, 'reminder' ), [] );
	const _refused = refusals( o, 'reminder' );
	assert.equal( _refused.length, 6 );
	// The reminder's recipient type is contact (6.2): a plain address is no reference on file.
	assert.ok( _refused.every( item => item.reasons.some( reason => /reminder goes only to a contact on file/.test( reason.reason ) ) ),
		JSON.stringify( _refused.map( item => item.reasons ) ) );
} );

test( 'rule 1 in the trusted tool: with the reminder as the first way, no paid or not yet due invoice is reminded', async () => {
	// A careless edit drops the bank check and makes the reminder the direct way. The reminder's own trusted step
	// checks the bank export again and refuses; those invoices go to a person, never to the customer.
	const { o, root, tickets } = await week( ( mission ) => {
		mission.strategies = mission.strategies.filter( item => item.id !== 'check-bank-first' );
		strategy( mission, 'friendly-reminder' ).class = 'direct';
	} );
	assert.deepEqual( sent( o, 'reminder' ).map( item => item.invoiceId ).sort(), Object.keys( REMINDED ).sort() );
	const _handed = tickets.filter( ticket => /could not be settled by a friendly reminder/.test( ticket.question ) ).map( ticket => ticket.question.match( /AR-\d{4}-\d{4}/ )[ 0 ] );
	assert.deepEqual( _handed.sort(), [ ...PAID, ...NOT_DUE ].sort() );
	assert.equal( root?.result?.status, 'fulfilled', JSON.stringify( root?.result ) );
} );

test( 'rule 2 at the gate: a full re-run of the week by a core that lost everything sends no second reminder', async () => {
	const { o: _first } = await week( () => {} );
	assert.equal( sent( _first, 'reminder' ).length, 6 );
	// A new core with an empty database and log; only the gate (its ledger and outbox) is the same.
	const _db = new Db( ':memory:' );
	const _share = { gateDb: _first.gateDb, outbox: _first.outbox, egress: _first.egress, db: _db, log: new EventLog( _db, 'core' ) };
	const { o: _second, tickets } = await week( () => {}, { share: _share } );
	assert.equal( sent( _second, 'reminder' ).length, 6, 'still one reminder per invoice' );
	const _refused = refusals( _second, 'reminder' );
	assert.equal( _refused.length, 6 );
	assert.ok( _refused.every( item => item.reasons.some( reason => /already has a reminder/.test( reason.reason ) ) ), JSON.stringify( _refused.map( item => item.reasons ) ) );
	// The gate's refusal is no outcome by itself: each such invoice goes to a person (anything beyond one reminder is theirs).
	assert.equal( tickets.filter( ticket => /could not be settled by a friendly reminder/.test( ticket.question ) ).length, 6 );
} );
