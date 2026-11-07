import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';
import { office, registry, Contract } from '../office.mjs';

const [ Journal, Memory, ReadCheck, Closing, Node, Db ] = await use( 'Core.Learn.Journal', 'Core.Memory.Memory', 'Core.Check.ReadCheck',
	'Core.Loop.Closing', 'Core.Node.Node', 'Lib.Db' );

// The invitation waits long enough on its own; only the review (t_signal) can end it early.
const reviewed = ( tSignalH, later = 0 ) => ( mission ) => {
	mission.moves[ 'followup.invite' ].creates.expectation.minutes = 5;
	mission.strategies.find( item => item.id === 'invite-the-team' ).tSignalH = tSignalH;
	mission.world.people.forEach( person => person.replies.forEach( reply => reply.after += later ) );
};
const attemptOf = ( o, strategy ) => o.runner.journal.all().find( row => row.strategy === strategy );

test( '19, 5.5: no signal by the review ends the strategy (provisionally); another one is chosen, the attempt stays open', async () => {
	const _o = await office( { edit: reviewed( 0.000005, 50 ) } );
	const _root = await _o.run();
	assert.equal( _root.result.status, 'fulfilled' );
	const [ _child ] = _root.children;
	assert.ok( _o.events( _child, 'review_due' ).some( data => data.strategy === 'invite-the-team' ) );
	assert.ok( _o.events( _child, 'verdict' ).some( data => data.verdict === 'other' && /review/.test( data.rule ) ) );
	assert.ok( _o.events( _child, 'move_cancelled' ).some( data => data.because === 'no signal by the review' ) );
	const _invite = attemptOf( _o, 'invite-the-team' );
	assert.equal( _invite.outcome, 'late_effect', 'the answers came after the review: the timeout was provisional (L5)' );
	assert.equal( _invite.provisional, 'timeout' );
	assert.ok( _invite.signalAt );
	assert.equal( attemptOf( _o, 'wait-longer' ).trigger, 'review', 'the next attempt names what led to it (L2)' );
	const _lesson = _o.db.all( 'SELECT data FROM lessons' ).map( row => JSON.parse( row.data ) ).find( item => item.strategy === 'invite-the-team' );
	assert.equal( _lesson.result, 'late_effect' );
	assert.equal( _lesson.provisional, 'timeout' );
	assert.equal( typeof _lesson.signalAfterH, 'number' );
	assert.deepEqual( Object.keys( _lesson.situation ).sort(), [ 'contact', 'depth', 'month', 'task', 'wall', 'weekday' ] );
	assert.equal( _lesson.situation.contact, 'design' );
} );

test( '5.5: an early signal does not confirm; the attempt goes on to its next review and only the criterion closes it', async () => {
	// A review needs a signal since the previous one to go on (5.5, 19): the review comes after the first answers
	// (up to 120 ms) and the criterion is met by the last one (750 ms) before the next review is due.
	const _o = await office( { edit: reviewed( 0.00014 ) } );
	const _root = await _o.run();
	assert.equal( _root.result.status, 'fulfilled' );
	const [ _child ] = _root.children;
	const _goingOn = _o.events( _child, 'verdict' ).filter( data => data.verdict === 'continue' && /signal does not confirm/.test( data.rule ) );
	assert.ok( _goingOn.length >= 1 );
	const _invite = attemptOf( _o, 'invite-the-team' );
	assert.equal( _invite.outcome, 'done' );
	assert.deepEqual( JSON.parse( _invite.contribution ), [ 'c1' ], 'its own count met the criterion first (L4)' );
	assert.equal( attemptOf( _o, 'wait-longer' ), undefined );
} );

const journalWithClock = () => {
	const _clock = { now: Date.parse( '2026-11-03T16:00:00Z' ) };
	const _db = new Db( ':memory:' );
	return { db: _db, clock: _clock, journal: new Journal( _db, { now: () => _clock.now } ) };
};
const nodeFor = id => ( { id, depth: 0, contract: { hash: 'h' } } );

