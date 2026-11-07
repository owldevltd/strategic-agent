// core/loop/restore.js under attack, part 1: rebuilding nodes from the event log (18.1, Z4). Logs written by real nodes,
// then corrupted, reordered, truncated, tampered with, or filled with events nobody knows.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { registry, contract, about, measured, bring, Node, Restore, Journal, Db, EventLog, STATES } from './kit.mjs';

const S = 'core/loop/restore.js';

// A log written by real nodes of one run; rebuilt() plays a restarted core on it.
function story( run = 'r1' ) {
	const db = new Db( ':memory:' );
	const log = new EventLog( db, 'core' );
	const journal = new Journal( db );
	log.append( 'run_started', { run, mission: 'survey', vault: `/tmp/vault-${run}` } );
	const create = ( { parent = null, owner = null, item = contract(), runId = run } = {} ) => {
		const _node = new Node( { contract: item, parent, log } );
		parent?.children.push( _node );
		owner?.processes.push( _node );
		_node.emit( 'node_created', {
			contract: item.describe(), spec: item.canonical(), parent: parent?.id || null, depth: _node.depth, run: runId, mission: 'survey',
			owner: owner?.id || null,
		} );
		return _node;
	};
	const rebuilt = ( runId = run ) => {
		const _runner = { id: runId, registry, nodes: new Map(), log, journal };
		return { roots: new Restore( _runner ).rebuild(), nodes: _runner.nodes, runner: _runner };
	};
	const raw = ( kind, data, nodeId, nodeVersion = null ) => log.append( kind, data, { node: nodeId, nodeVersion } );
	return { db, log, journal, create, rebuilt, raw };
}

attack( S, '18: a run whose root has not closed is unfinished, with its mission and vault', () => {
	const _s = story();
	bring( _s.create(), 'planning' );
	assert.deepEqual( Restore.unfinished( _s.log ), [ { run: 'r1', mission: 'survey', vault: '/tmp/vault-r1' } ] );
} );

attack( S, '18: a run whose root closed is finished, whatever its children did', () => {
	const _s = story();
	const _root = _s.create();
	_s.create( { parent: _root } );
	bring( _root, 'closed' );
	assert.deepEqual( Restore.unfinished( _s.log ), [] );
} );

attack( S, '18: a run that started but never created its root has nothing to resume', () => {
	const _s = story();
	assert.deepEqual( Restore.unfinished( _s.log ), [] );
	assert.deepEqual( _s.rebuilt().roots, [] );
} );

attack( S, '18: of two runs in one log only the open one is unfinished, and each rebuild takes only its own nodes', () => {
	const _s = story( 'r1' );
	const _open = bring( _s.create(), 'executing' );
	_s.log.append( 'run_started', { run: 'r2', mission: 'survey', vault: '/tmp/vault-r2' } );
	bring( _s.create( { runId: 'r2' } ), 'closed' );
	assert.deepEqual( Restore.unfinished( _s.log ).map( item => item.run ), [ 'r1' ] );
	const { roots, nodes } = _s.rebuilt( 'r1' );
	assert.deepEqual( [ roots.map( item => item.id ), [ ...nodes.keys() ] ], [ [ _open.id ], [ _open.id ] ] );
} );

attack( S, 'Z5: a root that closed stays finished even when a later event claims it moved on', () => {
	const _s = story();
	const _root = bring( _s.create(), 'closed' );
	_s.raw( 'state_changed', { from: 'closed', to: 'executing' }, _root.id, 99 );
	assert.deepEqual( Restore.unfinished( _s.log ), [] );
} );

attack( S, '18.1: a contract in the log that does not match its hash is refused, naming the node', () => {
	const _s = story();
	const _root = _s.create();
	_s.db.run( 'UPDATE events SET data = REPLACE( data, \'"min":2\', \'"min":0\' ) WHERE kind = \'node_created\'' );
	assert.throws( () => _s.rebuilt(), new RegExp( `node ${_root.id}: the contract in the log does not match its hash` ) );
} );

attack( S, 'Z4: state, version, facts, walls, credit, costs, deliveries, verdict and abort all come back from the log', () => {
	const _s = story();
	const _root = bring( _s.create(), 'executing' );
	_root.plan = { open: true, attempt: 3 };
	_root.addFact( measured( 3 ) );
	_root.hitWall( 'no_reaction', [ 'quiet' ] );
	_root.emit( 'cost_booked', { spent: 2.5, left: 5.5 } );
	_root.emit( 'delivery_started', { delivery: 'dl-1', attempt: 3 } );
	_root.emit( 'verdict', { verdict: 'continue', rule: '19' } );
	_root.emit( 'abort_received', { reason: 'stop', status: 'aborted' } );
	const _back = _s.rebuilt().nodes.get( _root.id );
	assert.deepEqual( [ _back.state, _back.facts.length, _back.walls[ 0 ].cause, _back.spent, _back.reserved ], [ 'executing', 1, 'no_reaction', 2.5, 1 ] );
	assert.deepEqual( [ _back.deliveries, _back.deliveryAttempt, _back.lastVerdict.verdict ], [ [ 'dl-1' ], { 'dl-1': 3 }, 'continue' ] );
	assert.deepEqual( _back.credited.k1, { ..._root.credited.k1, booked: true } );
	assert.deepEqual( _back.stopping, { reason: 'stop', status: 'aborted' } );
} );

