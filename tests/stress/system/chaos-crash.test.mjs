// Chaos: the core crashes at a random point of a run (after the k-th event it logged; k from a seed) and a new core
// takes over from the log and the gate's ledger (chapter 18). Whatever the point, the run must end and keep every
// invariant: no action without a token, nothing late, every node closed, every attempt ended, nothing twice, and
// the log replays to the very nodes that ran. Seeds that hit a known defect say so; each defect also has a
// deterministic test in chaos-restart.test.mjs.
import assert from 'node:assert/strict';
import { attacks, random, within } from '../hostile.mjs';
import { missionOffice, restarted, freeze, afterEvents } from './chaos.mjs';
import { check } from './invariants.mjs';

const SUBJECT = 'core/system.js';

// One run with a crash after the k-th event; → the office whose nodes count, and its roots.
async function crashRun( id, seed, { approve } = {} ) {
	// A clean run logs about 35 (coding), 250 (ops chain) or 400 (fan-out) events; the crash falls anywhere in them.
	const _k = random( seed ).int( 3, { coding: 34, 'ops-chain': 240, fanout: 390 }[ id ] );
	const o = await missionOffice( id, { approve } );
	const _running = o.run().then( root => ( { closed: root } ) );
	const _crash = afterEvents( o, _k, () => freeze( o ) ).then( ran => ( { crashed: ran } ) );
	const _first = await within( Promise.race( [ _running, _crash ] ), 20000, 'the first core' );
	if ( _first.closed ) {
		o.stop();
		return { office: o, roots: [ _first.closed ], k: _k, crashed: false };
	}
	const _second = await restarted( o, id, { approve } );
	const _roots = await within( _second.resumed, 20000, 'the resumed core' );
	_second.stop();
	return { office: _second, roots: _roots, k: _k, crashed: true };
}

const seeds = ( id, list, known = {} ) => list.map( seed => ( {
	name: `chaos crash: ${id}, seed ${seed}, the run ends and keeps every invariant`, id, seed, defect: known[ seed ] || null,
} ) );

attacks( SUBJECT, [
	...seeds( 'ops-chain', [ 1, 2, 3, 4, 5, 6, 7, 8 ] ),
	...seeds( 'fanout', [ 7, 8, 9, 10 ] ),
	...seeds( 'coding', [ 14, 15, 16, 17 ] ),
], async ( { id, seed } ) => {
	const { office: o, roots, k, crashed } = await crashRun( id, seed );
	const _problems = await check( o, { mission: o.mission, provider: o.provider } );
	assert.deepEqual( _problems, [], `crash after event ${k} (crashed: ${crashed})` );
	for ( const root of roots ) {
		assert.equal( root.state, 'closed' );
	}
	if ( id === 'ops-chain' && roots[ 0 ]?.result.status === 'fulfilled' ) {
		assert.deepEqual( o.outbox.messages( 'ops' ).map( message => message.params.service ), [ 'database', 'ledger', 'payments', 'checkout' ] );
	}
	if ( id === 'coding' ) {
		assert.equal( roots[ 0 ].result.status === 'fulfilled', roots[ 0 ].facts.some( fact => fact.kind === 'test_run' ),
			'fulfilled exactly when a green run is its evidence' );
	}
} );

attacks( SUBJECT, seeds( 'ops-chain', [ 11, 12, 13, 14 ] ).map( item => ( { ...item, name: `${item.name}, with a refused restart` } ) ),
	async ( { id, seed } ) => {
		const _refuse = approval => approval.summary.params.service !== 'payments';
		const { office: o, k } = await crashRun( id, seed, { approve: _refuse } );
		assert.deepEqual( await check( o, { mission: o.mission, provider: o.provider } ), [], `crash after event ${k}` );
		assert.ok( !o.outbox.messages( 'ops' ).some( message => message.params.service === 'payments' ), 'a refused restart never leaves, not even after a restart' );
	} );

attacks( SUBJECT, [ 8, 9, 10 ].map( seed => ( {
	name: `chaos crash: fanout, seed ${seed}, every supplier has one child goal and the goal is met although the core crashed`, seed,
} ) ), async ( { seed } ) => {
	const { office: o, roots, k } = await crashRun( 'fanout', seed );
	const [ _root ] = roots;
	const _items = _root.children.map( child => child.contract.criteria[ 0 ].values.items[ 0 ] );
	assert.deepEqual( _items, [ ...new Set( _items ) ], `crash after event ${k}: a supplier got a second child goal` );
	assert.equal( o.gateDb.get( 'SELECT COUNT( DISTINCT target ) AS n FROM outbox' ).n, 8 );
	assert.equal( _root.result.status, 'fulfilled', 'every supplier was notified exactly once' );
} );
