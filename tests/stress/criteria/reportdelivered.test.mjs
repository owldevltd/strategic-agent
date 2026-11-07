// core/criteria/reportdelivered.js: a message of the given action (a report by default) reached the recipient. The
// evidence is the gate's receipt, never the agent's word that it sent something. Attacks: other actions, other
// recipients, classes of actions, claims, malformed receipts.
import { DEADLINE, assert, attack, attacks, followed, hostile, make, receipt, registry, shift } from './kit.mjs';
import { outcomeSuite } from './suites.mjs';

const S = 'core/criteria/reportdelivered.js';
const VALUES = { to: 'hr', topic: 'survey design' };
const met = ( facts, values = VALUES ) => make( 'report_delivered', values ).check( facts ).met;

outcomeSuite( S, {
	type: 'report_delivered', values: VALUES, good: () => [ receipt( 'report' ) ], refused: [ 'derivation', 'claim', 'confirmation' ],
} );

attack( S, 'the gate\'s receipt of a report to the recipient meets it', () => {
	const _receipt = receipt( 'report' );
	assert.deepEqual( make( 'report_delivered', VALUES ).check( [ _receipt ] ), { met: true, evidence: [ _receipt.id ], reason: '' } );
} );

attacks( S, [
	{ name: 'a report to another recipient does not count', fact: () => receipt( 'report', { to: 'cfo' } ) },
	{ name: 'a report to the recipient in another case does not count', fact: () => receipt( 'report', { to: 'HR' } ) },
	{ name: 'a report to the recipient with a trailing space does not count', fact: () => receipt( 'report', { to: 'hr ' } ) },
	{ name: 'a report without a recipient does not count', fact: () => receipt( 'report', { to: undefined } ) },
	{ name: 'a reply to the recipient is no report', fact: () => receipt( 'reply' ) },
	{ name: 'a payment to the recipient is no report', fact: () => receipt( 'payment' ) },
	{ name: 'an action the table does not know is no report', fact: () => receipt( 'report_v2' ) },
	{ name: 'a receipt without any action is no report', fact: () => receipt( undefined ) },
], ( { fact } ) => {
	assert.equal( met( [ fact() ] ), false );
} );

attacks( S, [
	{ name: 'with action "reply" a reply counts', action: 'reply', sent: 'reply', want: true },
	{ name: 'with action "reply" a report does not', action: 'reply', sent: 'report', want: false },
	{ name: 'with the class "carries:message" an invitation counts', action: 'carries:message', sent: 'invite', want: true },
	{ name: 'with the class "carries:message" a payment does not', action: 'carries:message', sent: 'payment', want: false },
	{ name: 'with "outward" any outgoing action counts, a payment included', action: 'outward', sent: 'payment', want: true },
], ( { action, sent, want } ) => {
	assert.equal( met( [ receipt( sent ) ], { ...VALUES, action } ), want );
} );

attack( S, 'the agent\'s claim that it sent the report is no receipt', () => {
	assert.equal( met( [ receipt( 'report', {}, { evidenceClass: 'claim', source: 'agent' } ) ] ), false );
} );

attack( S, 'the first matching receipt is the evidence', () => {
	const [ _first, _second ] = [ receipt( 'report' ), receipt( 'report' ) ];
	assert.deepEqual( make( 'report_delivered', VALUES ).check( [ receipt( 'report', { to: 'cfo' } ), _first, _second ] ).evidence, [ _first.id ] );
} );

attack( S, 'one malformed receipt among good ones does not stop the verdict', () => {
	const _broken = { id: 'x', kind: 'delivered', evidenceClass: 'observation', source: 'gate', time: '2026-11-05T10:00:00Z' };
	assert.equal( met( [ _broken, receipt( 'report' ) ] ), true );
} );

attack( S, 'a report the execution follows after its move ended (O8) still counts: its receipt names action and recipient', () => {
	assert.equal( met( followed( { action: 'report', target: 'hr' } ) ), true );
} );

attack( S, 'a report delivered after the criterion\'s deadline does not count', () => {
	const _late = receipt( 'report', {}, { time: shift( DEADLINE, 1 ) } );
	assert.equal( make( 'report_delivered', VALUES, { deadline: DEADLINE } ).check( [ _late ] ).met, false );
} );

attack( S, 'the reason says no delivery was confirmed', () => {
	assert.equal( make( 'report_delivered', VALUES ).check( [] ).reason, 'no confirmed delivery' );
} );

attacks( S, hostile( 'strings' ).filter( item => item.value.trim() && item.value.length < 100 ).slice( 10, 20 )
	.map( item => ( { ...item, name: `the hostile recipient ${item.label} is met only by a receipt to exactly that recipient` } ) ), ( { value } ) => {
	assert.equal( met( [ receipt( 'report', { to: 'hr' } ) ], { ...VALUES, to: value } ), false );
	assert.equal( met( [ receipt( 'report', { to: value } ) ], { ...VALUES, to: value } ), true );
} );

attacks( S, [
	{ name: 'validate: an unknown action is refused', values: { ...VALUES, action: 'fax' }, want: /action must be one of/ },
	{ name: 'validate: "*" is no action', values: { ...VALUES, action: '*' }, want: /action must be one of/ },
	{ name: 'validate: a missing recipient is refused', values: { topic: 't' }, want: /to is missing/ },
	{ name: 'validate: a missing topic is refused', values: { to: 'hr' }, want: /topic is missing/ },
	{ name: 'validate: the action is optional', values: VALUES, want: null },
], ( { values, want } ) => {
	const _problems = make( 'report_delivered', values ).validate();
	if ( want ) {
		assert.match( _problems.join(), want );
	} else {
		assert.deepEqual( _problems, [] );
	}
} );

attack( S, 'its evidence kind is the gate\'s receipt, which a sending move delivers (K4)', () => {
	assert.deepEqual( registry.types.report_delivered.EVIDENCE, [ 'delivered' ] );
	assert.deepEqual( [ make( 'report_delivered', VALUES ).gateRules(), make( 'report_delivered', VALUES ).flowRules() ], [ [], [] ] );
} );