attack( S, 'Z4: the rebuilt node has exactly the version the node had (E1 goes on from there)', () => {
	const _s = story();
	const _root = bring( _s.create(), 'waiting' );
	assert.equal( _s.rebuilt().nodes.get( _root.id ).version, _root.version );
} );

attack( S, 'E5: a fact superseded before the crash is still superseded after it', () => {
	const _s = story();
	const _root = _s.create();
	_root.addFact( about( 'R-1', 'open', 'bank' ) );
	_root.addFact( about( 'R-1', 'paid', 'bank' ) );
	const _back = _s.rebuilt().nodes.get( _root.id );
	assert.deepEqual( _back.valid().map( fact => fact.data.value ), _root.valid().map( fact => fact.data.value ) );
} );

attack( S, 'E5: a conflict open before the crash is still open after it, so G6 still holds the criterion', () => {
	const _s = story();
	const _root = _s.create();
	_root.addFact( about( 'R-1', 'open', 'erp' ) );
	_root.addFact( about( 'R-1', 'paid', 'bank' ) );
	assert.equal( _s.rebuilt().nodes.get( _root.id ).conflicts().length, 1 );
} );

attack( S, '18.4: children come back under their parents and processes under the node that owns them, with their depth', () => {
	const _s = story();
	const _root = _s.create();
	const _child = _s.create( { parent: _root } );
	const _grand = _s.create( { parent: _child } );
	const _case = _s.create( { owner: _root } );
	const { roots, nodes } = _s.rebuilt();
	assert.deepEqual( roots.map( item => item.id ).sort(), [ _root.id, _case.id ].sort() );
	const _back = nodes.get( _root.id );
	assert.deepEqual( [ _back.children.map( item => item.id ), _back.processes.map( item => item.id ) ], [ [ _child.id ], [ _case.id ] ] );
	assert.deepEqual( [ nodes.get( _grand.id ).depth, nodes.get( _grand.id ).parent.id ], [ 2, _child.id ] );
} );

attacks( S, [ 'constructor', 'to_string', 'has_own_property', 'apply', 'attempts', 'interrupted', 'unfinished', 'outside', 'resume', 'rebuild', '' ]
	.map( kind => ( { name: `18.1: an event of the unknown kind "${kind}" is ignored on rebuild`, kind } ) ), ( { kind } ) => {
	const _s = story();
	const _root = bring( _s.create(), 'planning' );
	_s.raw( kind, { to: 'closed', spent: 99, delivery: 'dl-x' }, _root.id, 1 );
	const _back = _s.rebuilt().nodes.get( _root.id );
	assert.deepEqual( [ _back.state, _back.spent, _back.deliveries ], [ 'planning', 0, undefined ] );
} );

attack( S, 'Z3, Z5: a closed child is not brought back to life by a transition the table does not allow', () => {
	const _s = story();
	const _root = bring( _s.create(), 'executing' );
	const _child = bring( _s.create( { parent: _root } ), 'closed' );
	_s.raw( 'state_changed', { from: 'closed', to: 'executing' }, _child.id, 99 );
	assert.equal( _s.rebuilt().nodes.get( _child.id ).state, 'closed' );
} );

attack( S, 'Z1: a damaged transition without a target state leaves the node in a state of table 16.1', () => {
	const _s = story();
	const _root = bring( _s.create(), 'planning' );
	_s.raw( 'state_changed', { from: 'planning' }, _root.id, 3 );
	assert.ok( STATES.includes( _s.rebuilt().nodes.get( _root.id ).state ) );
} );

attack( S, 'a damaged fact event without data does not leave a hole among the facts', () => {
	const _s = story();
	const _root = _s.create();
	_s.raw( 'fact_delivered', null, _root.id );
	const _back = _s.rebuilt().nodes.get( _root.id );
	assert.ok( _back.facts.every( fact => fact && typeof fact === 'object' ) );
	assert.doesNotThrow( () => _back.valid() );
} );

attack( S, 'P3: a damaged cost event does not switch the budget check off', () => {
	const _s = story();
	const _root = _s.create();
	_s.raw( 'cost_booked', { what: 'x' }, _root.id );
	const _back = _s.rebuilt().nodes.get( _root.id );
	assert.ok( Number.isFinite( _back.spent ) && Number.isFinite( _back.reserved ), `spent ${_back.spent}, reserved ${_back.reserved}` );
} );

