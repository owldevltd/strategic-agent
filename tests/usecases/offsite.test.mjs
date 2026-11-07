// Case 14 of tests/usecases/CASES.md: an offsite for three teams (breadth, depth and a dependency between siblings),
// through the real loop and the real gate with the stub model and a scripted person. The mission and this test were
// written by an agent that knew nothing of the engine but the README and docs/missions.md, as a company's developer
// would.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AGENCY_MISSIONS = 'missions,tests/usecases';
const { office, Mission } = await import( '../office.mjs' );

const TEAMS = [ 'design', 'engineering', 'sales' ];
const ROSTER = { design: 6, engineering: 8, sales: 5 };
const SUPPLIERS = [ 'venue-a', 'venue-b', 'caterer-x' ];

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

// Real minutes are real in a test too; the world runs at WORLD_SPEED 100 (a world second is 10 ms). The reply windows
// shrink to about 2.4 s; every scripted answer comes within 1.2 s of its message.
const SHORT = 0.04;
const shorten = ( mission ) => {
	for ( const move of Object.values( mission.moves ) ) {
		if ( move.creates?.expectation ) { move.creates.expectation.minutes = SHORT; }
	}
};

const sent = ( o, action ) => o.gateDb.all( 'SELECT * FROM outbox WHERE action = :action ORDER BY time', { action } )
	.map( row => ( { target: row.target, address: row.address, ...JSON.parse( row.params ) } ) );
const deliveries = ( o, action ) => o.gateDb.all( 'SELECT * FROM deliveries WHERE action = :action', { action } )
	.map( row => ( { ...row, params: JSON.parse( row.params ) } ) );
const runnerOf = o => o.runner || o.system.runners[ 0 ];
const goals = o => [ ...runnerOf( o ).nodes.values() ].filter( node => node.contract.spec?.kind !== 'request' );
const cases = o => [ ...runnerOf( o ).nodes.values() ].filter( node => node.contract.spec?.kind === 'request' );
const itemOf = node => node.contract.criteria.find( item => item.type === 'items_resolved' )?.values.items[ 0 ]
	?? node.contract.criteria.find( item => item.type === 'number_in_range' )?.values.quantity;
// When a node started and closed, as positions in the core's event log (one sequence for the whole tree).
const span = ( o, node ) => {
	const _events = o.log.forNode( node.id );
	return { started: _events[ 0 ]?.id ?? null, closed: _events.find( event => event.kind === 'node_closed' )?.id ?? null };
};

// The tree as the engine built it, in the order the nodes started, for FRICTION.md and for the assertions.
const drawn = ( o ) => {
	const _rows = goals( o ).map( node => ( { node, ...span( o, node ) } ) ).sort( ( a, b ) => a.started - b.started );
	const _closing = [ ..._rows ].sort( ( a, b ) => a.closed - b.closed ).map( row => row.node.id );
	const _name = node => ( node.parent ? node.contract.id.split( '/' ).at( -1 ) : 'offsite (root)' );
	return _rows.map( row => `${'  '.repeat( row.node.depth )}d${row.node.depth} ${_name( row.node )} [${itemOf( row.node )}]`
		+ `  started #${_rows.indexOf( row ) + 1} closed #${_closing.indexOf( row.node.id ) + 1}  ${row.node.result?.status}`
		+ `  parent=${row.node.parent ? _name( row.node.parent ) : '-'}` ).join( '\n' );
};

const person = tickets => ( ticket ) => {
	if ( !tickets.some( item => item.id === ticket.id ) ) { tickets.push( ticket ); }
	return ticket.recommendation ?? ticket.options[ 0 ];
};

