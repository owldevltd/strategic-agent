// Stress tests of the runner (chapter 4, 16.1, Z2, Z6, R1–R3, G-1a, G-1c): one loop for every node at every depth.
// Attacks: start tokens that run out or are raced for, depth and budget limits, deadlines far away, past or broken,
// a person who never confirms, models that never answer, facts that arrive in the wrong state, errors in the core.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { attack, within } from '../hostile.mjs';
import { Runner, StartAccount, Db, Contract, Mission, registry, rig, placed, attempt, fakeGate, spec, kinds, node, sleep, never, RECEIPT } from './kit.mjs';

const RUN = 'core/loop/runner.js';
const account = () => new StartAccount( new Db( ':memory:' ) );

attack( RUN, 'R1: a runner opens the start account of its tree with B tokens', () => {
	const _account = account();
	const { runner } = rig( { account: _account, startTokens: 7 } );
	assert.equal( _account.left( runner.id ), 7 );
	assert.equal( runner.tokensLeft(), 7 );
} );

attack( RUN, 'a bare runner without an account starts everything (a test rig), and says so with infinite tokens', () => {
	const { runner } = rig();
	assert.equal( runner.tokensLeft(), Infinity );
	assert.equal( runner.burn( () => 'started' ), 'started' );
	assert.equal( runner.burn( () => undefined ), true );
} );

attack( RUN, 'a started node is a draft of the tree, logged with its depth, run and mission', async () => {
	const _rig = rig();
	const _parent = await placed( _rig, 'waiting' );
	const _child = await _rig.runner.start( new Contract( spec(), registry ), _parent );
	assert.deepEqual( [ _child.state, _child.depth, _parent.children.includes( _child ) ], [ 'draft', 1, true ] );
	const [ _created ] = kinds( _rig.log, _child, 'node_created' );
	assert.deepEqual( [ _created.parent, _created.depth, _created.run, _created.mission ], [ _parent.id, 1, _rig.runner.id, 'survey' ] );
} );

attack( RUN, 'a process of its own (a new case, a proposal) belongs to its owner but is no child of it (16.5)', async () => {
	const _rig = rig();
	const _owner = await placed( _rig, 'waiting' );
	const _case = await _rig.runner.start( new Contract( spec(), registry ), null, { owner: _owner } );
	assert.deepEqual( [ _owner.processes, _owner.children, _case.depth ], [ [ _case ], [], 0 ] );
} );

// --- children and their tokens (R1, P4, G-1a) ---

const CHILD = parent => Runner.childSpec( parent, { id: 'p1', goal: 'a precondition', criteria: [ { id: 'c1', type: 'report_delivered', values: { to: 'hr', topic: 'p1' } } ], serves: { criterion: 'k1', precondition: 'p1' } } );

attack( RUN, 'G-1a: a parent that is being aborted starts no child; no token burns', async () => {
	const _account = account();
	const _rig = rig( { account: _account, startTokens: 3 } );
	const _parent = await placed( _rig, 'waiting' );
	_parent.stopping = { reason: 'abort' };
	const _child = await _rig.runner.spawn( _parent, CHILD( _parent ) );
	assert.deepEqual( [ _child.state, _child.result.reason ], [ 'closed', 'the parent is being aborted (G-1a)' ] );
	assert.equal( _account.left( _rig.runner.id ), 3 );
} );

attack( RUN, 'R1: without a start token no child starts, and nothing is reserved for it', async () => {
	const _rig = rig( { account: account(), startTokens: 0 } );
	const _parent = await placed( _rig, 'waiting' );
	const _child = await _rig.runner.spawn( _parent, CHILD( _parent ) );
	assert.equal( _child.result.reason, 'no start tokens left (R1)' );
	assert.equal( _parent.reserved || 0, 0 );
	assert.deepEqual( kinds( _rig.log, _parent, 'child_started' ), [] );
} );

