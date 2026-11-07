// Case 13 of tests/usecases/CASES.md: two new suppliers onboarded and paid (preconditions three levels deep), through
// the real loop and the real gate with the stub model and a scripted person. The mission and this test were written
// by an agent that knew nothing of the engine but the README and docs/missions.md, as a company's developer would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.AGENCY_MISSIONS = 'missions,tests/usecases';
const MISSIONS = import.meta.dirname;
const { office, Mission } = await import( '../office.mjs' );

const LT = 'LT-2026-0117:lindqvist-tools-ab';
const OK = 'OKM-25-0042:okoro-metals-ltd';
const MASTER = JSON.parse( fs.readFileSync( path.join( MISSIONS, 'onboarding/master.json' ), 'utf8' ) );
const REGISTERED = { 'lindqvist-tools-ab': 'SE4550000000058398257466', 'okoro-metals-ltd': 'GB29NWBK60161331926819' };
const LETTER_IBAN = 'GB60BARC20000055779911';
const CAP = 20000;

// The tree as the process says it must close: [depth, what the node is about, result, outcome of its own item].
const EXPECTED = [
	[ 0, 'root', 'fulfilled', null ],
	[ 1, LT, 'fulfilled', 'paid' ],
	[ 2, 'verify:lindqvist-tools-ab', 'fulfilled', null ],
	[ 3, 'tax:lindqvist-tools-ab', 'fulfilled', 'checked' ],
	[ 3, 'bank:lindqvist-tools-ab', 'fulfilled', 'checked' ],
	[ 1, OK, 'fulfilled', 'escalated' ],
	[ 2, 'verify:okoro-metals-ltd', 'failed', null ],
	[ 3, 'tax:okoro-metals-ltd', 'fulfilled', 'checked' ],
	[ 3, 'bank:okoro-metals-ltd', 'failed', null ],
];

const wait = ms => new Promise( resolve => setTimeout( resolve, ms ) );
const within = ( promise, ms, fallback = null ) => Promise.race( [ promise, new Promise( ( resolve ) => {
	setTimeout( () => resolve( fallback ), ms ).unref();
} ) ] );
const until = async ( check, ms = 60000 ) => {
	for ( const end = Date.now() + ms; Date.now() < end; await wait( 20 ) ) {
		const _value = check();
		if ( _value ) { return _value; }
	}
	return null;
};

// Waits are real minutes, also in a test (docs/missions.md): a supplier who does not answer is heard as silence after
// three seconds here instead of two days. The world answers within a second at WORLD_SPEED 100.
const fast = ( mission ) => {
	for ( const move of Object.values( mission.moves ) ) {
		if ( move.creates?.expectation ) { move.creates.expectation.minutes = 0.05; }
	}
	for ( const strategy of mission.strategies ) {
		for ( const step of strategy.steps ) {
			if ( step.move === 'document.wait' ) { step.params.minutes = 0.05; }
		}
	}
};

// The person: approves everything unread, answers each ticket with its recommendation; an escalation is closed, never
// retried, and a strategy gate is never lifted (only a person can, and this one does not).
function person() {
	const _tickets = [];
	const _approvals = [];
	return {
		tickets: _tickets,
		approvals: _approvals,
		approve( approval ) {
			if ( !_approvals.some( item => item.id === approval.id ) ) { _approvals.push( approval ); }
			return true;
		},
		answer( ticket ) {
			if ( !_tickets.some( item => item.id === ticket.id ) ) { _tickets.push( ticket ); }
			return ticket.kind === 'escalation' ? 'close as failed' : ( ticket.recommendation ?? ticket.options[ 0 ] );
		},
	};
}

const tree = node => [ node, ...node.children.flatMap( tree ) ];
const label = ( node ) => {
	if ( !node.parent ) { return 'root'; }
	const [ _first ] = node.contract.criteria;
	if ( _first.type === 'confirmed_by' ) { return `verify:${String( _first.values.question ).split( ':' ).slice( 1 ).join( ':' )}`; }
	return _first.values.items[ 0 ];
};
const outcome = ( node ) => {
	const _item = node.parent ? label( node ) : null;
	return node.facts.find( fact => fact.kind === 'item_resolved' && fact.data?.item === _item )?.data.outcome ?? null;
};
const shape = root => tree( root ).map( node => [ node.depth, label( node ), node.result?.status, outcome( node ) ] );
const node = ( root, what ) => tree( root ).find( item => label( item ) === what );

