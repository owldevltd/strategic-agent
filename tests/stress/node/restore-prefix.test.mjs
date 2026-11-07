// core/loop/restore.js under attack, part 3: one real run of the survey is cut off after every single event of its
// log, as if the core had died right there, and rebuilt from what was written (18.1, Z4, 18.6).
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { office } from '../../office.mjs';
import { registry, Restore, STATES } from './kit.mjs';

const S = 'core/loop/restore.js';
const quick = mission => mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;

const captured = ( async () => {
	const _o = await office( { edit: quick } );
	const _root = await _o.run();
	_o.stop();
	const _events = _o.log.since( 0, 1e9 );
	return { events: _events, root: _root, run: _o.runner.id };
} )();

// The core died right after the nth event: what does a new core rebuild from those events alone?
function rebuiltAt( events, n, run ) {
	const _prefix = events.slice( 0, n );
	const _runner = { id: run, registry, nodes: new Map(), log: { since: () => _prefix }, journal: { forNode: () => [] } };
	const _roots = new Restore( _runner ).rebuild( _prefix );
	return { prefix: _prefix, roots: _roots, nodes: _runner.nodes, unfinished: Restore.unfinished( _runner.log ) };
}

// What the log itself says about one node up to the cut.
function expected( prefix, id ) {
	const _own = prefix.filter( event => event.node === id );
	return {
		state: _own.filter( event => event.kind === 'state_changed' ).at( -1 )?.data.to || 'draft',
		moves: _own.filter( event => event.kind === 'state_changed' ).length,
		facts: _own.filter( event => event.kind === 'fact_delivered' ).length,
		walls: _own.filter( event => event.kind === 'wall' ).map( event => event.data.cause ),
		children: prefix.filter( event => event.kind === 'node_created' && event.data.parent === id ).map( event => event.node ),
	};
}

attack( S, '18.6: cut after every single event of a real run, the rebuild matches what the log says, node by node', async () => {
	const { events, run } = await captured;
	assert.ok( events.length > 100, `a real run has many events (${events.length})` );
	for ( let n = 1; n <= events.length; n++ ) {
		const { prefix, roots, nodes, unfinished } = rebuiltAt( events, n, run );
		const _created = prefix.filter( event => event.kind === 'node_created' );
		assert.equal( nodes.size, _created.length, `cut ${n}` );
		for ( const event of _created ) {
			const _node = nodes.get( event.node );
			const _want = expected( prefix, event.node );
			assert.ok( STATES.includes( _node.state ), `cut ${n}: state ${_node.state}` );
			assert.deepEqual( [ _node.state, _node.facts.length, _node.walls.map( wall => wall.cause ) ], [ _want.state, _want.facts, _want.walls ], `cut ${n}` );
			assert.deepEqual( _node.children.map( item => item.id ), _want.children, `cut ${n}` );
		}
		const _root = _created.find( event => !event.data.parent );
		const _open = Boolean( _root ) && nodes.get( _root.node ).state !== 'closed';
		assert.equal( roots.length, _open ? 1 : 0, `cut ${n}` );
		assert.equal( unfinished.length, _open ? 1 : 0, `cut ${n}` );
	}
}, { timeout: 40000 } );

attack( S, 'Z4: cut after every event, every rebuilt node has the version it had at that moment', async () => {
	const { events, run } = await captured;
	for ( let n = 1; n <= events.length; n++ ) {
		const { prefix, nodes } = rebuiltAt( events, n, run );
		for ( const [ id, item ] of nodes ) {
			assert.equal( item.version, expected( prefix, id ).moves, `cut ${n}, node ${id}` );
		}
	}
}, { timeout: 40000 } );

const at = ( kind, where = () => true ) => events => events.findIndex( event => event.kind === kind && where( event ) ) + 1;
const root = events => events.find( event => event.kind === 'node_created' && !event.data.parent ).node;
const child = events => events.find( event => event.kind === 'node_created' && event.data.parent )?.node;