test( 'L2: the observation ends when another attempt contacts the same side, with reason and trigger; else at the horizon H', () => {
	const { journal, clock } = journalWithClock();
	const _node = nodeFor( 'n1' );
	const _mail = journal.start( _node, { id: 'mail' }, {}, { criterion: 'k1', horizonH: 168 } );
	journal.contact( _node, 'supplier:4711', { by: _mail, trigger: 'start' } );
	journal.end( _mail, { outcome: 'timeout', cause: 'no_reaction' } );
	assert.deepEqual( journal.open( 'n1' ).map( row => ( { ...row } ) ), [ { strategy: 'mail', criterion: 'k1' } ], 'a timeout keeps the attempt open (19)' );
	clock.now += 41.5 * 3600000;
	const _call = journal.start( _node, { id: 'call' }, {}, { criterion: 'k1', trigger: 'review', horizonH: 2 } );
	journal.contact( _node, 'supplier:4711', { by: _call, trigger: 'review' } );
	assert.deepEqual( JSON.parse( journal.get( _mail ).observationEnd ), { fromH: 41.5, reason: 'contact', trigger: 'review' } );
	clock.now += 2.5 * 3600000;
	assert.equal( journal.signal( _mail ).result, 'late_effect', 'a signal is still recorded after the observation ended (20.1)' );
	assert.equal( journal.get( _mail ).signalAt.slice( 0, 16 ), '2026-11-05T12:00' );
	journal.sweep();
	assert.equal( JSON.parse( journal.get( _call ).observationEnd ).reason, 'horizon' );
	clock.now += 200 * 3600000;
	const _other = journal.start( _node, { id: 'other' }, {}, { horizonH: 1 } );
	clock.now += 2 * 3600000;
	journal.end( _other, { outcome: 'timeout' } );
	assert.equal( journal.signal( _other ), null, 'after the horizon nothing is recorded' );
} );

test( '9.3, L5: a late effect after the lesson becomes a signed correction (change plus reason); G5 checks it on reading', () => {
	const { db, journal } = journalWithClock();
	const _memory = new Memory( db );
	journal.listen( ( attempt, change, reason ) => _memory.correctLesson( attempt, change, reason ) );
	const _node = nodeFor( 'n2' );
	const _attempt = journal.start( _node, { id: 'mail' }, { wall: null }, { criterion: 'k1' } );
	journal.end( _attempt, { outcome: 'timeout', cause: 'no_reaction' } );
	const _lesson = Closing.lesson( journal.get( _attempt ), { kind: 'meeting', node: _node, run: 'r1', success: true } );
	assert.equal( _lesson.result, 'timeout' );
	_memory.storeLesson( _lesson );
	journal.signal( _attempt );
	const _row = db.get( 'SELECT data FROM lesson_corrections' );
	assert.deepEqual( JSON.parse( _row.data ).change, { signalAfterH: 0, result: 'late_effect', provisional: 'timeout' } );
	assert.equal( JSON.parse( _row.data ).reason, 'late_effect' );
	const _read = () => new ReadCheck().read( _memory, { kind: 'meeting', journal } ).lessons;
	assert.equal( _read()[ 0 ].result, 'late_effect' );
	assert.equal( JSON.parse( db.get( 'SELECT data FROM lessons' ).data ).result, 'timeout', 'the lesson itself is never overwritten' );
	assert.equal( _memory.correctLesson( _attempt, { strategy: 'other' }, 'late_effect' ), null, 'only what the journal observes can change' );
	db.run( 'UPDATE lesson_corrections SET data = REPLACE( data, \'late_effect\', \'fulfilled\' )' );
	assert.equal( _read()[ 0 ].result, 'timeout', 'a correction changed outside the system is not applied' );
	assert.equal( db.get( 'SELECT status FROM lesson_corrections' ).status, 'quarantined' );
} );

