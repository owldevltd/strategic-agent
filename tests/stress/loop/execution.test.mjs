// Stress tests of the execution of a checked plan (chapter 4 "act", 16.1, Z6, G3): move by move, each booked in the
// pot; what a move brought becomes facts through G3, walls, or a gate decision. Attacks: moves that throw, return
// nothing or claim invented causes, budgets at zero, deadlines and aborts between moves, hostile facts and decisions.
import assert from 'node:assert/strict';
import { attack, within } from '../hostile.mjs';
import { Pot, Board, rig, placed, attempt, kinds, memoryLog, RECEIPT } from './kit.mjs';

const EXE = 'core/loop/execution.js';
const OUT = { value: { n: 1 }, labels: [ 'own' ], cohort: null, facts: [] };

// A node of a bare runner in "executing" with an open attempt of these steps; run decides what each move returns.
async function executing( steps, { run = async () => OUT, over = {}, hours = 48, ...options } = {} ) {
	const _rig = rig( { executor: { run, ...( options.executor || {} ) }, ...options } );
	const _node = await placed( _rig, 'executing', { over, hours } );
	attempt( _rig, _node, steps );
	return { ..._rig, node: _node, execution: _rig.runner.execution };
}

const moved = ( log, node ) => kinds( log, node, 'move_started' ).map( item => item.move );

attack( EXE, 'a plan that ran through but left its criterion open is a wall "not_reached", never done', async () => {
	const { execution, node, log } = await executing( [ { move: 'stress.code' }, { move: 'stress.code' } ] );
	await execution.run( node );
	assert.equal( node.state, 'judging' );
	assert.deepEqual( node.walls.map( wall => wall.cause ), [ 'not_reached' ] );
	assert.deepEqual( node.tried, [ { strategy: 'stress', wall: undefined, outcome: 'wall', cause: 'not_reached' } ] );
	assert.deepEqual( moved( log, node ), [ 'stress.code', 'stress.code' ] );
} );

attack( EXE, 'an attempt that ran through to "not_reached" is logged as a wall in its transition to judging, as in the journal (Z4)', async () => {
	const { execution, node, log } = await executing( [ { move: 'stress.code' } ] );
	const _returned = await execution.run( node );
	const _transition = kinds( log, node, 'state_changed' ).at( -1 );
	assert.deepEqual( [ _returned, _transition.outcome, _transition.cause ], [ 'wall', 'wall', 'not_reached' ] );
} );

attack( EXE, 'a plan whose move brought the gate\'s receipt ends done', async () => {
	const _run = async () => ( { ...OUT, facts: [ RECEIPT ] } );
	const { execution, node } = await executing( [ { move: 'stress.code' } ], { run: _run } );
	assert.equal( await execution.run( node ), 'done' );
	assert.equal( node.openOutcomes().length, 0 );
} );

attack( EXE, 'an aborted node starts no further move; the attempt ends as aborted (G-1a)', async () => {
	const { execution, node, log } = await executing( [ { move: 'stress.code' } ] );
	node.stopping = { reason: 'by the client', status: 'aborted' };
	assert.equal( await execution.run( node ), 'wall' );
	assert.deepEqual( moved( log, node ), [] );
	assert.equal( node.tried[ 0 ].cause, 'aborted' );
} );

attack( EXE, 'no move starts after the node\'s deadline (Z6); the runner\'s next step aborts the node', async () => {
	const { execution, node, log } = await executing( [ { move: 'stress.code' } ] );
	node.contract.deadline = new Date( Date.now() - 1 ).toISOString();
	assert.equal( await execution.run( node ), null );
	assert.deepEqual( moved( log, node ), [] );
} );

attack( EXE, 'no move starts on an overspent budget (Z6)', async () => {
	const { execution, node, log } = await executing( [ { move: 'stress.code' } ] );
	node.spent = node.contract.budget + 0.001;
	assert.equal( await execution.run( node ), null );
	assert.deepEqual( moved( log, node ), [] );
} );