attack( S, 'a child whose creation is logged before its parent\'s is still attached to that parent', () => {
	const _s = story();
	const _root = _s.create();
	const _child = _s.create( { parent: _root } );
	const [ _first, _second ] = _s.db.all( 'SELECT id FROM events WHERE kind = \'node_created\' ORDER BY id' ).map( row => row.id );
	_s.db.run( 'UPDATE events SET id = 100000 WHERE id = :id', { id: _first } );
	_s.db.run( 'UPDATE events SET id = :to WHERE id = :id', { id: _second, to: _first } );
	_s.db.run( 'UPDATE events SET id = :to WHERE id = 100000', { to: _second } );
	const { nodes, roots } = _s.rebuilt();
	assert.equal( nodes.get( _child.id ).parent?.id, _root.id );
	assert.deepEqual( roots.map( item => item.id ), [ _root.id ] );
} );

attack( S, 'E2: a fact logged twice (a replayed event) counts once after the rebuild', () => {
	const _s = story();
	const _root = _s.create();
	const _fact = _root.addFact( measured( 3 ) );
	_s.raw( 'fact_delivered', _fact, _root.id );
	assert.equal( _s.rebuilt().nodes.get( _root.id ).facts.length, 1 );
} );

attack( S, 'rebuilding twice on the same runner gives one node per id and no doubled children', () => {
	const _s = story();
	const _root = _s.create();
	_s.create( { parent: _root } );
	const _runner = { id: 'r1', registry, nodes: new Map(), log: _s.log, journal: _s.journal };
	new Restore( _runner ).rebuild();
	const [ _again ] = new Restore( _runner ).rebuild();
	assert.equal( _runner.nodes.size, 2 );
	assert.equal( _again.children.length, 1 );
	assert.equal( _runner.nodes.get( _root.id ), _again );
} );

attack( S, '16.3: the result of a closed node comes back with it, and a closed root is no open root', () => {
	const _s = story();
	const _root = bring( _s.create(), 'closing' );
	_root.move( 'closed', { result: { status: 'failed', reason: 'deadline' } } );
	const { roots, nodes } = _s.rebuilt();
	assert.deepEqual( roots, [] );
	assert.deepEqual( nodes.get( _root.id ).result, { status: 'failed', reason: 'deadline' } );
} );

// Pentest F: the rest of the log stays readable, so one damaged row cannot stop every other run's restart.
attack( S, '18.6: a row of the log that is not JSON stops the rebuild of its run loudly instead of half-restoring', () => {
	const _s = story();
	bring( _s.create(), 'planning' );
	_s.db.run( 'UPDATE events SET data = \'{"from":"draft","to":\' WHERE kind = \'state_changed\'' );
	assert.throws( () => _s.rebuilt(), /event \d+ in the log cannot be read/ );
	assert.doesNotThrow( () => Restore.unfinished( _s.log ) );
	assert.ok( _s.log.since( 0, 1e9 ).some( event => event.damaged && event.kind === 'state_changed' ) );
} );

attack( S, 'a log cut off right after a node was created rebuilds a draft that resumes by asking again', () => {
	const _s = story();
	const _root = _s.create();
	const { roots } = _s.rebuilt();
	assert.deepEqual( [ roots.length, roots[ 0 ].id, roots[ 0 ].state, roots[ 0 ].facts.length ], [ 1, _root.id, 'draft', 0 ] );
} );

attack( S, 'L2: the journal tells the rebuilt node what it tried and which attempt was still open', () => {
	const _s = story();
	const _root = bring( _s.create(), 'executing' );
	const _first = _s.journal.start( _root, { id: 'mail' }, { wall: null } );
	_s.journal.end( _first, { outcome: 'wall', cause: 'no_reaction' } );
	const _open = _s.journal.start( _root, { id: 'call' }, { wall: 'no_reaction' } );
	const _back = _s.rebuilt().nodes.get( _root.id );
	assert.deepEqual( _back.tried, [ { strategy: 'mail', wall: null, outcome: 'wall', cause: 'no_reaction' } ] );
	assert.deepEqual( [ _back.plan.attempt, _back.plan.strategy, _back.plan.wall ], [ _open, 'call', 'no_reaction' ] );
} );

attack( S, 'L2: two attempts the journal still has open are both known to the rebuilt node, not only the last', () => {
	const _s = story();
	const _root = bring( _s.create(), 'executing' );
	const _a = _s.journal.start( _root, { id: 'mail' }, {} );
	const _b = _s.journal.start( _root, { id: 'call' }, {} );
	const _back = _s.rebuilt().nodes.get( _root.id );
	const _known = [ _back.plan?.attempt, ...( _back.tried || [] ).map( item => item.attempt ), ...( _back.openAttempts || [] ) ];
	assert.ok( _known.includes( _a ) && _known.includes( _b ), 'otherwise one of them is never ended (G6 commercial)' );
} );