test( 'L4: credit goes to the attempt whose fact met the criterion first, and only within the criterion\'s deadline', () => {
	const _contract = deadline => new Contract( { id: 'c', goal: 'g', deadline: new Date( Date.now() + 3600000 ).toISOString(), budget: 9,
		criteria: [ { id: 'k1', type: 'number_in_range', values: { quantity: 'answers', min: 2 }, deadline } ] }, registry );
	const _measured = value => ( { kind: 'measured', evidenceClass: 'observation', origin: 'system', data: { quantity: 'answers', value } } );
	const _node = new Node( { contract: _contract( new Date( Date.now() + 60000 ).toISOString() ) } );
	_node.plan = { open: true, attempt: 7 };
	_node.addFact( _measured( 1 ) );
	assert.equal( _node.credited.k1, undefined );
	_node.plan = { open: true, attempt: 8 };
	_node.addFact( _measured( 3 ) );
	assert.deepEqual( [ _node.credited.k1.attempt, _node.credited.k1.inTime ], [ 8, true ] );
	const _late = new Node( { contract: _contract( new Date( Date.now() - 60000 ).toISOString() ) } );
	_late.plan = { open: true, attempt: 9 };
	_late.addFact( _measured( 3 ) );
	assert.equal( _late.credited.k1, undefined, 'after its deadline the criterion is not met by this fact, so no strategy gets credit' );
} );

test( 'L3: the contract\'s success is kept apart from the result and the contribution of each attempt', async () => {
	const _o = await office( { edit: mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01 } );
	const _root = await _o.run();
	const _rows = _o.runner.journal.forNode( _root.id );
	assert.ok( _rows.every( row => row.contractSuccess === 1 ) );
	assert.ok( _rows.some( row => row.outcome === 'wall' && JSON.parse( row.contribution ).length === 0 ), 'a wall in a successful contract' );
} );

test( '4.1 step 6, G4: the model proposes the hypothesis of a wall; what fits the schema is written, the rest goes to a person', async () => {
	const _proposals = { proposals: [
		{ attempt: 3, hypothesis: 'too_early' },
		{ attempt: 3, accept: 'KW 48' },
		{ attempt: 4, result: 'fulfilled' },
	] };
	const _asked = [];
	const _o = await office( {
		edit: mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01,
		answers: { learner: [ { when: '"invite-the-team"', answer: _proposals } ] },
		person: ( ticket ) => {
			if ( /G4 refused/.test( ticket.question ) ) { _asked.push( ticket.question ); }
			return ticket.recommendation;
		},
	} );
	const _root = await _o.run();
	assert.equal( _root.result.status, 'fulfilled' );
	const _lessons = _o.db.all( 'SELECT data FROM lessons' ).map( row => JSON.parse( row.data ) );
	assert.equal( _lessons.find( lesson => lesson.attempt === 3 ).hypothesis, 'too_early' );
	assert.ok( !_lessons.some( lesson => 'accept' in lesson ), 'a lesson never carries a rule' );
	assert.equal( _lessons.find( lesson => lesson.attempt === 4 ).result, 'fulfilled' );
	for ( let i = 0; i < 100 && _asked.length < 1; i++ ) { await new Promise( resolve => setTimeout( resolve, 10 ) ); }
	assert.equal( _asked.length, 1, 'the refused proposals of one node go to a person as one suggestion' );
	assert.match( _asked[ 0 ], /accept is not part of a lesson/ );
	assert.match( _asked[ 0 ], /result is observed by code/ );
	await new Promise( resolve => setTimeout( resolve, 30 ) );
	const [ _child ] = _root.children;
	const _history = _o.system.memory.history( _child.id ).filter( entry => entry.kind === 'ticket' && entry.data.kind === 'suggestion' );
	assert.equal( _history.length, 1, 'the answer becomes history (8.4)' );
	assert.ok( _history.every( entry => entry.data.receipt ), 'with their receipt' );
} );
