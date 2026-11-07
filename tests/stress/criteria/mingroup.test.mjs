// core/criteria/mingroup.js: nothing about fewer than k people leaves. Confidential records may leave only as a group
// the gate can count (10.4), and the gate refuses any group below k. Attacks think like someone trying to get a
// single person out: padded cohorts, cohorts that are no lists, other actions, loosened k.
import { ContractCheck, Contract, assert, attack, attacks, followed, gate, corpus, make, receipt, registry, release } from './kit.mjs';
import { invariantSuite } from './suites.mjs';

const S = 'core/criteria/mingroup.js';
const VALUES = { k: 5 };
const people = n => Array.from( { length: n }, ( _x, i ) => `p${i + 1}` );
const check = ( facts, k = 5 ) => make( 'min_group', { k } ).check( facts );

invariantSuite( S, {
	type: 'min_group', values: VALUES,
	clean: () => [ release( people( 5 ) ), release( null ), release( people( 12 ) ) ],
	violating: () => [ release( people( 5 ) ), release( [ 'anna', 'bob' ] ) ],
} );

attacks( S, [
	{ name: 'a group of nobody is below every k', size: 0, met: false },
	{ name: 'one person alone is a breach', size: 1, met: false },
	{ name: 'k - 1 people are a breach', size: 4, met: false },
	{ name: 'exactly k people may leave', size: 5, met: true },
	{ name: 'k + 1 people may leave', size: 6, met: true },
	{ name: 'a hundred thousand people may leave, and are counted quickly', size: 100000, met: true },
], ( { size, met } ) => {
	const _start = Date.now();
	assert.equal( check( [ release( people( size ) ) ] ).met, met );
	assert.ok( Date.now() - _start < 1000 );
} );

attack( S, 'the breaching release is the evidence, the others are not', () => {
	const _small = release( people( 2 ) );
	assert.deepEqual( check( [ release( people( 9 ) ), _small, release( people( 5 ) ) ] ), { met: false, evidence: [ _small.id ], reason: 'a release below the group size' } );
} );

attack( S, 'a message without a group (cohort null or absent) is no release', () => {
	assert.equal( check( [ release( null ), receipt( 'reply', { cohort: undefined } ) ] ).met, true );
} );

attack( S, 'a cohort that is no list is not counted here, and the gate never lets confidential data out with one', () => {
	assert.equal( check( [ release( 'anna' ), release( { length: 9 } ) ] ).met, true );
	const _spec = [ { id: 'k1', type: 'min_group', values: VALUES } ];
	const _result = gate( _spec, { action: 'report', labels: { body: [ 'confidential' ] }, cohort: 'anna' } );
	assert.ok( _result.refusals.some( item => item.rule === 'confidential' && /without a declared group/.test( item.reason ) ) );
} );

attacks( S, [
	{ name: 'one person repeated five times is one person, not a group of five', cohort: [ 'anna', 'anna', 'anna', 'anna', 'anna' ] },
	{ name: 'one person padded with null and undefined entries is one person', cohort: [ 'anna', null, null, undefined, undefined ] },
	{ name: 'one person padded with empty ids is one person', cohort: [ 'anna', '', '', ' ', '' ] },
], ( { cohort } ) => {
	assert.equal( check( [ release( cohort ) ] ).met, false );
} );

attacks( S, [
	{ name: 'a small group in a reply is a breach too', action: 'reply' },
	{ name: 'a small group in an invitation is a breach too', action: 'invite' },
	{ name: 'a small group attached to a payment is a breach too', action: 'payment' },
], ( { action } ) => {
	assert.equal( check( [ receipt( action, { cohort: [ 'anna' ] } ) ] ).met, false );
} );

attack( S, 'it allows confidential data to leave only as a group, only for actions that carry data', () => {
	assert.deepEqual( make( 'min_group', VALUES ).allows(), [ { label: 'confidential', actions: [ 'carries:data' ], as: 'group' } ] );
} );

attack( S, 'its gate rule carries k for every action that carries data', () => {
	assert.deepEqual( make( 'min_group', VALUES ).gateRules(), [ { rule: 'min_group', actions: [ 'carries:data' ], k: 5 } ] );
} );

const SPEC = [ { id: 'k1', type: 'min_group', values: VALUES } ];
const out = ( cohort, labels = { body: [ 'confidential' ] } ) => ( { action: 'report', labels, cohort } );