// The checks of the main run, one function per question of the task.
function tree( o, _root ) {
	// 1. Tree shape: depth and parent of every node.
	const _all = goals( o );
	const _depth1 = _all.filter( node => node.depth === 1 );
	const _depth2 = _all.filter( node => node.depth === 2 );
	assert.ok( _all.every( node => node.depth <= 2 ), 'nothing deeper than the reminder round' );
	assert.ok( _depth1.every( node => node.parent === _root ), 'every depth-1 node is a child of the root' );
	const _team = team => _depth1.find( node => itemOf( node ) === `rsvp:${team}` );
	for ( const team of TEAMS ) { assert.ok( _team( team ), `a sub-goal for ${team} at depth 1` ); }
	assert.deepEqual( _depth1.map( itemOf ).sort(), [ 'catering:offsite', 'details:design', 'details:engineering', 'details:sales',
		'rsvp:design', 'rsvp:engineering', 'rsvp:sales', 'venue:offsite' ] );
	assert.equal( _depth2.length, 1, 'exactly one node at depth 2' );
	const [ _reminder ] = _depth2;
	assert.equal( _reminder.parent, _team( 'design' ), 'the reminder round is a sub-goal of the design team\'s sub-goal' );
	assert.equal( itemOf( _reminder ), 'late:design' );
	assert.equal( _reminder.contract.serves?.precondition, 'reminder-design', 'it is the precondition the design count named (U2)' );
	assert.deepEqual( _reminder.contract.criteria[ 0 ].values, { quantity: 'late:design', min: 2 }, 'two answers were missing (2 of 6, 4 needed)' );
	for ( const team of [ 'engineering', 'sales' ] ) {
		assert.equal( _team( team ).children.length, 0, `${team} reached the quorum without a reminder round` );
	}
	assert.ok( _all.every( node => node.contract.criteria.some( item => item.type === 'exactly_once' ) ), 'every node carries the invariants' );
	return { _all, _depth1, _team };
}

function order( o, _root, _depth1, _team ) {
	// 2. Sibling order: venue and catering start only after all three team counts closed.
	const _venue = _depth1.find( node => itemOf( node ) === 'venue:offsite' );
	const _catering = _depth1.find( node => itemOf( node ) === 'catering:offsite' );
	const _countsIn = Math.max( ...TEAMS.map( team => span( o, _team( team ) ).closed ) );
	assert.ok( span( o, _venue ).started > _countsIn, 'the venue sub-goal started after every team count' );
	assert.ok( span( o, _catering ).started > _countsIn, 'the catering sub-goal started after every team count' );
	const _infoStarts = _depth1.filter( node => itemOf( node ).startsWith( 'details:' ) ).map( node => span( o, node ).started );
	assert.ok( Math.min( ..._infoStarts ) > Math.max( span( o, _venue ).closed, span( o, _catering ).closed ), 'details only after venue and catering' );
	// The gate's own record: the first venue request was booked after the last team item was resolved at the root.
	const _resolvedAt = TEAMS.map( team => _root.facts.find( fact => fact.kind === 'item_resolved' && fact.data.item === `rsvp:${team}` )?.time );
	assert.ok( _resolvedAt.every( Boolean ), 'every team count reached the root as evidence' );
	const _firstAsk = deliveries( o, 'venue_request' ).map( row => row.createdAt ).sort()[ 0 ];
	assert.ok( _firstAsk && _resolvedAt.every( time => time <= _firstAsk ), `${_resolvedAt} before ${_firstAsk}` );
	return { _venue, _catering };
}

function venue( o, _venue ) {
	// 3. Venue A declines: B is asked and booked, A never.
	assert.deepEqual( sent( o, 'venue_request' ).map( item => item.target ), [ 'venue-a', 'venue-b' ] );
	const _bookings = sent( o, 'venue_booking' );
	assert.deepEqual( _bookings.map( item => item.target ), [ 'venue-b' ] );
	assert.ok( !deliveries( o, 'venue_booking' ).some( row => row.target === 'venue-a' ), 'no booking of venue A was even asked for' );
	assert.ok( _venue.walls.some( wall => wall.cause === 'move_failed' && /venue-a declined/.test( wall.reason ) ),
		JSON.stringify( _venue.walls.map( wall => [ wall.cause, wall.reason ] ) ) );
	return _bookings;
}