attack( EXE, 'no move with a price starts when exactly nothing is left of the budget (Z6)', async () => {
	const { execution, node, log } = await executing( [ { move: 'stress.code' } ] );
	node.spent = node.contract.budget;
	await execution.run( node );
	assert.deepEqual( moved( log, node ), [], 'the move would overspend the pot by its price' );
	assert.ok( node.spent <= node.contract.budget );
} );

attack( EXE, 'a move that throws is a wall "move_failed" like any other, never a crash of the loop', async () => {
	const { execution, node } = await executing( [ { move: 'stress.code' }, { move: 'stress.code' } ], { run: async () => {
		throw new Error( 'boom' );
	} } );
	assert.equal( await execution.run( node ), 'wall' );
	assert.deepEqual( node.walls[ 0 ].detail, [ { move: 'stress.code', error: 'boom' } ] );
	assert.equal( node.state, 'judging' );
} );

attack( EXE, 'the error of a failed move is cut to 300 characters in its wall', async () => {
	const { execution, node } = await executing( [ { move: 'stress.code' } ], { run: async () => {
		throw new Error( 'x'.repeat( 100000 ) );
	} } );
	await execution.run( node );
	assert.equal( node.walls[ 0 ].detail[ 0 ].error.length, 300 );
} );

attack( EXE, 'a move that returns nothing is a wall "move_failed", not an error of the core', async () => {
	const { execution, node } = await executing( [ { move: 'stress.code' } ], { run: async () => null } );
	await within( execution.run( node ).catch( error => error ), 1000 );
	assert.equal( node.walls.at( -1 )?.cause, 'move_failed' );
	assert.equal( node.state, 'judging' );
} );

attack( EXE, 'a cause code trusted code invents is kept as its code; the attempt ends at it', async () => {
	const _run = async () => ( { ...OUT, wall: { cause: 'the_moon_is_full', reason: 'invented' } } );
	const { execution, node } = await executing( [ { move: 'stress.code' }, { move: 'stress.code' } ], { run: _run } );
	assert.equal( await execution.run( node ), 'wall' );
	assert.deepEqual( node.walls.map( wall => wall.cause ), [ 'the_moon_is_full' ] );
	assert.equal( node.plan.next, 1, 'the second move never started' );
} );

attack( EXE, 'a precondition reported by trusted code travels with its wall (U2)', async () => {
	const _pre = { id: 'roster', type: 'report_delivered', values: { to: 'hr', topic: 'roster' } };
	const _run = async () => ( { ...OUT, wall: { cause: 'precondition_missing', precondition: _pre, reason: 'no roster' } } );
	const { execution, node } = await executing( [ { move: 'stress.code' } ], { run: _run } );
	await execution.run( node );
	assert.deepEqual( node.walls[ 0 ].precondition, _pre );
	assert.equal( node.walls[ 0 ].reason, 'no roster' );
} );

attack( EXE, 'a move whose lease ran out writes nothing: its unused tokens are revoked and it is a wall (A3, A4)', async () => {
	const _deliveries = { 'dl-1': { status: 'awaiting_approval' } };
	const _ctx = await executing( [ { move: 'stress.code', as: 'late' } ], { run: async () => ( { ...OUT, leaseExpired: true } ) } );
	Object.assign( _ctx.gate.deliveries, _deliveries );
	_ctx.node.deliveries = [ 'dl-1' ];
	await _ctx.execution.run( _ctx.node );
	assert.equal( _ctx.node.walls[ 0 ].cause, 'lease_expired' );
	assert.equal( _ctx.node.plan.values.late, undefined, 'the value of the expired move is never written' );
	assert.deepEqual( _ctx.gate.calls.filter( call => call[ 0 ] === 'withdraw' ), [ [ 'withdraw', 'dl-1' ] ] );
} );