const rows = ( o, sql, params = {} ) => o.gateDb.all( sql, params ).map( row => ( { ...row,
	params: row.params ? JSON.parse( row.params ) : null, summary: row.summary ? JSON.parse( row.summary ) : undefined } ) );
const sent = ( o, action ) => rows( o, 'SELECT * FROM outbox WHERE action = :action ORDER BY time', { action } );
const deliveries = ( o, action ) => rows( o, 'SELECT * FROM deliveries WHERE action = :action', { action } );

// The order in which the nodes started (node_created) and closed (node_closed), from the core's event log.
function order( o, root ) {
	const _events = o.log.since( 0, 1e9 );
	const _rank = ( id, kind ) => _events.findIndex( event => event.node === id && event.kind === kind );
	return tree( root ).map( item => ( { node: item, label: label( item ), started: _rank( item.id, 'node_created' ), closed: _rank( item.id, 'node_closed' ) } ) );
}

async function week( { edit = null, answers = {}, share = null, resume = false, approve = null } = {} ) {
	const _person = person();
	const o = await office( {
		mission: Mission.load( 'onboarding' ), share, resume, answers,
		edit: ( mission ) => {
			fast( mission );
			edit?.( mission );
		},
		approve: approve
			? approval => ( approve( approval ) === null ? null : _person.approve( approval ) )
			: approval => _person.approve( approval ),
		person: ticket => _person.answer( ticket ),
	} );
	return { o, person: _person };
}