attacks( S, [
	{ name: 'gate: confidential data about k - 1 people is refused', request: out( people( 4 ) ), rule: 'min_group', refused: true },
	{ name: 'gate: confidential data about k people goes through', request: out( people( 5 ) ), rule: 'min_group', refused: false },
	{ name: 'gate: a message without a group is no release', request: out( undefined, {} ), rule: 'min_group', refused: false },
	{ name: 'gate: confidential data without a declared group is refused', request: out( undefined ), rule: 'confidential', refused: true },
	{ name: 'gate: a group of k, but plain data, still passes the rule', request: out( people( 5 ), {} ), rule: 'min_group', refused: false },
], ( { request, rule, refused } ) => {
	assert.equal( gate( SPEC, request ).rules.includes( rule ), refused );
} );

attack( S, 'gate: without this goal confidential data does not leave at all, not even as a big group', () => {
	const _result = gate( [ { id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 't' } } ], out( people( 50 ) ) );
	assert.ok( _result.refusals.some( item => item.rule === 'confidential' && /may not leave/.test( item.reason ) ) );
} );

attack( S, 'gate: one person repeated k times is refused as a group of one', () => {
	assert.ok( gate( SPEC, out( [ 'anna', 'anna', 'anna', 'anna', 'anna' ] ) ).rules.includes( 'min_group' ) );
} );

attack( S, 'gate: of two group sizes in one contract the larger one holds', () => {
	const _two = [ { id: 'k1', type: 'min_group', values: { k: 3 } }, { id: 'k2', type: 'min_group', values: { k: 5 } } ];
	const _result = gate( _two, out( people( 4 ) ) );
	assert.deepEqual( _result.refusals.filter( item => item.rule === 'min_group' ).map( item => item.criterion ), [ 'k2' ] );
} );

attacks( S, [
	{ name: 'strictness: a larger k is stricter', a: 7, b: 5, want: true },
	{ name: 'strictness: the same k is as strict', a: 5, b: 5, want: true },
	{ name: 'strictness: a smaller k is looser', a: 3, b: 5, want: false },
], ( { a, b, want } ) => {
	assert.equal( make( 'min_group', { k: a } ).atLeastAsStrict( make( 'min_group', { k: b } ) ), want );
} );

const contract = criteria => new Contract( { id: 'c', goal: 'Report on the survey', deadline: '2026-12-01T00:00:00Z', budget: 9, criteria }, registry );

attacks( S, [
	{ name: 'G1: the agent may not lower the client\'s k', k: 3, problem: /may only tighten k1/ },
	{ name: 'G1: the agent may raise the client\'s k', k: 7, problem: null },
], ( { k, problem } ) => {
	const _problems = new ContractCheck()._consistency( contract( [ { id: 'k1', type: 'min_group', values: VALUES }, { id: 'a1', type: 'min_group', values: { k }, origin: 'agent' } ] ) );
	if ( problem ) {
		assert.match( _problems.join(), problem );
	} else {
		assert.deepEqual( _problems, [] );
	}
} );

attacks( S, [
	{ name: 'K7: a prescribed k 5 is met by an immutable k 7', k: 7, immutable: true, missing: false },
	{ name: 'K7: a prescribed k 5 is not met by an immutable k 3', k: 3, immutable: true, missing: true },
	{ name: 'K7: a prescribed k 5 is not met by a k 7 that may still change', k: 7, immutable: false, missing: true },
], ( { k, immutable, missing } ) => {
	const _problems = new ContractCheck()._mandatory( contract( [ { id: 'k1', type: 'min_group', values: { k }, immutable } ] ), [ { type: 'min_group', values: VALUES } ] );
	assert.equal( _problems.length > 0, missing );
} );

attacks( S, corpus( 'numbers' ).map( item => ( { ...item, name: `validate: k = ${item.label} is ${Number.isInteger( item.value ) && item.value >= 2 ? 'a' : 'no'} valid group size` } ) ),
	( { value } ) => {
		const _ok = Number.isInteger( value ) && value >= 2;
		assert.equal( make( 'min_group', { k: value } ).validate().length === 0, _ok );
	} );

attacks( S, [
	{ name: 'validate: k = 1 would let single people out and is refused', k: 1 },
	{ name: 'validate: k as text "5" is refused', k: '5' },
	{ name: 'validate: a missing k is refused', k: undefined },
], ( { k } ) => {
	assert.equal( make( 'min_group', { k } ).validate().length, 1 );
} );

attack( S, 'a release the execution follows after its move ended (O8) keeps its group, so a small one is still seen', () => {
	const _facts = followed( { action: 'report', cohort: [ 'anna', 'bob' ] } );
	assert.equal( check( _facts ).met, false );
} );