attack( EXE, 'an executed action leaves the gate\'s receipt as a fact, with plain parameters only, never free text', async () => {
	const _decision = { status: 'executed', delivery: 'dl-9', receipt: { id: 'rc-9' } };
	const _run = async () => ( { decision: _decision, action: 'report', target: 'hr', params: { body: 'Anna is unhappy', n: 12, ref: 'FU-1A2B' } } );
	const { execution, node } = await executing( [ { move: 'report.send' } ], { run: _run } );
	assert.equal( await execution.run( node ), 'done' );
	const _receipt = node.facts.find( fact => fact.kind === 'delivered' );
	assert.deepEqual( _receipt.data.params, { n: 12, ref: 'FU-1A2B' } );
	assert.equal( _receipt.evidenceClass, 'observation' );
	assert.deepEqual( node.outputs, [ { action: 'report', to: 'hr', text: 'Anna is unhappy' } ] );
} );

attack( EXE, 'an executed payment settles its invoice by the gate\'s receipt', async () => {
	const _decision = { status: 'executed', delivery: 'dl-2', receipt: { id: 'rc' } };
	const _run = async () => ( { decision: _decision, action: 'payment', target: 'bank', params: { invoiceId: 'R-1185', amount: 10 } } );
	const _moves = { 'stress.pay': { executor: 'code', action: 'payment', price: 0.1, resolves: { item: 'invoiceId', outcome: 'paid' } } };
	const { execution, node } = await executing( [ { move: 'stress.pay' } ], { run: _run, moves: _moves } );
	await execution.run( node );
	const _item = node.facts.find( fact => fact.kind === 'item_resolved' );
	assert.deepEqual( [ _item.data.item, _item.data.outcome, _item.origin ], [ 'R-1185', 'paid', 'gate' ] );
} );

attack( EXE, 'a refusal by the gate is a fact and a wall with the cause of its rule (A2 of the catalog: data, not code)', async () => {
	const _decision = { status: 'refused', delivery: 'dl-3', reasons: [ { rule: 'min_group', reason: 'group of 2 < 5' } ] };
	const _run = async () => ( { decision: _decision, action: 'report', target: 'hr', params: {} } );
	const { execution, node } = await executing( [ { move: 'report.send' } ], { run: _run } );
	await execution.run( node );
	assert.equal( node.walls[ 0 ].cause, 'group_too_small' );
	assert.ok( node.facts.some( fact => fact.kind === 'refused' && fact.origin === 'gate' ) );
} );

attack( EXE, 'a refusal by a rule the catalog does not know keeps the rule\'s name as its cause', async () => {
	const _decision = { status: 'refused', delivery: 'dl-3', reasons: [ { rule: 'brand_new_rule', reason: '?' } ] };
	const { execution, node } = await executing( [ { move: 'report.send' } ], { run: async () => ( { decision: _decision, params: {} } ) } );
	await execution.run( node );
	assert.equal( node.walls[ 0 ].cause, 'brand_new_rule' );
} );

attack( EXE, 'a refusal that arrives while the node is aborted is a wall "aborted", not one of the strategy', async () => {
	const _decision = { status: 'refused', delivery: 'dl-3', reasons: [ { rule: 'min_group' } ] };
	const _ctx = await executing( [ { move: 'report.send' } ], { run: async () => {
		_ctx.node.stopping = { reason: 'abort', status: 'aborted' };
		return { decision: _decision, params: {} };
	} } );
	await _ctx.execution.run( _ctx.node );
	assert.equal( _ctx.node.walls[ 0 ].cause, 'aborted' );
} );

attack( EXE, 'an action whose outcome is unclear goes to a person as a case of its own (O5)', async () => {
	const _board = new Board( memoryLog(), { sweepMs: 60000 } );
	const _decision = { status: 'unclear', delivery: 'dl-4', reasons: [] };
	const { execution, node } = await executing( [ { move: 'report.send' } ], { run: async () => ( { decision: _decision, params: {} } ), board: _board } );
	await execution.run( node );
	assert.deepEqual( node.unclear, [ 'dl-4' ] );
	assert.equal( _board.list().filter( ticket => ticket.kind === 'check' ).length, 1 );
} );