test( 'week 45: Lindqvist is verified through three levels of preconditions and paid; Okoro is reminded once, sends a wrong bank letter and is escalated', async ( t ) => {
	const { o, person: _person } = await week();
	const _root = await within( o.run(), 120000 );
	await wait( 100 );
	o.stop();
	assert.ok( _root, 'the week ended in time' );
	const _nodes = tree( _root );
	const _order = order( o, _root );
	t.diagnostic( `tree: ${JSON.stringify( shape( _root ) )}` );
	t.diagnostic( `started: ${[ ..._order ].sort( ( a, b ) => a.started - b.started ).map( item => item.label ).join( ' > ' )}` );
	t.diagnostic( `closed: ${[ ..._order ].sort( ( a, b ) => a.closed - b.closed ).map( item => item.label ).join( ' > ' )}` );

	await t.test( '1 tree shape: root, one sub-goal per supplier, its verification, one sub-goal per document; depth 3 reached', () => {
		assert.deepEqual( shape( _root ), EXPECTED, JSON.stringify( shape( _root ) ) );
		assert.equal( Math.max( ..._nodes.map( item => item.depth ) ), 3 );
		assert.equal( _root.parent, null );
		assert.deepEqual( _root.children.map( label ), [ LT, OK ] );
		for ( const supplier of _root.children ) {
			assert.equal( supplier.depth, 1 );
			assert.equal( supplier.parent, _root );
			assert.equal( supplier.children.length, 1, 'one verification per supplier' );
			const [ _verification ] = supplier.children;
			assert.equal( _verification.parent, supplier );
			assert.equal( _verification.depth, 2 );
			assert.equal( _verification.contract.criteria[ 0 ].type, 'confirmed_by' );
			assert.equal( _verification.contract.criteria[ 0 ].values.role, 'purchasing' );
			assert.deepEqual( _verification.children.map( item => [ item.depth, item.parent, label( item ) ] ),
				[ [ 3, _verification, `tax:${label( supplier ).split( ':' )[ 1 ]}` ], [ 3, _verification, `bank:${label( supplier ).split( ':' )[ 1 ]}` ] ] );
		}
		// The verification and the documents are children the engine made for missing preconditions (U2): each one's
		// goal is exactly the precondition its parent's strategy gate named (R6), never a step of a plan.
		for ( const item of _nodes.filter( one => one.depth >= 2 ) ) {
			const _named = item.parent.walls.find( wall => wall.precondition?.id === item.contract.serves.precondition )?.precondition;
			assert.ok( _named, `${label( item )} was made for a precondition its parent named` );
			assert.equal( item.parent.walls.find( wall => wall.precondition?.id === _named.id ).cause, 'precondition_missing' );
			assert.deepEqual( item.contract.criteria[ 0 ].values, _named.values );
		}
		// Every node carries every invariant of the root (the rules travel down the tree by construction).
		for ( const item of _nodes ) {
			for ( const type of [ 'exactly_once', 'account_from_master', 'sum_max', 'human_approval' ] ) {
				assert.ok( item.contract.criteria.some( one => one.type === type ), `${label( item )} carries ${type}` );
			}
		}
		// Nesting in time: a child starts after its parent and closes before it; siblings run one after another.
		const _at = item => _order.find( one => one.node === item );
		for ( const item of _nodes.slice( 1 ) ) {
			assert.ok( _at( item ).started > _at( item.parent ).started && _at( item ).closed < _at( item.parent ).closed, label( item ) );
		}
		for ( const item of _nodes.filter( one => one.children.length === 2 ) ) {
			assert.ok( _at( item.children[ 0 ] ).closed < _at( item.children[ 1 ] ).started, `${label( item )}: one child after the other` );
		}
	} );

	await t.test( '2 Lindqvist: both documents, then the verification, then the payment to the master-data account, approved with amount and reason', () => {
		const _events = o.log.since( 0, 1e9 );
		const _closed = what => _events.findIndex( event => event.node === node( _root, what ).id && event.kind === 'node_closed' );
		const _supplier = node( _root, LT );
		const _paying = _events.findIndex( event => event.node === _supplier.id && event.kind === 'move_started' && event.data.move === 'payment.send' );
		assert.ok( _closed( 'tax:lindqvist-tools-ab' ) < _closed( 'bank:lindqvist-tools-ab' ) );
		assert.ok( _closed( 'bank:lindqvist-tools-ab' ) < _closed( 'verify:lindqvist-tools-ab' ) );
		assert.ok( _paying > _closed( 'verify:lindqvist-tools-ab' ), 'the payment move started only after the verification closed' );
		assert.equal( _events.filter( event => event.node === _supplier.id && event.kind === 'move_started' && event.data.move === 'payment.send' ).length, 1,
			'the payment move never started before (the gate blocked it before it began)' );
		// The documents settled on the trusted check's own observation; the verification on a person's yes.
		for ( const what of [ 'tax:lindqvist-tools-ab', 'bank:lindqvist-tools-ab' ] ) {
			const _fact = node( _root, what ).facts.find( fact => fact.kind === 'item_resolved' );
			assert.deepEqual( [ _fact.data.outcome, _fact.evidenceClass ], [ 'checked', 'observation' ] );
		}
		const _yes = node( _root, 'verify:lindqvist-tools-ab' ).facts.find( fact => fact.kind === 'confirmation' );
		assert.deepEqual( [ _yes.data.role, _yes.data.choice, _yes.evidenceClass ], [ 'purchasing', 'yes', 'confirmation' ] );
		const _ticket = _person.tickets.find( ticket => /Supplier:lindqvist-tools-ab/.test( ticket.question ) );
		assert.match( JSON.stringify( _ticket.excerpt ), /the IBAN on the bank letter is the registered IBAN/, 'the person saw the checked documents' );
		// The payment: once, to the account in the master data, approved by a person who saw the amount, with a reason.
		const [ _payment, ..._more ] = sent( o, 'supplier_payment' );
		assert.deepEqual( _more, [] );
		assert.deepEqual( [ _payment.params.item, _payment.params.invoiceId, _payment.params.amount ], [ LT, 'LT-2026-0117', 12480 ] );
		assert.equal( _payment.params.iban, REGISTERED[ 'lindqvist-tools-ab' ] );
		assert.ok( MASTER.account.includes( _payment.params.iban ) );
		const [ _delivery ] = deliveries( o, 'supplier_payment' );
		const [ _approval ] = rows( o, 'SELECT * FROM approvals WHERE delivery = :id', { id: _delivery.id } );
		assert.equal( _approval.status, 'consumed' );
		assert.equal( _approval.decidedBy, 'test-person' );
		assert.ok( _approval.reason && _approval.reason.trim(), 'the approval carries a reason' );
		assert.equal( _approval.summary.params.amount, 12480, 'the approval names the amount' );
		assert.equal( _approval.summary.params.iban, REGISTERED[ 'lindqvist-tools-ab' ] );
		const _fact = _supplier.facts.find( fact => fact.kind === 'item_resolved' );
		assert.deepEqual( [ _fact.data.outcome, _fact.evidenceClass ], [ 'paid', 'observation' ] );
	} );

	await t.test( '3 Okoro: one reminder, never two; the letter\'s IBAN never reaches a payment; a person is told; the outcome is escalated', () => {
		const _bank = 'bank:okoro-metals-ltd';
		assert.equal( sent( o, 'doc_request' ).filter( row => row.params.document === _bank ).length, 1 );
		assert.deepEqual( sent( o, 'doc_reminder' ).map( row => [ row.target, row.address, row.params.document ] ),
			[ [ 'okoro-metals-ltd', 'accounts@okoro-metals.example', _bank ] ], 'one reminder in the whole week, for the one missing document' );
		const _doc = node( _root, _bank );
		assert.deepEqual( _doc.walls.map( wall => wall.cause ), [ 'no_reaction', 'move_failed' ] );
		assert.match( _doc.walls[ 1 ].reason, /differs from the IBAN the supplier gave at registration/ );
		// The wrong IBAN is nowhere at the gate: no payment, approval or delivery ever held it.
		const _gate = JSON.stringify( [ o.gateDb.all( 'SELECT * FROM deliveries' ), o.gateDb.all( 'SELECT * FROM approvals' ), o.gateDb.all( 'SELECT * FROM outbox' ) ] );
		assert.ok( !_gate.includes( LETTER_IBAN ), 'the bank letter\'s IBAN never reached the gate' );
		assert.ok( !deliveries( o, 'supplier_payment' ).some( row => row.params.invoiceId === 'OKM-25-0042' || row.params.item === OK ), 'no payment for Okoro was even attempted' );
		// It went up the tree: the document failed, so the verification failed, so the invoice was handed to purchasing.
		assert.equal( node( _root, 'verify:okoro-metals-ltd' ).result.reason, 'escalated to the parent node' );
		assert.ok( node( _root, OK ).walls.some( wall => wall.cause === 'child_failed' ) );
		assert.ok( !_person.tickets.some( ticket => /Supplier:okoro-metals-ltd/.test( ticket.question ) ), 'nobody was asked to confirm Okoro' );
		const _told = _person.tickets.find( ticket => /OKM-25-0042/.test( ticket.question ) );
		assert.ok( _told, 'purchasing got a ticket about Okoro\'s invoice' );
		const _excerpt = JSON.stringify( _told.excerpt );
		assert.match( _excerpt, /differs from the IBAN the supplier gave at registration/ );
		assert.match( _excerpt, new RegExp( LETTER_IBAN ) );
		const _fact = node( _root, OK ).facts.find( fact => fact.kind === 'item_resolved' );
		assert.deepEqual( [ _fact.data.outcome, _fact.evidenceClass ], [ 'escalated', 'confirmation' ] );
		const _rootFact = _root.facts.find( fact => fact.kind === 'item_resolved' && fact.data.item === OK );
		assert.equal( _rootFact.data.outcome, 'escalated' );
	} );

	await t.test( '4 money: the week stays within 20,000 EUR and every invoice is paid at most once', () => {
		const _paid = deliveries( o, 'supplier_payment' ).filter( row => row.status === 'executed' );
		assert.ok( _paid.reduce( ( sum, row ) => sum + row.params.amount, 0 ) <= CAP );
		const _ids = _paid.map( row => row.params.invoiceId );
		assert.equal( new Set( _ids ).size, _ids.length );
		assert.deepEqual( sent( o, 'supplier_payment' ).map( row => row.params.invoiceId ), [ 'LT-2026-0117' ] );
		for ( const item of _nodes ) {
			assert.ok( item.contract.criteria.some( one => one.type === 'sum_max' && one.values.max <= CAP ), `${label( item )} carries the cap` );
		}
	} );

	await t.test( '6 every node closes with a result', () => {
		const _all = [ ...o.runner.nodes.values() ];
		assert.equal( _all.length, _nodes.length, 'no node outside the tree (no stray case)' );
		for ( const item of _all ) {
			assert.equal( item.state, 'closed', label( item ) );
			assert.ok( [ 'fulfilled', 'failed' ].includes( item.result?.status ), `${label( item )}: ${JSON.stringify( item.result )}` );
		}
		assert.equal( _root.result.status, 'fulfilled', JSON.stringify( _root.result ) );
		// No gate was lifted, no escalation reached a person at the root.
		assert.ok( !o.log.since( 0, 1e9 ).some( event => event.kind === 'strategy_gate_lifted' ) );
		assert.ok( !_person.tickets.some( ticket => ticket.kind === 'escalation' ) );
	} );
} );

