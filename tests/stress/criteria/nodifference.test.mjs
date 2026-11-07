// core/criteria/nodifference.js: two releases must not differ by fewer than k people, or "the same without Anna"
// gives Anna away. The gate compares each new group with every group it released in the same scope. Attacks think
// like a differencing attacker: subsets, padded or retyped ids that fake a large difference, many releases.
import { ContractCheck, Contract, assert, attack, attacks, gate, hostile, make, receipt, registry, release } from './kit.mjs';
import { invariantSuite } from './suites.mjs';

const S = 'core/criteria/nodifference.js';
const VALUES = { k: 3 };
const people = ( n, from = 1 ) => Array.from( { length: n }, ( _x, i ) => `p${from + i}` );
const check = ( facts, k = 3 ) => make( 'no_difference', { k } ).check( facts );
const met = ( cohorts, k = 3 ) => check( cohorts.map( cohort => release( cohort ) ), k ).met;

invariantSuite( S, {
	type: 'no_difference', values: VALUES,
	clean: () => [ release( people( 10 ) ), release( people( 10, 4 ) ) ],
	violating: () => [ release( people( 10 ) ), release( people( 9, 2 ) ) ],
} );

attacks( S, [
	{ name: 'one release alone is never a difference', cohorts: [ people( 10 ) ], met: true },
	{ name: 'the same group twice reveals nothing new', cohorts: [ people( 10 ), people( 10 ) ], met: true },
	{ name: 'the same group in another order is the same group', cohorts: [ people( 10 ), people( 10 ).reverse() ], met: true },
	{ name: '"the same without Anna": one person less is a breach', cohorts: [ people( 10 ), people( 9 ) ], met: false },
	{ name: '"the same plus Anna": one person more is a breach', cohorts: [ people( 10 ), people( 11 ) ], met: false },
	{ name: 'k - 1 people less is a breach', cohorts: [ people( 10 ), people( 8 ) ], met: false },
	{ name: 'exactly k people less is allowed', cohorts: [ people( 10 ), people( 7 ) ], met: true },
	{ name: 'one swapped out and one in differ by two, a breach for k 3', cohorts: [ people( 10 ), [ ...people( 9 ), 'q1' ] ], met: false },
	{ name: 'two disjoint groups differ by everyone', cohorts: [ people( 10 ), people( 10, 100 ) ], met: true },
	{ name: 'an empty release next to a group of one differ by one', cohorts: [ [], [ 'anna' ] ], met: false },
], ( { cohorts, met: want } ) => {
	assert.equal( met( cohorts ), want );
} );

attack( S, 'the order of the releases does not matter', () => {
	assert.equal( met( [ people( 9 ), people( 10 ) ] ), met( [ people( 10 ), people( 9 ) ] ) );
} );

attack( S, 'of three releases, only the close pair is the evidence', () => {
	const [ _a, _b, _c ] = [ release( people( 10 ) ), release( people( 10, 50 ) ), release( people( 9 ) ) ];
	assert.deepEqual( check( [ _a, _b, _c ] ).evidence, [ _a.id, _c.id ] );
} );

attack( S, 'releases with other actions and other recipients are compared too', () => {
	const _report = receipt( 'report', { to: 'hr', cohort: people( 10 ) } );
	const _reply = receipt( 'reply', { to: 'press', cohort: people( 9 ) } );
	assert.equal( check( [ _report, _reply ] ).met, false );
} );

attack( S, 'messages without a group are not releases to compare', () => {
	assert.equal( check( [ release( people( 10 ) ), release( null ), release( 'p1' ) ] ).met, true );
} );

attacks( S, [
	{ name: 'padding with one repeated outsider does not hide "the same without Anna"', b: [ ...people( 9, 2 ), 'q', 'q' ] },
	{ name: 'padding with null entries does not hide "the same without Anna"', b: [ ...people( 9, 2 ), null, null ] },
	{ name: 'padding with empty ids does not hide "the same without Anna"', b: [ ...people( 9, 2 ), '', ' ' ] },
	{ name: 'an id retyped as a number does not count as a new person', a: [ 'p1', '2', ...people( 8, 3 ) ], b: [ 2, ...people( 8, 3 ), 'q' ] },
	{ name: 'equal people as fresh objects are the same people', a: people( 10 ).map( id => ( { id } ) ), b: people( 9, 2 ).map( id => ( { id } ) ) },
], ( { a = people( 10 ), b } ) => {
	assert.equal( met( [ a, b ] ), false );
} );