attack( EXE, 'facts from a move pass G3 bound to this node\'s contract, with their numbers and ids intact', async () => {
	const _fact = { kind: 'measured', evidenceClass: 'observation', source: 'sandbox', origin: 'system', data: { n: 3, about: 'answers:design' } };
	const { execution, node, log } = await executing( [ { move: 'stress.code' } ], { run: async () => ( { ...OUT, facts: [ _fact ] } ) } );
	await execution.run( node );
	const _measured = node.facts.find( fact => fact.kind === 'measured' );
	assert.deepEqual( _measured.data, { n: 3, about: 'answers:design' } );
	assert.equal( _measured.contract, node.contract.hash, 'bound to this node\'s contract' );
	assert.equal( _measured.attempt, node.plan.attempt, 'credited to the attempt it came from (L4)' );
	assert.deepEqual( kinds( log, node, 'fact_rejected' ), [] );
} );

attack( EXE, 'a fact without an evidence class is rejected at G3 and never counts', async () => {
	const _fact = { kind: 'delivered', source: 'sandbox', data: { action: 'report', to: 'hr' } };
	const { execution, node, log } = await executing( [ { move: 'stress.code' } ], { run: async () => ( { ...OUT, facts: [ _fact ] } ) } );
	await execution.run( node );
	assert.equal( node.facts.filter( fact => fact.kind === 'delivered' ).length, 0 );
	assert.equal( kinds( log, node, 'fact_rejected' ).length, 1 );
} );

attack( EXE, 'a fact claiming another contract is rebound to this node\'s contract, never accepted for the other', async () => {
	const _fact = { ...RECEIPT, contract: 'someone-elses-hash' };
	const { execution, node } = await executing( [ { move: 'stress.code' } ], { run: async () => ( { ...OUT, facts: [ _fact ] } ) } );
	await execution.run( node );
	assert.ok( node.facts.every( fact => !fact.contract || fact.contract === node.contract.hash ) );
} );

attack( EXE, 'a child\'s facts arrive under the child\'s name and without their ids, so they cannot replace a fact of the parent (E2)', async () => {
	const { execution, node } = await executing( [ { move: 'stress.code' } ] );
	const _mine = node.addFact( { kind: 'item_resolved', evidenceClass: 'observation', source: 'gate', origin: 'gate', data: { item: 'R-1' } } );
	execution.runner.executor.run = async () => ( {
		child: { id: 'c1', status: 'fulfilled' }, facts: [ { ..._mine, id: _mine.id, data: { item: 'R-2' } } ],
	} );
	await execution.run( node );
	const _resolved = node.facts.filter( fact => fact.kind === 'item_resolved' );
	assert.equal( _resolved.length, 2 );
	assert.equal( _resolved[ 1 ].source, 'child c1' );
	assert.notEqual( _resolved[ 1 ].id, _mine.id );
} );

attack( EXE, 'a child that did not fulfil its goal is a wall "child_failed" of the parent', async () => {
	const _run = async () => ( { child: { id: 'c1', status: 'failed', item: 'R-1', gates: [] }, facts: [] } );
	const { execution, node } = await executing( [ { move: 'stress.child' } ], { run: _run } );
	await execution.run( node );
	assert.ok( node.walls.some( wall => wall.cause === 'child_failed' ) );
} );

attack( EXE, 'a child not started because its item was settled already is no wall "child_failed"', async () => {
	const _run = async () => ( { child: { id: null, status: 'settled', item: 'R-1', gates: [] }, facts: [] } );
	const { execution, node } = await executing( [ { move: 'stress.child' } ], { run: _run } );
	await execution.run( node );
	assert.ok( !node.walls.some( wall => wall.cause === 'child_failed' ) );
} );

attack( EXE, 'a child status that only looks like "settled" is a wall', async () => {
	const _run = async () => ( { child: { id: 'c1', status: 'Settled', item: 'R-1', gates: [] }, facts: [] } );
	const { execution, node } = await executing( [ { move: 'stress.child' } ], { run: _run } );
	await execution.run( node );
	assert.ok( node.walls.some( wall => wall.cause === 'child_failed' ) );
} );

