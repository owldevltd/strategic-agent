// core/loop/restore.js under attack, part 2: resuming rebuilt nodes (18.4, A3, A4, O5, O8, O9) with a runner of
// fakes: every state, an open attempt in every state, open outside actions in every gate status, unclear actions.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { registry, node, bring, Restore, Journal, Db, EventLog } from './kit.mjs';

const S = 'core/loop/restore.js';

// A restarted core of fakes: rows are the gate's deliveries by id and status.
function resumer( { rows = {}, withdraw = null, unclear = null } = {} ) {
	const db = new Db( ':memory:' );
	const log = new EventLog( db, 'core' );
	const journal = new Journal( db );
	const calls = { run: [], afterChild: [], followed: [], withdrawn: [], handedOver: [] };
	const runner = {
		id: 'r1', registry, nodes: new Map(), log, journal,
		run: async ( item, options ) => {
			calls.run.push( [ item.id, item.state, options ] );
			return item;
		},
		afterChild: ( item, pre, child ) => calls.afterChild.push( [ item.id, pre.id, child.id ] ),
		gate: {
			delivery: async id => ( id in rows ? { id, status: rows[ id ], action: 'report', target: 'hr', receipt: { id: `rc-${id}` } } : null ),
			withdraw: async ( id ) => {
				calls.withdrawn.push( id );
				return withdraw ? withdraw( id ) : { delivery: id, status: 'not_sent' };
			},
			...( unclear ? { unclear: async () => unclear } : {} ),
		},
		execution: {
			follow: ( item, id ) => calls.followed.push( id ),
			receipted: row => [ { kind: 'delivered', evidenceClass: 'observation', source: 'gate', origin: 'gate', data: { delivery: row.id, receipt: row.receipt } } ],
		},
		cascade: { handOver: item => calls.handedOver.push( [ item.id, [ ...item.unclear ] ] ) },
	};
	const make = ( state, { parent = null } = {} ) => {
		const _node = bring( node( { log, parent } ), state );
		runner.nodes.set( _node.id, _node );
		return _node;
	};
	// The attempt the journal still has open, as rebuild finds it.
	const open = ( item, strategy = 'mail', spentBefore = 0 ) => {
		const _attempt = journal.start( item, { id: strategy }, { wall: null } );
		item.plan = { strategy, wall: null, attempt: _attempt, spentBefore, trigger: 'start' };
		return _attempt;
	};
	return { runner, calls, restore: new Restore( runner ), log, journal, db, make, open };
}

const kinds = ( log, item ) => log.forNode( item.id ).map( event => event.kind );

attack( S, '18: children are resumed before their parent, every one of them once', async () => {
	const { restore, make, calls, log } = resumer();
	const _root = make( 'waiting' );
	const _a = make( 'executing', { parent: _root } );
	const _b = make( 'planning', { parent: _root } );
	await restore.resume( _root );
	const _runs = calls.run.map( item => item[ 0 ] );
	assert.deepEqual( [ _runs.slice( 0, 2 ).sort(), _runs[ 2 ], _runs.length ], [ [ _a.id, _b.id ].sort(), _root.id, 3 ] );
	const _order = log.since( 0, 1e9 ).filter( event => event.kind === 'resumed' ).map( event => event.node );
	assert.deepEqual( _order.at( -1 ), _root.id );
} );

attack( S, 'Z5: a closed node is not resumed and writes nothing', async () => {
	const { restore, make, calls, log } = resumer();
	const _node = make( 'closed' );
	const _count = log.since( 0, 1e9 ).length;
	assert.equal( await restore.resume( _node ), _node );
	assert.deepEqual( [ calls.run, log.since( 0, 1e9 ).length ], [ [], _count ] );
} );

attacks( S, [ 'executing', 'waiting' ].map( state => ( { name: `A4: a node that was ${state} when the core stopped ends its move as interrupted and judges again`, state } ) ), async ( { state } ) => {
	const { restore, make, open, journal, calls, log } = resumer();
	const _node = make( state );
	const _attempt = open( _node, 'mail', 2 );
	_node.spent = 5;
	await restore.resume( _node );
	assert.equal( _node.walls.at( -1 ).cause, 'interrupted' );
	assert.deepEqual( [ journal.get( _attempt ).outcome, journal.get( _attempt ).cause, journal.get( _attempt ).cost ], [ 'wall', 'interrupted', 3 ] );
	assert.deepEqual( [ _node.state, _node.plan.open ], [ 'judging', false ] );
	assert.deepEqual( calls.run, [ [ _node.id, 'judging', { resume: true } ] ] );
	assert.deepEqual( kinds( log, _node ).slice( -3 ), [ 'resumed', 'wall', 'state_changed' ] );
} );