function money( o, _approvals, _bookings ) {
	// 4. Money: every approval of a money action names the amount; venue <= 6,000, catering <= 25 per confirmed person.
	const _money = _approvals.filter( item => [ 'venue_booking', 'catering_order' ].includes( item.summary?.action ) );
	assert.equal( _money.length, 2 );
	for ( const approval of _money ) {
		assert.equal( typeof approval.summary.params.amount, 'number', JSON.stringify( approval.summary ) );
		assert.ok( SUPPLIERS.includes( approval.summary.params.supplier ) );
	}
	assert.equal( _bookings[ 0 ].amount, 4800 );
	assert.ok( _bookings[ 0 ].amount <= 6000 );
	const [ _order ] = sent( o, 'catering_order' );
	assert.equal( _order.headcount, 12, 'design 3 + engineering 6 + sales 3 said yes' );
	assert.equal( _order.amount, 12 * 22 );
	assert.ok( _order.perPerson <= 25 && _order.amount <= 25 * _order.headcount );
	const _paid = [ ..._bookings, _order ].reduce( ( sum, item ) => sum + item.amount, 0 );
	assert.ok( _paid <= 6475 );
	for ( const row of [ ...deliveries( o, 'venue_booking' ), ...deliveries( o, 'catering_order' ) ].filter( item => item.status === 'executed' ) ) {
		const _approval = o.gateDb.get( 'SELECT * FROM approvals WHERE delivery = :delivery', { delivery: row.id } );
		assert.ok( _approval && _approval.status === 'consumed' && _approval.decidedBy === 'test-person', row.action );
	}
}

function whole( o, _all, _tickets ) {
	// 6. The whole run: every node closed with a result; one message of each kind per team; nothing twice.
	for ( const node of _all ) {
		assert.equal( node.state, 'closed', `${itemOf( node )} closed` );
		assert.equal( node.result?.status, 'fulfilled', `${itemOf( node )}: ${JSON.stringify( node.result )}` );
	}
	assert.deepEqual( sent( o, 'offsite_invite' ).map( item => item.target ).sort(), TEAMS );
	assert.deepEqual( sent( o, 'offsite_reminder' ).map( item => item.target ), [ 'design' ] );
	const _details = sent( o, 'offsite_details' );
	assert.deepEqual( _details.map( item => item.target ).sort(), TEAMS );
	for ( const item of _details ) {
		assert.match( item.body, /2026-12-04/ );
		assert.match( item.body, /Loft Nordstern/ );
		assert.match( item.body, /09:30 to 17:00/ );
		// No team hears of another team's answers: the text names no other team and no count.
		for ( const other of TEAMS.filter( team => team !== item.target ) ) { assert.doesNotMatch( item.body, new RegExp( other ) ); }
		assert.doesNotMatch( item.body, /\b(answered|yes|no|headcount|\d+ of \d+)\b/i );
	}
	assert.equal( cases( o ).length, 0, 'no answer came in after its goal had closed' );
	assert.deepEqual( [ ...new Set( o.gateDb.all( 'SELECT action FROM outbox' ).map( row => row.action ) ) ].sort(),
		[ 'catering_order', 'offsite_details', 'offsite_invite', 'offsite_reminder', 'venue_booking', 'venue_request' ] );
	assert.equal( _tickets.filter( ticket => ticket.kind === 'escalation' ).length, 0, 'nothing went to the office manager' );
	// The vault: four of six designers, seven of eight engineers, four of five sales people answered.
	const _rsvp = runnerOf( o ).vault.rows( 'rsvp.csv' );
	for ( const team of TEAMS ) {
		const _n = _rsvp.filter( row => row.team === team ).length;
		assert.ok( _n >= Math.ceil( ROSTER[ team ] * 0.6 ), `${team}: ${_n} of ${ROSTER[ team ]}` );
	}
}