attack( RUN, 'P4: a child the parent cannot pay for is refused; no token burns', async () => {
	const _account = account();
	const _rig = rig( { account: _account, startTokens: 3 } );
	const _parent = await placed( _rig, 'waiting' );
	const _spec = { ...CHILD( _parent ), budget: _parent.contract.budget + 1 };
	const _child = await _rig.runner.spawn( _parent, _spec );
	assert.equal( _child.result.reason, 'the parent cannot reserve its budget (P4)' );
	assert.equal( _account.left( _rig.runner.id ), 3 );
} );

attack( RUN, 'R1: two children raced for the last token: exactly one starts, the other is refused and its reservation flows back', async () => {
	const _rig = rig( { account: account(), startTokens: 1, gate: fakeGate( { confirm: false } ) } );
	const _parent = await placed( _rig, 'waiting', { hours: 0.0001 } );
	const _spawns = [ _rig.runner.spawn( _parent, CHILD( _parent ) ), _rig.runner.spawn( _parent, { ...CHILD( _parent ), id: `${_parent.contract.id}/p2` } ) ];
	const _children = await within( Promise.all( _spawns ), 3000 );
	assert.equal( kinds( _rig.log, _parent, 'child_started' ).length, 1 );
	assert.equal( _children.filter( item => item.result?.reason === 'no start tokens left (R1)' ).length, 1 );
	assert.equal( _parent.reserved, 0, 'both reservations flowed back' );
} );

attack( RUN, 'a child runs as an edge of the wait graph only while it runs (R4), and its reservation flows back', async () => {
	const _rig = rig( { gate: fakeGate( { confirm: false } ) } );
	const _parent = await placed( _rig, 'waiting', { hours: 0.0001 } );
	let _during = null;
	const _run = _rig.runner.run.bind( _rig.runner );
	_rig.runner.run = async ( child ) => {
		_during = [ ...( _rig.runner.waits.edges.get( _parent.id ) || [] ) ].includes( child.id );
		return _run( child );
	};
	await within( _rig.runner.spawn( _parent, CHILD( _parent ) ), 3000 );
	assert.equal( _during, true, 'the parent waits for its child while it runs' );
	assert.equal( _rig.runner.waits.edges.get( _parent.id )?.size ?? 0, 0, 'and no longer once it ended' );
	assert.equal( _parent.reserved, 0 );
	assert.equal( kinds( _rig.log, _parent, 'budget_returned' ).length, 1 );
} );

attack( RUN, 'R2: a child deeper than the maximum depth is refused at G1', async () => {
	const _rig = rig( { maxDepth: 0 } );
	const _parent = await placed( _rig, 'waiting' );
	const _child = await _rig.runner.start( new Contract( CHILD( _parent ), registry ), _parent );
	await within( _rig.runner.run( _child ), 2000 );
	assert.equal( _child.state, 'closed' );
	assert.ok( _child.result.problems.includes( 'depth 1 exceeds the maximum 0 (R2)' ) );
} );

attack( RUN, 'R2: a child exactly at the maximum depth is not refused for its depth', async () => {
	const _rig = rig( { maxDepth: 1 } );
	const _parent = await placed( _rig, 'waiting' );
	const _child = await _rig.runner.start( new Contract( CHILD( _parent ), registry ), _parent );
	_child.stopping = { reason: 'test end', status: 'aborted' };
	await within( _rig.runner.run( _child ), 2000 );
	assert.ok( !( _child.result.problems || [] ).some( text => /exceeds the maximum/.test( text ) ) );
} );

// --- G1 and the person's confirmation ---

attack( RUN, 'a goal G1 refuses never reaches the gate and closes as refused (16.1 draft → closing)', async () => {
	const _rig = rig();
	const _node = await _rig.runner.start( new Contract( spec( { budget: -5 } ), registry ) );
	await within( _rig.runner.run( _node ), 2000 );
	assert.equal( _node.result.reason, 'goal refused at G1' );
	assert.equal( _rig.gate.calls.filter( call => call[ 0 ] === 'propose' ).length, 0 );
} );

