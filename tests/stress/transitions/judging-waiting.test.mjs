// judging → waiting (table 16.1: "escalate", a ticket is put). The real ways at the root: the only strategy hit its
// wall, the same with a person who says "try once more", facts from two origins contradict each other (E5), a
// criterion can no longer be met because its deadline passed (U4), and a person who never answers before the deadline.
import assert from 'node:assert/strict';
import { matrix } from './matrix.mjs';
import { path, ALPHA, silent } from './paths.mjs';
import { out, measured, QUANTITY } from './rig.mjs';

const T = 'judging→waiting';
// Two facts about the same quantity from different origins with different values (E5).
const both = () => ( {
	value: { n: 1 }, labels: [ 'own' ], cohort: null,
	facts: [ measured( 1, { data: { quantity: QUANTITY, value: 1, about: QUANTITY } } ), measured( 0, { origin: 'other', data: { quantity: QUANTITY, value: 0, about: QUANTITY } } ) ],
} );

// The escalation: a ticket to a person (the client), with the node's deadline, after a verdict "escalate" (U4).
const ticket = ( { r, last, hit } ) => {
	const _node = last.node( hit[ 0 ].node.id ) || hit[ 0 ].node;
	assert.equal( hit[ 0 ].event.data.why, 'escalated' );
	const _events = last.events( _node );
	const _at = _events.findIndex( event => event.id === hit[ 0 ].event.id );
	const _verdict = _events.slice( 0, _at ).reverse().find( event => event.kind === 'verdict' );
	assert.equal( _verdict.data.verdict, 'escalate' );
	const _ticket = _events.slice( _at ).find( event => event.kind === 'ticket_opened' ) || _events.find( event => event.kind === 'ticket_opened' && event.id > hit[ 0 ].event.id );
	if ( !_ticket ) {
		// The core went down before the ticket was put; the restart judges again and may escalate again.
		assert.ok( last !== r, 'only a crash leaves an escalation without its ticket' );
		return { node: _node, ticket: { options: [ 'try once more', 'close as failed' ] } };
	}
	assert.equal( _ticket.data.kind, 'escalation' );
	assert.equal( _ticket.data.to, 'client' );
	assert.ok( Date.parse( _ticket.data.deadline ) <= Date.parse( _node.contract.deadline ), 'no later than its node (R3)' );
	assert.ok( _ticket.data.options.includes( 'close as failed' ) );
	return { node: _node, ticket: _ticket.data };
};

matrix( T, [
	{
		name: 'the only strategy hit its wall', options: path( 'escalate' ), status: 'failed', expect: { late: 'fulfilled', twice: 'fulfilled' },
		check: ticket,
	},
	{
		name: 'the only strategy hit its wall, the person says "try once more"', options: path( 'retry' ), status: 'fulfilled', expect: { tokens: 'failed' },
		check: state => assert.ok( ticket( state ).ticket.options.includes( 'try once more' ) ),
	},
	{
		name: 'facts from two origins contradict each other (E5, U4)', status: 'failed', expect: { late: 'failed', twice: 'failed' },
		options: path( 'escalate', { script: { 'stress.measure': [ both ] } } ),
		check: ( state ) => {
			ticket( state );
			assert.ok( state.last.events( state.root, 'conflict' ).length, 'the conflict is an event (E5)' );
			assert.equal( state.root.result.status === 'fulfilled', false, 'an open conflict never closes as fulfilled' );
		},
	},
	{
		name: 'a criterion can no longer be met, its deadline passed (U4)', status: 'failed', expect: { late: 'failed', twice: 'failed' },
		options: path( 'escalate', { strategies: [ ALPHA ], script: { 'stress.measure': [ out.after( 60, out.none() ) ] } } ),
		// The criterion's own deadline is 40 ms after the start; the move takes 60.
		prepare: ( r ) => {
			const _start = r.start.bind( r );
			const _criterion = { id: 'k1', type: 'number_in_range', values: { quantity: QUANTITY, min: 1 } };
			r.start = given => _start( { ...given, criteria: [ { ..._criterion, deadline: new Date( Date.now() + 40 ).toISOString() } ] } );
		},
		check: ( state ) => {
			ticket( state );
			const _verdict = state.last.events( state.root, 'verdict' ).find( event => event.data.verdict === 'escalate' );
			assert.equal( _verdict.data.rule, 'U4' );
		},
	},
	{
		name: 'the person never answers before the goal\'s deadline', options: path( 'escalate', { person: silent } ), given: { deadlineMs: 400 },
		only: [ 'none', 'abort', 'late', 'lateSoon', 'twice', 'crash', 'lateCrash', 'garbage' ],
		status: 'failed', expect: { late: 'fulfilled', twice: 'fulfilled', lateSoon: 'fulfilled' },
		check: ( state ) => {
			ticket( state );
			const _withdrawn = state.last.events( state.root ).filter( event => [ 'ticket_withdrawn', 'ticket_expired' ].includes( event.kind ) );
			assert.ok( _withdrawn.length || state.root.result.status === 'aborted', 'the unanswered ticket ends with the goal (16.5)' );
		},
	},
] );
