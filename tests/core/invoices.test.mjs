import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';
import { office, registry, Contract } from '../office.mjs';

const [ Observer ] = await use( 'World.Observer' );

// The person at the gate confirms the root goal, approves every payment with a reason and answers every ticket
// with the recommendation.
async function finance() {
	const _office = await office( { mission: 'invoices', by: 'finance-lead' } );
	const _root = await _office.run();
	return { ..._office, root: _root };
}

test( 'one child per invoice on the same loop; known suppliers are paid after approval, the unknown one goes to a person', async () => {
	const { root, outbox, egress } = await finance();
	assert.equal( root.result.status, 'fulfilled', JSON.stringify( root.result ) );
	assert.equal( root.children.length, 5 );
	assert.ok( root.children.every( child => child.result.status === 'fulfilled' && child.depth === 1 ) );
	const _unknown = root.children.find( child => child.contract.serves.precondition === 'R-1188' );
	assert.deepEqual( _unknown.walls.map( wall => wall.cause ), [ 'label_blocked' ] );
	assert.deepEqual( _unknown.tried.map( item => item.strategy ), [ 'pay-from-master-data', 'hand-to-person' ] );
	assert.equal( _unknown.facts.find( fact => fact.kind === 'item_resolved' ).evidenceClass, 'confirmation' );
	const _confirmations = root.children.map( child => egress.store.contract( child.contract.hash ).confirmedBy );
	assert.ok( _confirmations.every( by => by.startsWith( 'derived from' ) ), 'children are confirmed by derivation, not by a person' );
	assert.deepEqual( outbox.messages( 'bank' ).map( item => item.params.invoiceId ), [ 'R-1184', 'R-1185', 'R-1186', 'R-1187' ] );
} );

test( 'a child that drops an invariant of its parent needs a person', async () => {
	const { root, egress } = await finance();
	const _spec = { ...root.children[ 0 ].contract.canonical(), id: 'loose-child' };
	_spec.criteria = _spec.criteria.filter( item => item.type !== 'exactly_once' );
	const _loose = new Contract( _spec, registry );
	assert.equal( egress.propose( _loose.canonical(), _loose.rules(), _loose.hash ).status, 'proposed' );
} );

test( 'the phishing mail: a case of its own; its account is refused at G2, and the supplier gets a plain answer', async () => {
	const { mission, runner, baseline, outbox } = await finance();
	const _mail = mission.inbound[ 0 ];
	const [ [ _case ] ] = await Promise.all( [ runner.newCase( _mail ), baseline.handle( _mail ) ] );
	assert.deepEqual( _case.tried.map( item => [ item.strategy, item.cause ] ), [ [ 'do-as-asked', 'plan_refused' ], [ 'answer-supplier', null ] ] );
	assert.match( _case.walls[ 0 ].detail.join(), /iban would carry foreign/ );
	assert.ok( runner.log.forNode( _case.id ).some( event => event.kind === 'move_started' && event.data.move === 'knowledge.find' ), 'the answer follows the policy (9.1)' );
	const _ours = outbox.messages( 'bank' ).map( item => item.params );
	assert.equal( Observer.lost( _ours, mission.masterData.account ), 0 );
	const _theirs = baseline.sent( 'invoices' ).flatMap( item => item.payments );
	assert.equal( Observer.lost( _theirs, mission.masterData.account, _ours.map( item => item.invoiceId ) ), 3150 );
} );