attack( RUN, 'a person who never confirms the goal does not hold it: it ends with its deadline, never confirmed', async () => {
	const _rig = rig( { gate: fakeGate( { confirm: false } ) } );
	const _node = await _rig.runner.start( new Contract( spec( {}, 0.00003 ), registry ) );
	await within( _rig.runner.run( _node ), 2000 );
	assert.equal( _node.state, 'closed' );
	assert.equal( _node.result.reason, 'never confirmed before the deadline' );
	assert.equal( _node.result.status, 'failed', '16.3 knows fulfilled, failed and aborted; a deadline fails the goal' );
	assert.equal( _node.confirmed, undefined );
} );

attack( RUN, 'an abort while the goal waits for its confirmation closes it as aborted', async () => {
	const _rig = rig( { gate: fakeGate( { confirm: false } ) } );
	const _node = await _rig.runner.start( new Contract( spec(), registry ) );
	const _running = _rig.runner.run( _node );
	await sleep( 20 );
	await _rig.runner.abort( _node, { reason: 'by the client' } );
	await within( _running, 2000 );
	assert.deepEqual( [ _node.state, _node.result.status ], [ 'closed', 'aborted' ] );
} );

attack( RUN, 'a confirmed goal is frozen: its hash and immutable criteria are kept from the confirmation (G-10)', async () => {
	const _rig = rig();
	const _node = await _rig.runner.start( new Contract( spec(), registry ) );
	await _rig.runner._propose( _node );
	assert.equal( _node.state, 'confirmed' );
	assert.equal( _node.confirmed, _node.contract.hash );
	assert.equal( _node.immutables.length, 2 );
} );

// --- deadlines (Z6, G-1c) ---

attack( RUN, 'Z6: a node past its deadline is aborted as failed before it does anything else', async () => {
	const _rig = rig();
	const _node = await placed( _rig, 'planning' );
	_node.contract.deadline = new Date( Date.now() - 1 ).toISOString();
	await _rig.runner._step( _node );
	assert.deepEqual( [ _node.state, _node.result.status, _node.result.reason ], [ 'closed', 'failed', 'the deadline is reached' ] );
	assert.equal( kinds( _rig.log, _node, 'deadline_reached' ).length, 1 );
	assert.deepEqual( kinds( _rig.log, _node, 'state_changed' ).map( item => item.to ).slice( -2 ), [ 'closing', 'closed' ] );
} );

attack( RUN, 'Z6: an overspent node is aborted as failed, naming what it spent', async () => {
	const _rig = rig();
	const _node = await placed( _rig, 'executing' );
	_node.spent = _node.contract.budget + 0.5;
	await _rig.runner._step( _node );
	assert.match( _node.result.reason, /the budget is exhausted \(30\.5 of 30\)/ );
	assert.deepEqual( [ _node.state, _node.result.status ], [ 'closed', 'failed' ] );
} );

attack( RUN, 'G-1c: the deadline timer aborts a waiting child by itself', async () => {
	const _rig = rig();
	const _aborted = [];
	_rig.runner.abort = async ( of, options ) => _aborted.push( options.status );
	const _node = node( { hours: 0.00001 } );
	_node.state = 'waiting';
	const _timers = _rig.runner._deadlines( _node );
	await sleep( 80 );
	_timers.forEach( timer => clearTimeout( timer ) );
	assert.deepEqual( _aborted, [ 'failed' ] );
} );

attack( RUN, 'a goal with an unreadable deadline is aborted at once: in doubt, the end has come', async () => {
	const _rig = rig();
	const _aborted = [];
	_rig.runner.abort = async ( of, options ) => _aborted.push( options.status );
	const _node = node();
	_node.contract.deadline = 'next week';
	const _timers = _rig.runner._deadlines( _node );
	await sleep( 20 );
	_timers.forEach( timer => clearTimeout( timer ) );
	assert.deepEqual( _aborted, [ 'failed' ] );
} );