test( '5 restart: a crash while a document request waits for its approval; nothing is sent twice and the tree closes the same way', async ( t ) => {
	// The person holds back the approval of Lindqvist's bank letter request; by then the tax certificate is in.
	const _held = approval => approval.summary?.action === 'doc_request' && approval.summary?.params?.document === 'bank:lindqvist-tools-ab';
	const { o: _first } = await week( { approve: approval => ( _held( approval ) ? null : true ) } );
	_first.run().catch( () => {} );
	const _pending = await until( () => _first.egress.pendingApprovals().find( _held ), 60000 );
	assert.ok( _pending, 'the bank letter request waits for its approval' );
	assert.deepEqual( sent( _first, 'doc_request' ).map( row => row.params.document ), [ 'tax:lindqvist-tools-ab' ] );
	_first.crash();

	const { o: _second } = await week( { share: _first, resume: true } );
	try {
		const [ _root ] = await within( _second.resumed, 120000, [ null ] );
		assert.ok( _root, 'the resumed week ended in time' );
		t.diagnostic( `resumed tree: ${JSON.stringify( shape( _root ) )}` );
		assert.deepEqual( shape( _root ), EXPECTED, JSON.stringify( shape( _root ) ) );
		const _count = ( action ) => {
			const _by = {};
			sent( _second, action ).forEach( ( row ) => {
				const _key = row.params.document || row.params.invoiceId;
				_by[ _key ] = ( _by[ _key ] || 0 ) + 1;
			} );
			return _by;
		};
		assert.deepEqual( _count( 'doc_request' ), { 'tax:lindqvist-tools-ab': 1, 'bank:lindqvist-tools-ab': 1, 'tax:okoro-metals-ltd': 1, 'bank:okoro-metals-ltd': 1 } );
		assert.deepEqual( _count( 'doc_reminder' ), { 'bank:okoro-metals-ltd': 1 } );
		assert.deepEqual( _count( 'supplier_payment' ), { 'LT-2026-0117': 1 } );
		assert.equal( _first.egress.store.delivery( _pending.delivery ).status, 'not_sent', 'the dead core\'s pending request was withdrawn' );
		for ( const item of tree( _root ) ) {
			assert.equal( item.state, 'closed', label( item ) );
			assert.ok( [ 'fulfilled', 'failed' ].includes( item.result?.status ), label( item ) );
		}
	} finally {
		_second.stop();
	}
} );

