// Chaos: the client aborts at a random point of a run (16.5, G-1a). Whatever the point, the cascade closes the whole
// tree, withdraws what still waits at the gate, nothing new leaves afterwards, and every invariant holds.
import assert from 'node:assert/strict';
import { attacks, random, within } from '../hostile.mjs';
import { missionOffice, afterEvents, sleep } from './chaos.mjs';
import { check } from './invariants.mjs';

const SUBJECT = 'core/system.js';
const EVENTS = { coding: 34, 'ops-chain': 240, fanout: 390 };
const tree = node => [ node, ...node.children.flatMap( tree ), ...( node.processes || [] ).flatMap( tree ) ];

async function abortRun( id, seed, { approve } = {} ) {
	const _k = random( seed ).int( 3, EVENTS[ id ] );
	const o = await missionOffice( id, { approve } );
	const _running = o.run();
	let _abortedAt = null;
	let _open = [];
	afterEvents( o, _k, async () => {
		if ( o.runner.root.state === 'closed' ) { return; }
		_abortedAt = Date.now();
		_open = tree( o.runner.root ).filter( node => node.state !== 'closed' ).map( node => [ node.id, node.state ] );
		await o.runner.abort( o.runner.root, { reason: 'aborted by the client', status: 'aborted' } );
	} );
	const _root = await within( _running, 15000, 'the aborted goal' );
	const _sent = o.gateDb.get( 'SELECT COUNT(*) AS n FROM outbox' ).n;
	await sleep( 30 );
	o.stop();
	return { o, root: _root, abortedAt: _abortedAt, k: _k, sentAtClose: _sent, open: _open };
}

const seeds = ( id, list ) => list.map( seed => ( { name: `chaos abort: ${id}, seed ${seed}, the cascade closes everything and nothing leaves after it`, id, seed } ) );

attacks( SUBJECT, [ ...seeds( 'ops-chain', [ 21, 22, 23, 24, 25 ] ), ...seeds( 'fanout', [ 26, 27, 28, 29, 30 ] ), ...seeds( 'coding', [ 31, 32, 33 ] ) ],
	async ( { id, seed } ) => {
		const { o, root, abortedAt, k, sentAtClose, open } = await abortRun( id, seed );
		assert.deepEqual( await check( o, { mission: o.mission, provider: o.provider } ), [], `abort after event ${k}` );
		assert.equal( o.gateDb.get( 'SELECT COUNT(*) AS n FROM outbox' ).n, sentAtClose, 'nothing left after the goal closed' );
		if ( abortedAt && root.result.status === 'aborted' ) {
			assert.deepEqual( o.egress.pendingApprovals(), [], 'no request of the aborted tree still waits for a person (O9)' );
			// Every node still open when the client aborted closes as aborted (a node closed before keeps its result, Z5).
			for ( const [ nodeId, state ] of open ) {
				const _node = tree( root ).find( node => node.id === nodeId );
				assert.equal( _node.result.status, 'aborted', `${nodeId} was ${state} at the abort and closed ${_node.result.status}` );
			}
		}
	} );

attacks( SUBJECT, [ 34, 35, 36 ].map( seed => ( { name: `chaos abort: ops chain, seed ${seed}, an abort while the deepest restart waits for its approval`, seed } ) ),
	async ( { seed } ) => {
		const _hold = approval => ( approval.summary.params.service === 'database' ? null : true );
		const o = await missionOffice( 'ops-chain', { approve: _hold } );
		const _running = o.run();
		const _waiting = async () => {
			for ( let i = 0; i < 2000 && !o.egress.pendingApprovals().length; i++ ) { await sleep( 2 ); }
			await sleep( random( seed ).int( 0, 20 ) );
		};
		await _waiting();
		await o.runner.abort( o.runner.root, { reason: 'aborted by the client', status: 'aborted' } );
		const _root = await within( _running, 15000 );
		o.stop();
		assert.equal( _root.result.status, 'aborted' );
		assert.equal( tree( _root ).length, 4, 'three levels below the goal' );
		assert.ok( tree( _root ).every( node => node.result.status === 'aborted' ) );
		assert.deepEqual( o.outbox.messages( 'ops' ), [] );
		assert.ok( o.gateDb.all( 'SELECT status FROM deliveries' ).every( row => [ 'not_sent', 'refused' ].includes( row.status ) ) );
		assert.deepEqual( await check( o, { mission: o.mission, provider: o.provider } ), [] );
	} );