attack( EXE, 'a named value of a move is kept for the next one, with its labels', async () => {
	const _run = async step => ( step.as ? { value: { text: 'draft' }, labels: [ 'confidential' ], cohort: [ 'r1' ] } : OUT );
	const { execution, node, log } = await executing( [ { move: 'stress.code', as: 'draft' }, { move: 'stress.code' } ], { run: _run } );
	await execution.run( node );
	assert.deepEqual( node.plan.values.draft.value, { text: 'draft' } );
	assert.deepEqual( kinds( log, node, 'value' )[ 0 ], { name: 'draft', labels: [ 'confidential' ], groupSize: 1 } );
} );

attack( EXE, 'each move is booked on its own, with its duration (P5)', async () => {
	const { execution, node, log } = await executing( [ { move: 'stress.code' }, { move: 'stress.ai' } ] );
	await execution.run( node );
	const _booked = kinds( log, node, 'cost_booked' );
	assert.deepEqual( _booked.slice( 0, 2 ).map( item => [ item.what, item.units ] ), [ [ 'stress.code', 0.05 ], [ 'stress.ai', 0.3 ] ] );
	assert.ok( _booked.every( item => typeof item.ms === 'number' && item.ms >= 0 ) );
} );

attack( EXE, 'a round that cost less than a unit is booked up to one when the attempt ends (P3)', async () => {
	const { execution, node } = await executing( [ { move: 'stress.code' } ] );
	await execution.run( node );
	assert.equal( node.spent, 1 );
} );

attack( EXE, 'the attempt is ended in the journal with its outcome, cause and cost (L2, L3)', async () => {
	const { execution, node, journal } = await executing( [ { move: 'stress.code' } ] );
	await execution.run( node );
	const _row = journal.get( node.plan.attempt );
	assert.deepEqual( [ _row.outcome, _row.cause, _row.cost ], [ 'wall', 'not_reached', 1 ] );
	assert.ok( _row.endedAt );
} );

attack( EXE, 'no reaction in time ends the attempt provisionally as a timeout, not as a final failure (B8)', async () => {
	const _run = async () => ( { ...OUT, wall: { cause: 'no_reaction', reason: '0 of 3' } } );
	const { execution, node, journal } = await executing( [ { move: 'stress.code' } ], { run: _run } );
	await execution.run( node );
	assert.equal( journal.get( node.plan.attempt ).outcome, 'timeout' );
	assert.equal( journal.open( node.id ).length, 1, 'the provisional attempt stays open for the choice (19)' );
} );

attack( EXE, 'closing an attempt twice books it once', async () => {
	const { execution, node, log } = await executing( [ { move: 'stress.code' } ] );
	await execution.run( node );
	const _spent = node.spent;
	execution.close( node, 'wall', 'aborted' );
	assert.equal( node.spent, _spent );
	assert.equal( node.tried.length, 1 );
	assert.equal( kinds( log, node, 'cost_booked' ).filter( item => item.what === 'round minimum' ).length, 1 );
} );

attack( EXE, 'a strategy gate blocks a move before it runs; the wall names the precondition and the gate (7.3, U2)', async () => {
	const _gates = {
		active: () => [],
		blocking: () => ( { gate: { id: 'sg-1a2b' }, precondition: { type: 'report_delivered', id: 'calendar' } } ),
	};
	const { execution, node, log } = await executing( [ { move: 'stress.code' } ], { gates: _gates } );
	await execution.run( node );
	assert.deepEqual( moved( log, node ), [] );
	assert.equal( node.walls[ 0 ].cause, 'precondition_missing' );
	assert.match( node.walls[ 0 ].reason, /gate sg-1a2b/ );
} );