test( 'the cap at the gate: had Okoro sent the right letter, its payment would break 20,000 EUR; the gate refuses it and the invoice goes to a person', async ( t ) => {
	// The same week with one change in the world: Okoro's late bank letter names the registered IBAN.
	const _right = ( mission ) => {
		const _reply = mission.world.responders.find( item => item.on.action === 'doc_reminder' ).replies[ 0 ];
		_reply.text = _reply.text.replace( LETTER_IBAN, REGISTERED[ 'okoro-metals-ltd' ] );
	};
	const _stub = JSON.parse( fs.readFileSync( path.join( MISSIONS, 'onboarding/stub.json' ), 'utf8' ) );
	const _extractor = [ ..._stub.extractor, { when: REGISTERED[ 'okoro-metals-ltd' ], answer: { iban: REGISTERED[ 'okoro-metals-ltd' ].toLowerCase() } } ];
	const { o, person: _person } = await week( { edit: _right, answers: { extractor: _extractor } } );
	const _root = await within( o.run(), 120000 );
	await wait( 100 );
	o.stop();
	assert.ok( _root, 'the week ended in time' );
	assert.equal( _root.result.status, 'fulfilled', JSON.stringify( _root.result ) );
	assert.equal( node( _root, 'verify:okoro-metals-ltd' ).result.status, 'fulfilled', 'Okoro was verified this time' );
	const _refused = deliveries( o, 'supplier_payment' ).filter( row => row.status === 'refused' );
	assert.equal( _refused.length, 1, JSON.stringify( deliveries( o, 'supplier_payment' ).map( row => [ row.status, row.reasons ] ) ) );
	assert.equal( _refused[ 0 ].params.invoiceId, 'OKM-25-0042' );
	assert.match( _refused[ 0 ].reasons, /sum_max|20000|cap/i, _refused[ 0 ].reasons );
	t.diagnostic( `refused payment: ${_refused[ 0 ].reasons}; Okoro walls: ${JSON.stringify( node( _root, OK ).walls.map( wall => [ wall.cause, wall.reason ] ) )}` );
	const _paid = deliveries( o, 'supplier_payment' ).filter( row => row.status === 'executed' );
	assert.deepEqual( _paid.map( row => row.params.invoiceId ), [ 'LT-2026-0117' ] );
	assert.ok( _paid.reduce( ( sum, row ) => sum + row.params.amount, 0 ) <= CAP );
	assert.equal( outcome( node( _root, OK ) ), 'escalated' );
	assert.ok( _person.tickets.some( ticket => /OKM-25-0042/.test( ticket.question ) ) );
} );