test( 'the offsite: a team tree with a reminder round at depth 2, venue B after A declines, money within limits', async () => {
	const _approvals = [];
	const _tickets = [];
	const o = await office( {
		mission: Mission.load( 'offsite' ), edit: shorten,
		approve: ( approval ) => {
			_approvals.push( approval );
			return true;
		},
		person: person( _tickets ),
	} );
	try {
		const _root = await within( o.run(), 150000 );
		assert.ok( _root, 'the offsite run ended in time' );
		console.log( `\nthe tree as built:\n${drawn( o )}\n` );
		assert.equal( _root.result?.status, 'fulfilled', JSON.stringify( _root.result ) );

		const { _all, _depth1, _team } = tree( o, _root );
		const { _venue } = order( o, _root, _depth1, _team );
		const _bookings = venue( o, _venue );
		money( o, _approvals, _bookings );
		whole( o, _all, _tickets );
	} finally {
		o.stop();
	}
} );

test( 'a crash while the design team\'s reminder round waits for its approval: after the restart nothing goes twice and the tree closes', async () => {
	const _held = approval => approval.summary?.action === 'offsite_reminder';
	const _first = await office( { mission: Mission.load( 'offsite' ), edit: shorten, approve: approval => ( _held( approval ) ? null : true ) } );
	_first.run().catch( () => {} );
	const _pending = await until( () => _first.egress.pendingApprovals().find( _held ), 60000 );
	assert.ok( _pending, 'the reminder to design waits for its approval' );
	// The crash is in the middle of the tree: root (depth 0) and design (depth 1) wait for the reminder round (depth 2).
	const _round = goals( _first ).find( node => node.depth === 2 );
	assert.ok( _round && _round.parent.depth === 1 && _round.state !== 'closed' );
	assert.deepEqual( sent( _first, 'offsite_invite' ).map( item => item.target ), [ 'design' ] );
	assert.equal( sent( _first, 'offsite_reminder' ).length, 0 );
	_first.crash();

	const _second = await office( { mission: Mission.load( 'offsite' ), edit: shorten, share: _first, resume: true } );
	try {
		const [ _root ] = await within( _second.resumed, 150000, [ null ] );
		console.log( `\nthe tree after the restart:\n${drawn( _second )}\n` );
		assert.equal( _root?.result?.status, 'fulfilled', JSON.stringify( _root?.result ) );
		assert.equal( _first.egress.store.delivery( _pending.delivery ).status, 'not_sent', 'the dead core\'s pending reminder was withdrawn' );
		assert.deepEqual( sent( _second, 'offsite_reminder' ).map( item => item.target ), [ 'design' ], 'one reminder, after the restart' );
		assert.deepEqual( sent( _second, 'offsite_invite' ).map( item => item.target ).sort(), TEAMS, 'no invitation twice' );
		assert.deepEqual( sent( _second, 'venue_booking' ).map( item => item.target ), [ 'venue-b' ] );
		assert.equal( sent( _second, 'catering_order' ).length, 1 );
		assert.deepEqual( sent( _second, 'offsite_details' ).map( item => item.target ).sort(), TEAMS );
		for ( const action of [ 'offsite_invite', 'offsite_reminder', 'offsite_details' ] ) {
			const _executed = deliveries( _second, action ).filter( row => row.status === 'executed' ).map( row => row.params.team );
			assert.equal( new Set( _executed ).size, _executed.length, `${action}: one per team` );
		}
		const _all = goals( _second );
		assert.equal( _all.filter( node => node.depth === 2 ).length, 1, 'still one reminder round' );
		for ( const node of _all ) { assert.equal( node.result?.status, 'fulfilled', `${itemOf( node )}: ${JSON.stringify( node.result )}` ); }
		// The design team counted with the answers from before the crash and after it.
		const _rsvp = runnerOf( _second ).vault.rows( 'rsvp.csv' ).filter( row => row.team === 'design' );
		assert.deepEqual( _rsvp.map( row => row.round ).sort(), [ 'invitation', 'invitation', 'reminder', 'reminder' ] );
	} finally {
		_second.stop();
	}
} );