attack( EXE, 'two thousand facts from one move are all checked and none is lost', async () => {
	const _facts = Array.from( { length: 2000 }, ( _item, i ) => ( { kind: 'measured', evidenceClass: 'observation', source: 's', origin: 'system', data: { i } } ) );
	const { execution, node } = await executing( [ { move: 'stress.code' } ], { run: async () => ( { ...OUT, facts: _facts } ) } );
	await within( execution.run( node ), 5000 );
	assert.equal( node.facts.filter( fact => fact.kind === 'measured' ).length, 2000 );
} );

attack( EXE, 'every action the node started is remembered once, with the attempt that started it (O9, L4)', async () => {
	const _decision = { status: 'executed', delivery: 'dl-5', receipt: {} };
	const _run = async () => ( { decision: _decision, action: 'report', target: 'hr', params: {} } );
	const { execution, node, log } = await executing( [ { move: 'report.send' } ], { run: _run } );
	await execution.run( node );
	execution._remember( node, { decision: _decision, action: 'report' } );
	assert.deepEqual( node.deliveries, [ 'dl-5' ] );
	assert.equal( node.deliveryAttempt[ 'dl-5' ], node.plan.attempt );
	assert.equal( kinds( log, node, 'delivery_started' ).length, 1 );
} );

attack( EXE, 'contacting the same other side again ends the observation of the earlier attempt there (L2)', async () => {
	const _decision = { status: 'executed', delivery: 'dl-6', receipt: {} };
	const _run = async () => ( { decision: _decision, action: 'report', target: 'hr', params: {} } );
	const _ctx = await executing( [ { move: 'report.send' } ], { run: _run } );
	const _earlier = _ctx.journal.start( _ctx.node, { id: 'earlier' } );
	_ctx.journal.contact( _ctx.node, 'hr', { by: _earlier, trigger: 'start' } );
	await _ctx.execution.run( _ctx.node );
	assert.equal( JSON.parse( _ctx.journal.get( _earlier ).observationEnd ).reason, 'contact' );
} );

attack( EXE, 'an expectation is activated only when its action was executed, and dropped when it was refused', async () => {
	const _seen = [];
	const _expectations = { activate: id => _seen.push( [ 'activate', id ] ), drop: id => _seen.push( [ 'drop', id ] ) };
	const _decisions = [ { status: 'executed', delivery: 'a', receipt: {} }, { status: 'refused', delivery: 'b', reasons: [ { rule: 'min_group' } ] } ];
	const _run = async () => ( { decision: _decisions.shift(), action: 'invite', target: 'design', params: {}, expectation: `ex-${_decisions.length}` } );
	const { execution, node } = await executing( [ { move: 'followup.invite' }, { move: 'followup.invite' } ], { run: _run, expectations: _expectations } );
	await execution.run( node );
	assert.deepEqual( _seen, [ [ 'activate', 'ex-1' ], [ 'drop', 'ex-0' ] ] );
} );

attack( EXE, 'E1: a judgment is only entered if nobody moved the node since it began to wait', async () => {
	const { execution, node, log } = await executing( [ { move: 'stress.code' } ] );
	node.move( 'waiting', { for: 'test' } );
	const _version = node.version;
	node.version += 1;
	execution._judgeNow( node, { event: 'late' }, _version );
	assert.equal( node.state, 'waiting' );
	assert.equal( kinds( log, node, 'transition_skipped' ).length, 1 );
} );

attack( EXE, 'a judgment is never entered for an aborted node', async () => {
	const { execution, node } = await executing( [ { move: 'stress.code' } ] );
	node.move( 'waiting', { for: 'test' } );
	node.stopping = { reason: 'x', status: 'aborted' };
	execution._judgeNow( node, { event: 'late' } );
	assert.equal( node.state, 'waiting' );
} );

attack( EXE, 'the price of a move is booked from the catalog, whatever the move claims it cost', async () => {
	const _run = async () => ( { ...OUT, cost: -1000, price: 0 } );
	const { execution, node } = await executing( [ { move: 'stress.ai' } ], { run: _run } );
	const _before = Pot.left( node );
	await execution.run( node );
	assert.ok( Pot.left( node ) <= _before - 0.3 );
} );