test( 'one reminder at the gate: a careless edit that reminds twice still sends one reminder', async ( t ) => {
	// The reminder strategy now sends its reminder twice; the gate's exactly_once on doc_reminder refuses the second.
	const _twice = ( mission ) => {
		const _steps = mission.strategies.find( item => item.id === 'remind-bank-letter' ).steps;
		_steps.splice( 2, 0, { move: 'bank.remind', from: 'letter', params: { document: '{{items|first}}' }, target: '{{items|subject}}', as: 'again' } );
	};
	const { o } = await week( { edit: _twice } );
	const _root = await within( o.run(), 120000 );
	await wait( 100 );
	o.stop();
	assert.ok( _root, 'the week ended in time' );
	assert.equal( sent( o, 'doc_reminder' ).length, 1 );
	const _refused = deliveries( o, 'doc_reminder' ).filter( row => row.status === 'refused' );
	assert.equal( _refused.length, 1 );
	assert.match( _refused[ 0 ].reasons, /exactly_once|already/i, _refused[ 0 ].reasons );
	t.diagnostic( `refused reminder: ${_refused[ 0 ].reasons}` );
	assert.equal( outcome( node( _root, OK ) ), 'escalated' );
	assert.equal( sent( o, 'supplier_payment' ).length, 1 );
} );

test( 'limit, documented: "verified before paid" lives in the core\'s strategy gate only; without gates.json the gate process pays an unverified supplier', async () => {
	// Not a rule test but evidence for FRICTION.md: the gate process knows accounts, sums, approvals and "exactly once",
	// not verification. A mission edit that drops the strategy gates pays Lindqvist with no document asked for.
	const { o } = await week( { edit: ( mission ) => { mission.gates = []; } } );
	const _root = await within( o.run(), 120000 );
	await wait( 100 );
	o.stop();
	assert.ok( _root, 'the week ended in time' );
	assert.deepEqual( sent( o, 'doc_request' ), [], 'no document was requested' );
	assert.deepEqual( sent( o, 'supplier_payment' ).map( row => row.params.invoiceId ), [ 'LT-2026-0117' ], 'Lindqvist was paid unverified' );
	// What still held at the gate: Okoro's payment broke the weekly cap (by the order of the invoices, not by design).
	const _refused = deliveries( o, 'supplier_payment' ).filter( row => row.status === 'refused' );
	assert.equal( _refused.length, 1 );
	assert.match( _refused[ 0 ].reasons, /sum_max/ );
	assert.equal( Math.max( ...tree( _root ).map( item => item.depth ) ), 1, 'no recursion at all without the gates' );
} );
