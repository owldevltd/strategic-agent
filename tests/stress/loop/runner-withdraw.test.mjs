// core/loop/runner.js: a goal that ends before a person confirmed it (aborted, or past its deadline) is taken back at
// the gate, so its card leaves the person's list; a gate that cannot be reached never keeps the goal from closing.
import assert from 'node:assert/strict';
import { attack, within } from '../hostile.mjs';
import { Contract, registry, rig, fakeGate, spec, sleep } from './kit.mjs';

const RUN = 'core/loop/runner.js';
attack( RUN, 'a goal aborted or past its deadline before anyone confirmed it is taken back at the gate: its card leaves the list', async () => {
	const _aborted = rig( { gate: fakeGate( { confirm: false } ) } );
	const _node = await _aborted.runner.start( new Contract( spec(), registry ) );
	const _running = _aborted.runner.run( _node );
	await sleep( 20 );
	await _aborted.runner.abort( _node, { reason: 'by the client' } );
	await within( _running, 2000 );
	assert.deepEqual( _aborted.gate.calls.filter( call => call[ 0 ] === 'withdrawContract' ), [ [ 'withdrawContract', _node.contract.hash ] ] );
	const _late = rig( { gate: fakeGate( { confirm: false } ) } );
	const _old = await _late.runner.start( new Contract( spec( {}, 0.00003 ), registry ) );
	await within( _late.runner.run( _old ), 2000 );
	assert.deepEqual( _late.gate.calls.filter( call => call[ 0 ] === 'withdrawContract' ), [ [ 'withdrawContract', _old.contract.hash ] ] );
} );

attack( RUN, 'a gate that cannot take a goal back does not keep the abort from closing it', async () => {
	const _gate = { ...fakeGate( { confirm: false } ), withdrawContract: async () => { throw new Error( 'gate down' ); } };
	const _rig = rig( { gate: _gate } );
	const _node = await _rig.runner.start( new Contract( spec(), registry ) );
	const _running = _rig.runner.run( _node );
	await sleep( 20 );
	await _rig.runner.abort( _node, { reason: 'by the client' } );
	await within( _running, 2000 );
	assert.deepEqual( [ _node.state, _node.result.status ], [ 'closed', 'aborted' ] );
} );
