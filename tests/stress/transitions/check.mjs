// The checks every transition test makes after a run: the log is a chain of table transitions from draft (Z1, Z3,
// Z4) and gives the node's state; a closed node did nothing more (Z5); after an abort nothing new started (G-1a);
// no attempt is left open in the journal; every start burnt a token (R1); nothing left the gate without a consumed
// approval or after the deadline (A6, G-1b); and a restart rebuilds the same state from the log (18).
import assert from 'node:assert/strict';
import { Machine, Restore, registry } from './rig.mjs';

const RESULTS = [ 'fulfilled', 'failed', 'aborted', 'refused', 'expired' ];
const AFTER_CLOSE = [ 'state_changed', 'move_started', 'plan_accepted', 'child_started', 'process_started', 'delivery_started', 'fact_delivered',
	'wall', 'verdict', 'credited' ];
const STARTS = [ 'plan_accepted', 'child_started', 'process_started', 'delivery_started' ];

// Z1, Z3, Z4: → the logged transitions of a node as "from→to".
export function chain( r, node ) {
	const _changes = r.events( node, 'state_changed' );
	let _state = 'draft';
	for ( const event of _changes ) {
		const { from, to } = event.data;
		assert.equal( from, _state, `${node.id}: ${from}→${to} does not follow ${_state} (Z1, Z4)` );
		assert.ok( Machine.allowed( from, to ), `${node.id}: ${from}→${to} is not in table 16.1 (Z3)` );
		_state = to;
	}
	assert.equal( node.state, _state, `${node.id}: the state is ${node.state}, the log says ${_state} (Z4)` );
	return _changes.map( event => `${event.data.from}→${event.data.to}` );
}

// Z5: after closed the node does nothing more; G-1a: after its abort nothing new starts but the cancellation.
function quiet( r, node ) {
	const _events = r.events( node );
	const _closed = _events.findIndex( event => event.kind === 'state_changed' && event.data.to === 'closed' );
	if ( _closed >= 0 ) {
		const _late = _events.slice( _closed + 1 ).filter( event => AFTER_CLOSE.includes( event.kind ) ).map( event => event.kind );
		assert.deepEqual( _late, [], `${node.id}: events after closed (Z5)` );
	}
	const _abort = _events.findIndex( event => event.kind === 'abort_received' );
	if ( _abort >= 0 ) {
		const _new = _events.slice( _abort + 1 ).filter( event => STARTS.includes( event.kind )
			|| ( event.kind === 'move_started' && event.data.move !== 'move.cancel' ) ).map( event => event.data.move || event.kind );
		assert.deepEqual( _new, [], `${node.id}: something started after the abort (G-1a)` );
	}
}

// A6, G-1b: everything that left the gate was executed with a consumed token, before the goal's deadline.
export function gate( r ) {
	const _executed = r.gateDb.all( 'SELECT * FROM deliveries WHERE status = \'executed\'' );
	for ( const row of _executed ) {
		const _token = r.gateDb.get( 'SELECT status FROM approvals WHERE delivery = :id', { id: row.id } );
		assert.equal( _token?.status, 'consumed', `delivery ${row.id} went out without a consumed token (A6)` );
	}
	assert.equal( r.gateDb.get( 'SELECT COUNT(*) AS n FROM outbox' ).n, _executed.length, 'the outbox holds exactly the executed deliveries' );
	for ( const row of r.gateDb.all( 'SELECT d.createdAt, c.spec FROM deliveries d JOIN contracts c ON c.hash = d.root' ) ) {
		assert.ok( Date.parse( row.createdAt ) <= Date.parse( JSON.parse( row.spec ).deadline ), 'a delivery was created after the deadline (G-1b)' );
	}
	return _executed.length;
}

// 18, Z4: a new core rebuilds every node of the run from the log with the same state, result, facts, walls and costs.
export function replay( r ) {
	for ( const runner of r.system.runners ) {
		const _copy = { id: runner.id, registry, log: r.log, nodes: new Map(), journal: r.system.journal };
		new Restore( _copy ).rebuild();
		for ( const node of runner.nodes.values() ) {
			const _again = _copy.nodes.get( node.id );
			assert.ok( _again, `${node.id} is not in the log (Z4)` );
			assert.equal( _again.state, node.state, `${node.id}: rebuilt as ${_again.state}, live ${node.state} (Z4)` );
			assert.equal( _again.result?.status ?? null, node.result?.status ?? null, `${node.id}: the rebuilt result differs (Z4)` );
			const _facts = list => list.filter( fact => fact.kind !== 'conflict' ).map( fact => fact.id ).sort();
			assert.deepEqual( _facts( _again.facts ), _facts( node.facts ), `${node.id}: the rebuilt facts differ (Z4)` );
			assert.deepEqual( _again.walls.map( wall => wall.cause ), node.walls.map( wall => wall.cause ), `${node.id}: the rebuilt walls differ (Z4)` );
			assert.equal( _again.spent, node.spent, `${node.id}: the rebuilt costs differ (Z4)` );
		}
	}
}

// R1: every start in the tree burnt exactly one token.
export function tokens( r ) {
	for ( const runner of r.system.runners ) {
		const _starts = [ ...runner.nodes.values() ].flatMap( node => r.events( node ) )
			.filter( event => [ 'plan_accepted', 'child_started', 'process_started' ].includes( event.kind ) ).length;
		const _burnt = r.tokensUsed( runner ) - ( r.taken[ runner.id ] || 0 );
		assert.equal( _burnt, _starts, `run ${runner.id}: ${_starts} starts, ${_burnt} tokens burnt (R1)` );
	}
}

// Everything at once after a run that ended: → the root's transitions.
export function verify( r, { status = null, root = r.root, closed = true } = {} ) {
	assert.deepEqual( r.state.errors.map( error => error.message ), [], 'a hook of the test failed' );
	for ( const node of r.nodes() ) {
		chain( r, node );
		quiet( r, node );
		if ( !closed ) { continue; }
		assert.equal( node.state, 'closed', `${node.id} ends ${node.state}, not closed (G-1c)` );
		assert.ok( RESULTS.includes( node.result?.status ), `${node.id} closed without a result: ${JSON.stringify( node.result )}` );
		const _open = r.system.journal.forNode( node.id ).filter( attempt => !attempt.endedAt ).map( attempt => attempt.strategy );
		assert.deepEqual( _open, [], `${node.id}: attempts left open in the journal (G6 commercial)` );
	}
	if ( Array.isArray( status ) ) {
		assert.ok( status.includes( root.result?.status ), `${JSON.stringify( root.result )} is none of ${status.join( ', ' )}` );
	} else if ( status ) {
		assert.equal( root.result?.status, status, JSON.stringify( root.result ) );
	}
	gate( r );
	tokens( r );
	replay( r );
	return chain( r, root );
}

// The count of a transition in a list of "from→to".
export const count = ( list, transition ) => list.filter( item => item === transition ).length;