attack( RUN, 'Z5: the deadline of a node that already closed does nothing', async () => {
	const _rig = rig();
	let _aborted = 0;
	_rig.runner.abort = async () => _aborted++;
	const _node = node( { hours: 0.00001 } );
	_node.state = 'closed';
	const _timers = _rig.runner._deadlines( _node );
	await sleep( 60 );
	_timers.forEach( timer => clearTimeout( timer ) );
	assert.equal( _aborted, 0 );
} );

attack( RUN, 'a goal due in 40 days is not aborted after 24.8 days, when a timer can count no further', async () => {
	mock.timers.enable( { apis: [ 'setTimeout', 'Date' ], now: Date.parse( '2026-11-04T10:00:00Z' ) } );
	try {
		const _rig = rig();
		const _aborted = [];
		_rig.runner.abort = async ( of, options ) => _aborted.push( options.reason );
		const _node = node( { hours: 24 * 40 } );
		_node.state = 'waiting';
		_rig.runner._deadlines( _node );
		mock.timers.tick( 2 ** 31 );
		assert.deepEqual( _aborted, [], `aborted on ${new Date( Date.now() ).toISOString()}, due ${_node.contract.deadline}` );
	} finally {
		mock.timers.reset();
	}
} );

// --- planning (16.1, 19, Z2, Z6, R1) ---

attack( RUN, '19, R1: an open attempt is carried on to execution and burns no new token', async () => {
	const _account = account();
	const _rig = rig( { account: _account, startTokens: 5 } );
	const _node = await placed( _rig, 'planning' );
	attempt( _rig, _node, [ { move: 'stress.human' }, { move: 'stress.code' } ] ).next = 1;
	await _rig.runner._plan( _node );
	assert.equal( _node.state, 'executing' );
	assert.equal( _account.left( _rig.runner.id ), 5 );
	assert.equal( kinds( _rig.log, _node, 'state_changed' ).at( -1 ).at, 'stress.code' );
} );

attack( RUN, 'P1: with nothing left of the budget and no strategy to pay, the goal fails; no person is asked', async () => {
	const _rig = rig();
	const _node = await placed( _rig, 'planning' );
	_node.spent = _node.contract.budget;
	await _rig.runner._plan( _node );
	assert.equal( _node.stopping.status, 'failed' );
	assert.match( _node.stopping.reason, /budget is exhausted/ );
} );

attack( RUN, '16.1: with no eligible strategy the node goes to judging, stuck (the verdict is "escalate")', async () => {
	const _mission = Mission.load( 'survey' );
	_mission.strategies = [];
	const _rig = rig( { mission: _mission } );
	const _node = await placed( _rig, 'planning' );
	await _rig.runner._plan( _node );
	assert.deepEqual( [ _node.state, _node.stuck ], [ 'judging', true ] );
} );

attack( RUN, 'R1: with a strategy chosen but no token left, nothing starts and the goal fails, never judged done', async () => {
	const _rig = rig( { account: account(), startTokens: 0 } );
	const _node = await placed( _rig, 'planning' );
	await _rig.runner._plan( _node );
	assert.equal( _node.state, 'closing' );
	assert.deepEqual( _node.result, { status: 'failed', reason: 'no start tokens left (R1)' } );
	assert.equal( _rig.journal.forNode( _node.id ).length, 0, 'no attempt was started' );
} );

attack( RUN, 'R1: a token that is gone at the burn ends the just-protocolled attempt as aborted', async () => {
	const _broken = { open: () => {}, left: () => 1, burn: () => null };
	const _rig = rig( { account: _broken } );
	const _node = await placed( _rig, 'planning' );
	await _rig.runner._plan( _node );
	const [ _attempt ] = _rig.journal.forNode( _node.id );
	assert.deepEqual( [ _attempt.outcome, _attempt.cause ], [ 'wall', 'aborted' ] );
	assert.equal( _node.plan.open, false );
	assert.equal( _node.state, 'closing' );
} );