attacks( S, [ 'planning', 'judging', 'closing' ].map( state => ( {
	name: `18.4: an attempt still open while the node was ${state} is ended as interrupted and booked, so the node can close`, state,
} ) ), async ( { state } ) => {
	const { restore, make, open, journal, log } = resumer();
	const _node = make( state );
	const _attempt = open( _node );
	await restore.resume( _node );
	assert.deepEqual( [ journal.get( _attempt ).outcome, journal.get( _attempt ).cause ], [ 'wall', 'interrupted' ] );
	assert.deepEqual( [ _node.state, _node.plan, _node.walls.at( -1 ).cause ], [ state, null, 'interrupted' ] );
	assert.ok( kinds( log, _node ).includes( 'attempt_interrupted' ) );
} );

attacks( S, [ 'draft', 'confirmed' ].map( state => ( { name: `18: a node that was ${state} without an attempt simply goes on`, state } ) ), async ( { state } ) => {
	const { restore, make, calls } = resumer();
	const _node = make( state );
	await restore.resume( _node );
	assert.deepEqual( [ _node.state, _node.walls.length ], [ state, 0 ] );
	assert.deepEqual( calls.run, [ [ _node.id, state, { resume: true } ] ] );
} );

attack( S, '16.1: a node that waited for a child of a missing precondition gets the child\'s end as its event once', async () => {
	const { restore, make, calls } = resumer();
	const _node = make( 'waiting' );
	_node.lastVerdict = { verdict: 'deeper', precondition: { id: 'answers' } };
	const _child = make( 'closed', { parent: _node } );
	_child.contract.serves = { precondition: 'answers' };
	await restore.resume( _node );
	assert.deepEqual( calls.afterChild, [ [ _node.id, 'answers', _child.id ] ] );
	assert.deepEqual( [ _node.state, _node.walls.length ], [ 'judging', 0 ] );
} );

// The parent took the child's end before the crash and went on with a new attempt; its last verdict is still "deeper".
function movedOn( rows = {} ) {
	const _r = resumer( { rows } );
	const _node = _r.make( 'executing' );
	_node.lastVerdict = { verdict: 'deeper', precondition: { id: 'answers' } };
	const _child = _r.make( 'closed', { parent: _node } );
	_child.contract.serves = { precondition: 'answers' };
	const _attempt = _r.open( _node, 'widen-group' );
	_node.deliveries = Object.keys( rows );
	return { ..._r, node: _node, attempt: _attempt };
}

attack( S, '18.4: a parent that had already gone on after its child ends its interrupted attempt after the restart', async () => {
	const { restore, node: _node, attempt, journal } = movedOn();
	await restore.resume( _node );
	assert.ok( journal.get( attempt ).endedAt, 'otherwise G6 waits Δ for it and the goal closes as failed' );
} );

attack( S, 'A3: a parent that had already gone on after its child settles that attempt\'s executed report, so it is not sent twice', async () => {
	const { restore, node: _node } = movedOn( { 'dl-report': 'executed' } );
	await restore.resume( _node );
	assert.ok( _node.facts.some( fact => fact.data?.delivery === 'dl-report' ), 'the receipt is the evidence for the criterion' );
} );

attack( S, '16.1: the child\'s end is taken once, also when the restore is told twice', async () => {
	const { restore, make, calls } = resumer();
	const _node = make( 'waiting' );
	_node.lastVerdict = { verdict: 'deeper', precondition: { id: 'answers' } };
	make( 'closed', { parent: _node } ).contract.serves = { precondition: 'answers' };
	await Promise.all( [ restore.resume( _node ), restore.resume( _node ) ] );
	assert.equal( calls.afterChild.length, 1 );
	assert.equal( calls.run.length, 1, 'one loop per node' );
} );

attacks( S, [
	{ status: 'awaiting_approval', withdrawn: true, followed: false, fact: false },
	{ status: 'approved', withdrawn: true, followed: false, fact: false },
	{ status: 'open', withdrawn: false, followed: true, fact: false },
	{ status: 'executed', withdrawn: false, followed: false, fact: true },
	{ status: 'not_sent', withdrawn: false, followed: false, fact: false },
	{ status: 'unclear', withdrawn: false, followed: false, fact: false },
	{ status: 'refused', withdrawn: false, followed: false, fact: false },
	{ status: null, withdrawn: false, followed: false, fact: false },
].map( item => ( { ...item, name: `A3, O8: an outside action of the interrupted move that is ${item.status || 'unknown to the gate'} is settled correctly` } ) ),
async ( { status, withdrawn, followed, fact } ) => {
	const { restore, make, calls } = resumer( { rows: status ? { 'dl-1': status } : {} } );
	const _node = make( 'waiting' );
	_node.deliveries = [ 'dl-1' ];
	await restore.resume( _node );
	assert.deepEqual( [ calls.withdrawn.length > 0, calls.followed.length > 0 ], [ withdrawn, followed ] );
	assert.equal( _node.facts.some( item => item.data?.delivery === 'dl-1' ), fact );
} );

