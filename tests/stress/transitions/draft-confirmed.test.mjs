// draft → confirmed (table 16.1: the back-translation is confirmed at the gate, G1). The real ways: a person confirms
// a root goal at once or after a while, the gate derives a child's confirmation from its confirmed parent, a report
// goal whose gate rules are bound to the confirmed hash, and a goal that later escalates. Each crossed with what can
// cut in at the moment of the confirmation.
import assert from 'node:assert/strict';
import { matrix } from './matrix.mjs';
import { path } from './paths.mjs';

const T = 'draft→confirmed';

// The person confirms only on the fourth look at the gate.
function hesitant() {
	let _looks = 0;
	return () => {
		_looks += 1;
		return _looks > 3;
	};
}

const confirmed = ( { last, hit } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	assert.equal( hit[ 0 ].event.data.hash, _node.contract.hash, 'the confirmation names the hash of the frozen contract' );
	const _row = last.gateDb.get( 'SELECT status FROM contracts WHERE hash = :hash', { hash: _node.contract.hash } );
	assert.equal( _row.status, 'confirmed', 'the gate holds the same contract as confirmed' );
	const _kinds = last.events( _node ).map( event => event.kind );
	assert.ok( _kinds.indexOf( 'contract_proposed' ) < _kinds.indexOf( 'state_changed' ), 'proposed before it is confirmed (3.2)' );
	assert.equal( last.events( _node ).filter( event => event.kind === 'state_changed' && event.data.to === 'confirmed' ).length, 1, 'confirmed once' );
	return _node;
};

matrix( T, [
	{
		name: 'a person confirms the root goal at once', options: path( 'direct' ), status: 'fulfilled', expect: { tokens: 'failed' },
		check: ( state ) => {
			confirmed( state );
			assert.equal( state.hit[ 0 ].event.data.by, 'test-person' );
		},
	},
	{
		name: 'a person confirms only after looking several times', options: path( 'direct', { confirm: hesitant() } ), status: 'fulfilled',
		expect: { tokens: 'failed' },
		check: ( state ) => {
			confirmed( state );
			assert.equal( state.last.events( state.root, 'contract_proposed' ).length, 1, 'proposed once, however long the person takes' );
		},
	},
	{
		name: 'the gate derives a child\'s confirmation from its confirmed parent', node: 'child', options: path( 'deeper' ), status: 'fulfilled',
		expect: { tokens: 'failed' },
		check: ( state ) => {
			const _child = confirmed( state );
			assert.match( state.hit[ 0 ].event.data.by, /derived from/, 'no person is asked for a child within its parent\'s rules' );
			assert.equal( _child.parent.id, state.root.id );
		},
	},
	{
		name: 'a report goal is confirmed with the gate rules bound to its hash', options: path( 'report' ), given: { report: true }, status: 'fulfilled',
		expect: { tokens: 'failed', garbage: 'failed' },
		check: ( state ) => {
			const _node = confirmed( state );
			const _rules = JSON.parse( state.last.gateDb.get( 'SELECT rules FROM contracts WHERE hash = :hash', { hash: _node.contract.hash } ).rules );
			assert.ok( _rules.gate.some( rule => rule.rule === 'expires' ), 'the deadline is a rule of the gate (G-1b)' );
		},
	},
	{
		name: 'a goal is confirmed whose only strategy later hits a wall', options: path( 'escalate' ), status: 'failed',
		// The late fact proves the criterion; it waits in the queue and the first judgment takes it (E3, E4, U1).
		expect: { late: 'fulfilled', twice: 'fulfilled' },
		check: state => confirmed( state ),
	},
] );