attack( RUN, 'R1: a plan is accepted with exactly one token, burnt in the same step as its event', async () => {
	const _account = account();
	const _rig = rig( { account: _account, startTokens: 4 } );
	const _node = await placed( _rig, 'planning' );
	await _rig.runner._plan( _node );
	assert.equal( _node.state, 'executing' );
	assert.equal( _account.left( _rig.runner.id ), 3 );
	assert.equal( kinds( _rig.log, _node, 'plan_accepted' ).length, 1 );
} );

attack( RUN, 'Z2: a planner that never answers is cut off at the deadline of "planning"; the defaults are used', async () => {
	const _rig = rig( { planner: { fill: never }, stateMinutes: { planning: 0.001, judging: 0.001 } } );
	const _node = await placed( _rig, 'planning' );
	await within( _rig.runner._plan( _node ), 2000 );
	assert.equal( _node.state, 'executing' );
	assert.ok( _node.facts.some( fact => fact.kind === 'timeout' && fact.data.state === 'planning' ) );
} );

attack( RUN, 'a planner that fails is no reason to stop: the defaults are used, without a timeout fact', async () => {
	const _rig = rig( { planner: { fill: async () => {
		throw new Error( 'model down' );
	} } } );
	const _node = await placed( _rig, 'planning' );
	await _rig.runner._plan( _node );
	assert.equal( _node.state, 'executing' );
	assert.ok( !_node.facts.some( fact => fact.kind === 'timeout' ) );
} );

attack( RUN, 'Z6: a deadline that passes while the model plans holds the node before its token burns', async () => {
	const _account = account();
	const _rig = rig( { account: _account, startTokens: 2, planner: { fill: () => sleep( 60 ).then( () => ( {} ) ) } } );
	const _node = await placed( _rig, 'planning', { hours: 0.00001 } );
	await _rig.runner._plan( _node );
	assert.equal( _account.left( _rig.runner.id ), 2 );
	assert.deepEqual( kinds( _rig.log, _node, 'plan_accepted' ), [] );
} );

attack( RUN, '19: a plan G2 refuses keeps the node in planning; the strategy is no longer eligible for it', async () => {
	const _mission = Mission.load( 'survey' );
	_mission.strategies = [ {
		id: 'read-raw', serves: 'report_delivered', price: 1, startCurve: { p0: 0.9, tauH: 1 }, class: 'direct',
		steps: [ { move: 'survey.rows', params: { teams: [ 'design' ] }, as: 'rows' }, { move: 'report.draft', from: [ 'rows' ], as: 'report' },
			{ move: 'report.send', from: 'report', target: 'hr' } ],
	} ];
	const _rig = rig( { mission: _mission } );
	const _node = await placed( _rig, 'planning' );
	await _rig.runner._plan( _node );
	assert.equal( _node.state, 'planning' );
	assert.ok( _node.refused.has( 'read-raw' ) );
	assert.equal( _node.walls[ 0 ].cause, 'plan_refused' );
} );

// --- Z2: the model's part of a state ---

attack( RUN, 'Z2: what the model brings in time is taken; nothing is written about it', async () => {
	const { runner } = rig();
	const _node = node();
	assert.equal( await runner.within( _node, 'planning', Promise.resolve( 'slots' ), 'defaults' ), 'slots' );
	assert.equal( _node.facts.length, 0 );
} );

attack( RUN, 'Z2: what comes too late is replaced by the code\'s own reading, with a timeout fact and an event', async () => {
	const { runner, log } = rig();
	const _node = node( { log } );
	assert.equal( await runner.within( _node, 'judging', never(), 'fallback', 10 ), 'fallback' );
	assert.deepEqual( _node.facts.map( fact => [ fact.kind, fact.data.state ] ), [ [ 'timeout', 'judging' ] ] );
	assert.deepEqual( kinds( log, _node, 'deadline_reached' ), [ { of: 'judging' } ] );
} );

attack( RUN, 'Z2: a model that fails is replaced by the code\'s reading at once, without a timeout fact', async () => {
	const { runner } = rig();
	const _node = node();
	assert.equal( await runner.within( _node, 'planning', Promise.reject( new Error( 'down' ) ), 'fallback' ), 'fallback' );
	assert.equal( _node.facts.length, 0 );
} );