attack( S, 'A3: an executed action whose receipt is already a fact does not become a second fact', async () => {
	const { restore, make } = resumer( { rows: { 'dl-1': 'executed' } } );
	const _node = make( 'executing' );
	_node.deliveries = [ 'dl-1' ];
	_node.addFact( { kind: 'delivered', evidenceClass: 'observation', origin: 'gate', data: { delivery: 'dl-1' } } );
	await restore.resume( _node );
	assert.equal( _node.facts.filter( item => item.data?.delivery === 'dl-1' ).length, 1 );
} );

attack( S, 'O9: a withdrawal at the restart that the attempt already won makes the receipt a fact', async () => {
	const { restore, make } = resumer( { rows: { 'dl-1': 'approved' }, withdraw: id => ( { delivery: id, status: 'executed', receipt: { id: 'rc' } } ) } );
	const _node = make( 'waiting' );
	_node.deliveries = [ 'dl-1' ];
	await restore.resume( _node );
	assert.ok( _node.facts.some( item => item.data?.delivery === 'dl-1' ) );
} );

attack( S, 'O9: a withdrawal at the restart that loses the race to an attempt in flight is followed to its end', async () => {
	const { restore, make, calls } = resumer( { rows: { 'dl-1': 'approved' }, withdraw: id => ( { delivery: id, status: 'open' } ) } );
	const _node = make( 'waiting' );
	_node.deliveries = [ 'dl-1' ];
	await restore.resume( _node );
	assert.deepEqual( calls.followed, [ 'dl-1' ], 'its end (executed or unclear) must reach the node or a person' );
} );

attack( S, 'A3, O8: one interrupted move with actions in three states settles each its own way, in one go', async () => {
	const { restore, make, calls } = resumer( { rows: { 'dl-a': 'awaiting_approval', 'dl-o': 'open', 'dl-x': 'executed' } } );
	const _node = make( 'executing' );
	_node.deliveries = [ 'dl-a', 'dl-o', 'dl-x' ];
	await restore.resume( _node );
	assert.deepEqual( [ calls.withdrawn, calls.followed ], [ [ 'dl-a' ], [ 'dl-o' ] ] );
	assert.deepEqual( _node.facts.map( item => item.data.delivery ), [ 'dl-x' ] );
	assert.equal( _node.walls.at( -1 ).cause, 'interrupted' );
} );

attack( S, 'O5: actions the gate could not settle after the restart go to a person once, for the node they belong to', async () => {
	const _r = resumer( { unclear: [ { id: 'dl-1', node: 'n-known' }, { id: 'dl-2', node: 'n-ghost' }, { id: 'dl-3', node: 'n-known' } ] } );
	const _node = node( { id: 'n-known', log: _r.log } );
	_r.runner.nodes.set( _node.id, _node );
	await _r.restore.unclear();
	assert.deepEqual( _node.unclear, [ 'dl-1', 'dl-3' ] );
	assert.deepEqual( _r.calls.handedOver.map( item => item[ 0 ] ), [ 'n-known', 'n-known' ] );
	await _r.restore.unclear();
	assert.equal( _r.calls.handedOver.length, 2, 'what is known as unclear is not asked again' );
} );

attack( S, 'O5: a gate without a list of unclear actions is no reason to fail the restart', async () => {
	const { restore } = resumer();
	await assert.doesNotReject( restore.unclear() );
} );

attack( S, '18: the resumed event records where the node stood before anything changed', async () => {
	const { restore, make, log } = resumer();
	const _node = make( 'waiting' );
	const _version = _node.version;
	await restore.resume( _node );
	const _resumed = log.forNode( _node.id ).find( event => event.kind === 'resumed' );
	assert.deepEqual( _resumed.data, { state: 'waiting', version: _version } );
} );

attack( S, 'A4: an interrupted attempt is not taken up again as if it were still running (19)', async () => {
	const { restore, make, open } = resumer();
	const _node = make( 'executing' );
	open( _node );
	_node.plan.open = true;
	await restore.resume( _node );
	assert.equal( _node.plan.open, false );
} );