attacks( S, [
	{ name: '18.6: died right after the root was created: one draft root, unfinished, nothing else', cut: at( 'node_created' ),
		check: ( { roots, unfinished, nodes } ) => {
			assert.deepEqual( [ roots.length, roots[ 0 ].state, unfinished.length, nodes.size ], [ 1, 'draft', 1, 1 ] );
		} },
	{ name: '18.6: died right after the confirmation: the root is confirmed and goes on without asking again', cut: at( 'contract_confirmed' ),
		check: ( { roots } ) => assert.equal( roots[ 0 ].state, 'confirmed' ) },
	{ name: '18.6: died right after a plan was accepted: the root is still planning; its attempt is in the journal', cut: at( 'plan_accepted' ),
		check: ( { roots } ) => assert.equal( roots[ 0 ].state, 'planning' ) },
	{ name: '18.6: died right after the first wall: the wall is back with its cause', cut: at( 'wall' ),
		check: ( { roots, prefix } ) => assert.deepEqual( roots[ 0 ].walls, [ prefix.at( -1 ).data ] ) },
	{ name: '18.6: died right after an outside action began: the node knows the action and its attempt (A3)', cut: at( 'delivery_started' ),
		check: ( { nodes, prefix } ) => {
			const _event = prefix.at( -1 );
			const _node = nodes.get( _event.node );
			const { delivery, attempt } = _event.data;
			assert.deepEqual( [ _node.deliveries, _node.deliveryAttempt[ delivery ] ], [ [ delivery ], attempt ] );
		} },
	{ name: '18.6: died right after costs were booked: what was spent is back (P3)', cut: at( 'cost_booked' ),
		check: ( { nodes, prefix } ) => assert.equal( nodes.get( prefix.at( -1 ).node ).spent, prefix.at( -1 ).data.spent ) },
	{ name: '18.6: died right after a child\'s budget was reserved: the reservation is back (P4)', cut: at( 'budget_reserved' ),
		check: ( { nodes, prefix } ) => assert.equal( nodes.get( prefix.at( -1 ).node ).reserved, prefix.at( -1 ).data.reserved ) },
	{ name: '18.6: died right after the child was created: it hangs under the root, one level down, as a draft', cut: at( 'node_created', event => event.data.parent ),
		check: ( { nodes, prefix } ) => {
			const _child = nodes.get( child( prefix ) );
			assert.deepEqual( [ _child.parent.id, _child.depth, _child.state ], [ root( prefix ), 1, 'draft' ] );
		} },
	{ name: '18.6: died right after a credit: it is back as booked, so the journal does not get it twice (L4)', cut: at( 'credited' ),
		check: ( { nodes, prefix } ) => {
			const _event = prefix.at( -1 );
			assert.deepEqual( nodes.get( _event.node ).credited[ _event.data.criterion ], { ..._event.data, booked: true } );
		} },
	{ name: '18.6: died right after a verdict: the node knows its last verdict', cut: at( 'verdict' ),
		check: ( { nodes, prefix } ) => assert.deepEqual( nodes.get( prefix.at( -1 ).node ).lastVerdict, prefix.at( -1 ).data ) },
	{ name: '18.6: died right after the child closed: the child is closed with its result, the root is still open', cut: at( 'node_closed', event => event.node !== undefined ),
		check: ( { nodes, prefix, roots } ) => {
			const _closed = nodes.get( prefix.at( -1 ).node );
			assert.deepEqual( [ _closed.state, Boolean( _closed.result?.status ), roots.length ], [ 'closed', true, _closed.parent ? 1 : 0 ] );
		} },
	{ name: '18.6: the whole log of a finished run leaves nothing to resume', cut: events => events.length,
		check: ( { roots, unfinished, nodes } ) => {
			assert.deepEqual( [ roots, unfinished ], [ [], [] ] );
			assert.ok( [ ...nodes.values() ].every( item => item.state === 'closed' ) );
		} },
], async ( { cut, check } ) => {
	const { events, run } = await captured;
	const _n = cut( events );
	assert.ok( _n > 0, 'the run has that event' );
	check( rebuiltAt( events, _n, run ) );
}, { timeout: 40000 } );