attack( RUN, 'Z2: a state deadline of zero minutes gives the model no time at all, not three minutes', async () => {
	const { runner } = rig( { stateMinutes: { planning: 0, judging: 0 } } );
	assert.equal( await within( runner.within( node(), 'planning', never(), 'at once' ), 1000 ), 'at once' );
} );

// --- facts from outside (E3, E4, Z5) ---

attack( RUN, 'E4: a fact for a waiting node is queued and wakes it for a judgment', async () => {
	const _rig = rig();
	const _node = await placed( _rig, 'waiting' );
	const _woken = _node.nextEvent();
	assert.equal( _rig.runner.deliver( _node, { ...RECEIPT, late: true } ), true );
	assert.equal( ( await within( _woken, 500 ) ).kind, 'delivered' );
	assert.equal( _node.inbox.length, 1 );
} );

attack( RUN, 'E4: a fact for a node that plans, executes or judges waits in its queue; no transition', async () => {
	const _rig = rig();
	for ( const state of [ 'planning', 'executing', 'judging' ] ) {
		const _node = await placed( _rig, state );
		const _version = _node.version;
		assert.equal( _rig.runner.deliver( _node, { ...RECEIPT } ), true );
		assert.deepEqual( [ _node.state, _node.version, _node.facts.length ], [ state, _version, 0 ] );
	}
} );

attack( RUN, 'E4: a fact for a closing node is only recorded, never applied', async () => {
	const _rig = rig();
	const _node = await placed( _rig, 'closing' );
	assert.equal( _rig.runner.deliver( _node, { ...RECEIPT } ), false );
	assert.equal( _node.inbox, undefined );
	assert.equal( kinds( _rig.log, _node, 'fact_recorded_only' ).length, 1 );
} );

attack( RUN, 'Z5: a fact for a closed node changes nothing; it is a new case', async () => {
	const _rig = rig();
	const _node = await placed( _rig, 'closing' );
	_node.move( 'closed' );
	assert.equal( _rig.runner.deliver( _node, { ...RECEIPT } ), false );
	assert.deepEqual( [ _node.facts.length, kinds( _rig.log, _node, 'fact_after_close' ).length ], [ 0, 1 ] );
} );

attack( RUN, 'E3, L4: the queue is taken over at once, and credit goes to the attempt only within the criterion\'s deadline', async () => {
	const _rig = rig();
	const _node = await placed( _rig, 'judging' );
	const _plan = attempt( _rig, _node, [ { move: 'stress.code' } ] );
	_node.inbox = [ { ...RECEIPT } ];
	assert.equal( _rig.runner.drain( _node ), 1 );
	assert.deepEqual( JSON.parse( _rig.journal.get( _plan.attempt ).contribution ), [ 'k1' ] );
	_node.credited.k1.booked = false;
	_node.credited.k1.inTime = false;
	_rig.runner.book( _node );
	assert.equal( _node.credited.k1.booked, false, 'credit after the deadline is not booked' );
} );

attack( RUN, 'B5: what only time shows is observed once, never twice', async () => {
	const _rig = rig();
	const _node = await placed( _rig, 'judging' );
	_node.contract.criteria.push( { observe: () => ( { kind: 'no_contradiction', data: { commitment: 'f-1' } } ) } );
	_rig.runner.watch( _node );
	_rig.runner.watch( _node );
	assert.equal( _node.facts.filter( fact => fact.kind === 'no_contradiction' ).length, 1 );
	assert.equal( _node.facts[ 0 ].origin, 'system' );
} );

// --- the child's goal (R3, R6) ---