test( 'the sibling dependency is the engine\'s: with the venue put first in the plan, the gate holds it until every team is counted', async () => {
	// A careless edit puts the venue sub-goal before the team sub-goals. The strategy gate on venue.child checks the
	// root's facts: no team is counted, so the move is blocked and no venue is asked.
	const _first = ( mission ) => {
		shorten( mission );
		const _steps = mission.strategies.find( item => item.id === 'plan-the-offsite' ).steps;
		_steps.unshift( ..._steps.splice( 1, 1 ) );
	};
	// The office manager never lifts the gate here: only a person may, and that would be her decision, not the engine's.
	const o = await office( { mission: Mission.load( 'offsite' ), edit: _first,
		person: ticket => ( ticket.kind === 'escalation' ? 'close as failed' : ticket.recommendation ?? ticket.options[ 0 ] ) } );
	try {
		const _root = await within( o.run(), 60000 );
		console.log( `\nthe tree with the venue first:\n${drawn( o )}\nroot: ${JSON.stringify( _root?.result )}\n` );
		const _blocked = runnerOf( o ).root.walls.find( wall => wall.cause === 'precondition_missing' && /venue\.child is blocked by a strategy gate/.test( wall.reason ) );
		assert.ok( _blocked, JSON.stringify( runnerOf( o ).root.walls.map( wall => [ wall.cause, wall.reason ] ) ) );
		assert.equal( sent( o, 'venue_request' ).length, 0, 'no venue was asked before the teams were counted' );
		assert.equal( sent( o, 'venue_booking' ).length + sent( o, 'catering_order' ).length, 0, 'no money moved' );
		for ( const action of [ 'offsite_invite', 'offsite_reminder' ] ) {
			const _targets = sent( o, action ).map( item => item.target );
			assert.equal( new Set( _targets ).size, _targets.length, `${action}: never twice to a team` );
		}
	} finally {
		o.stop();
	}
} );

test( 'a team still below 60 % after its reminder round goes to the office manager, who decides; no second reminder', async () => {
	// Only Emil answers the reminder: design has 3 of 6 answers, 4 are needed.
	const _slow = ( mission ) => {
		shorten( mission );
		const _reminder = mission.world.responders.find( item => item.on.action === 'offsite_reminder' );
		_reminder.replies = _reminder.replies.filter( reply => reply.from === 'Emil Roth' );
	};
	const _tickets = [];
	const o = await office( { mission: Mission.load( 'offsite' ), edit: _slow, person: person( _tickets ) } );
	try {
		const _root = await within( o.run(), 150000 );
		console.log( `\nthe tree with design still short:\n${drawn( o )}\n` );
		assert.equal( _root?.result?.status, 'fulfilled', JSON.stringify( _root?.result ) );
		const _design = goals( o ).find( node => node.depth === 1 && itemOf( node ) === 'rsvp:design' );
		const [ _round ] = _design.children;
		assert.equal( _round.depth, 2 );
		assert.equal( _round.result.status, 'failed', 'the reminder round did not reach the missing answers' );
		const _decision = _design.facts.find( fact => fact.kind === 'item_resolved' && fact.data.item === 'rsvp:design' );
		assert.equal( _decision?.data.outcome, 'decided' );
		assert.equal( _decision?.evidenceClass, 'confirmation', 'the office manager decided, not the engine' );
		assert.ok( _tickets.some( ticket => /Team design is still below 60 %/.test( ticket.question ) ),
			_tickets.map( ticket => ticket.question ).join( ' | ' ) );
		assert.deepEqual( sent( o, 'offsite_reminder' ).map( item => item.target ), [ 'design' ], 'one reminder round only' );
		assert.deepEqual( sent( o, 'offsite_invite' ).map( item => item.target ).sort(), TEAMS );
		assert.equal( sent( o, 'catering_order' )[ 0 ]?.headcount, 11, 'the caterer is ordered for the yes answers in the vault' );
	} finally {
		o.stop();
	}
} );