attack( S, 'its gate rule carries k for every action that carries data', () => {
	assert.deepEqual( make( 'no_difference', VALUES ).gateRules(), [ { rule: 'no_difference', actions: [ 'carries:data' ], k: 3 } ] );
	assert.deepEqual( make( 'no_difference', VALUES ).allows(), [] );
} );

const SPEC = [ { id: 'k1', type: 'no_difference', values: VALUES } ];
const out = cohort => ( { action: 'report', labels: {}, cohort } );

attacks( S, [
	{ name: 'gate: a release one person short of an earlier one is refused', cohort: people( 9 ), released: [ people( 10 ) ], refused: true },
	{ name: 'gate: a release k people short of an earlier one goes through', cohort: people( 7 ), released: [ people( 10 ) ], refused: false },
	{ name: 'gate: the same group again goes through', cohort: people( 10 ), released: [ people( 10 ) ], refused: false },
	{ name: 'gate: a release close to any one of several earlier ones is refused', cohort: people( 9 ), released: [ people( 20, 100 ), people( 10 ) ], refused: true },
	{ name: 'gate: the first release has nothing to differ from', cohort: people( 4 ), released: [], refused: false },
], ( { cohort, released, refused } ) => {
	assert.equal( gate( SPEC, out( cohort ), { released } ).rules.includes( 'no_difference' ), refused );
} );

attack( S, 'gate: a repeated outsider in the new group is seen through (the gate counts the new group as a set)', () => {
	assert.ok( gate( SPEC, out( [ ...people( 9, 2 ), 'q', 'q' ] ), { released: [ people( 10 ) ] } ).rules.includes( 'no_difference' ) );
} );

attacks( S, [
	{ name: 'gate: null and empty ids in the new group do not hide "the same without Anna"', cohort: [ ...people( 9, 2 ), null, '' ], released: [ people( 10 ) ] },
	{ name: 'gate: a repeated outsider in the earlier release does not hide "the same without Anna"', cohort: people( 9, 2 ), released: [ [ ...people( 10 ), 'q', 'q' ] ] },
], ( { cohort, released } ) => {
	assert.ok( gate( SPEC, out( cohort ), { released } ).rules.includes( 'no_difference' ) );
} );

attacks( S, [
	{ name: 'strictness: a larger k is stricter', a: 5, b: 3, want: true },
	{ name: 'strictness: the same k is as strict', a: 3, b: 3, want: true },
	{ name: 'strictness: a smaller k is looser', a: 2, b: 3, want: false },
], ( { a, b, want } ) => {
	assert.equal( make( 'no_difference', { k: a } ).atLeastAsStrict( make( 'no_difference', { k: b } ) ), want );
} );

attack( S, 'G1: the agent may not lower the client\'s k', () => {
	const _contract = new Contract( { id: 'c', goal: 'g', deadline: '2026-12-01T00:00:00Z', budget: 9, criteria: [
		{ id: 'k1', type: 'no_difference', values: { k: 5 } }, { id: 'a1', type: 'no_difference', values: { k: 2 }, origin: 'agent' } ] }, registry );
	assert.match( new ContractCheck()._consistency( _contract ).join(), /a1: the agent may only tighten k1/ );
} );

attacks( S, hostile( 'types' ).map( item => ( { ...item, name: `validate: k = ${item.label} is no group difference` } ) ), ( { value } ) => {
	assert.equal( make( 'no_difference', { k: value } ).validate().length, 1 );
} );

attack( S, 'validate: k = 1 is refused, k = 2 is the smallest difference', () => {
	assert.equal( make( 'no_difference', { k: 1 } ).validate().length, 1 );
	assert.deepEqual( make( 'no_difference', { k: 2 } ).validate(), [] );
} );

attack( S, 'thirty releases of a hundred and fifty people each are compared within two seconds', () => {
	const _releases = Array.from( { length: 30 }, ( _x, i ) => release( people( 150, 1 + i * 5 ) ) );
	const _start = Date.now();
	assert.equal( check( _releases ).met, true );
	assert.ok( Date.now() - _start < 2000, `${Date.now() - _start} ms` );
} );