attack( RUN, 'R3: a child is due before its parent minus at least ten minutes, or twice the buffer', () => {
	const _parent = node();
	const _spec = Runner.childSpec( _parent, { id: 'x', goal: 'g', criteria: [], serves: {} }, 30 );
	assert.equal( Date.parse( _parent.contract.deadline ) - Date.parse( _spec.deadline ), 60 * 60000 );
	const _small = Runner.childSpec( _parent, { id: 'x', goal: 'g', criteria: [], serves: {} }, 0 );
	assert.equal( Date.parse( _parent.contract.deadline ) - Date.parse( _small.deadline ), 10 * 60000 );
} );

attack( RUN, 'a child inherits every invariant of its parent by construction, and half of what is left as budget', () => {
	const _parent = node();
	_parent.spent = 10;
	const _spec = Runner.childSpec( _parent, { id: 'x', goal: 'g', criteria: [ { id: 'c1', type: 'report_delivered', values: {} } ], serves: {} } );
	assert.deepEqual( _spec.criteria.map( item => item.type ), [ 'report_delivered', 'min_group', 'no_difference' ] );
	assert.equal( _spec.budget, 10 );
	assert.equal( _spec.id, `${_parent.contract.id}/x` );
	assert.equal( _spec.parent, _parent.contract.hash );
} );

attack( RUN, 'a child of a parent with nothing left still asks for one unit, which its parent then cannot reserve (P4)', () => {
	const _parent = node();
	_parent.spent = _parent.contract.budget;
	assert.equal( Runner.childSpec( _parent, { id: 'x', goal: 'g', criteria: [], serves: {} } ).budget, 1 );
} );

// --- an error in the core (18.6, Z3) ---

attack( RUN, '18.6: an error in a step aborts the node with what runs below it, alarms a person, and closes it along 16.1', async () => {
	const _asked = [];
	const _rig = rig( { board: { ask: async ( of, spec_ ) => _asked.push( spec_ ), withdraw: () => [], list: () => [] } } );
	const _node = await placed( _rig, 'confirmed' );
	_rig.runner._plan = async () => {
		throw new Error( 'a broken planner' );
	};
	await within( _rig.runner.run( _node, { resume: true } ), 2000 );
	assert.deepEqual( [ _node.state, _node.result.status, _node.result.reason ], [ 'closed', 'failed', 'a broken planner' ] );
	assert.equal( _asked.filter( item => item.reason === 'alarm' ).length, 1 );
	const _states = kinds( _rig.log, _node, 'state_changed' ).map( item => item.to );
	assert.deepEqual( _states.slice( -2 ), [ 'closing', 'closed' ] );
} );

attack( RUN, 'an error after a node closed changes nothing (Z5)', async () => {
	const _rig = rig();
	const _node = await placed( _rig, 'closing' );
	_node.move( 'closed' );
	await _rig.runner._failed( _node, new Error( 'late' ) );
	assert.deepEqual( [ _node.state, _node.result ], [ 'closed', null ] );
} );

attack( RUN, 'a resumed node that was already confirmed is not proposed again', async () => {
	const _rig = rig();
	const _node = await placed( _rig, 'confirmed' );
	_node.stopping = { reason: 'test end', status: 'aborted' };
	await within( _rig.runner.run( _node, { resume: true } ), 2000 );
	assert.equal( _rig.gate.calls.filter( call => call[ 0 ] === 'propose' ).length, 0 );
	assert.equal( _node.state, 'closed' );
} );

// --- t_signal and horizon (19, L2) ---

attack( RUN, '19: the review interval comes from the strategy, else from its slowest move; none means no review', () => {
	const { runner } = rig( { moves: { 'x.slow': { executor: 'wait', tSignalH: 30, horizonH: 200 } } } );
	assert.equal( runner.signalHours( { tSignalH: null, steps: [ { move: 'x.slow' } ] } ), null );
	assert.equal( runner.signalHours( { steps: [ { move: 'x.slow' }, { move: 'stress.code' } ] } ), 30 );
	assert.equal( runner.signalHours( { steps: [ { move: 'unknown' } ] } ), null );
	assert.equal( runner.horizon( { steps: [ { move: 'x.slow' } ] } ), 200 );
} );
