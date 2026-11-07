// core/criteria/numberinrange.js (zahl_im_bereich, 14.1): the latest measurement lies within the range; a range is
// never empty (K6). Attacks: boundaries, bounds that are no bounds, values that are no numbers, the order of
// measurements, and strictness when an agent narrows the range.
import { AT, ContractCheck, Contract, assert, attack, attacks, fact, corpus, make, ms, registry, shift } from './kit.mjs';
import { outcomeSuite } from './suites.mjs';

const S = 'core/criteria/numberinrange.js';
const VALUES = { quantity: 'answers:design', min: 5, max: 50 };
const measured = ( value, data = {}, extra = {} ) => fact( 'measured', { quantity: 'answers:design', value, ...data }, 'observation', extra );
const met = ( facts, values = VALUES ) => make( 'number_in_range', values ).check( facts ).met;

outcomeSuite( S, { type: 'number_in_range', values: VALUES, good: () => [ measured( 12 ) ], refused: [ 'derivation', 'claim', 'confirmation' ] } );

attacks( S, [
	{ name: 'a value inside the range meets it', value: 12, want: true },
	{ name: 'exactly the minimum meets it', value: 5, want: true },
	{ name: 'exactly the maximum meets it', value: 50, want: true },
	{ name: 'just below the minimum does not', value: 4.999999, want: false },
	{ name: 'just above the maximum does not', value: 50.000001, want: false },
	{ name: 'numeric text is read as its number', value: '12', want: true },
	{ name: 'text that is no number does not meet it', value: 'twelve', want: false },
	{ name: 'NaN does not meet it', value: NaN, want: false },
	{ name: 'a missing value does not meet it', value: undefined, want: false },
	{ name: 'Infinity is above every maximum', value: Infinity, want: false },
	{ name: 'a value of 1e308 is above the maximum', value: 1e308, want: false },
], ( { value, want } ) => {
	assert.equal( met( [ measured( value ) ] ), want );
} );

attacks( S, [
	{ name: 'a measurement of null is no measurement of zero', value: null },
	{ name: 'a measurement of empty text is no measurement of zero', value: '' },
	{ name: 'a measurement of false is no measurement of zero', value: false },
	{ name: 'a measurement of an empty list is no measurement of zero', value: [] },
], ( { value } ) => {
	assert.equal( met( [ measured( 1, { quantity: 'errors' } ) ], { quantity: 'errors', max: 3 } ), true );
	assert.equal( met( [ measured( value, { quantity: 'errors' } ) ], { quantity: 'errors', max: 3 } ), false );
} );

attacks( S, [
	{ name: 'only a minimum: any value at or above it meets it', values: { quantity: 'answers:design', min: 5 }, value: 1e9, want: true },
	{ name: 'only a minimum: Infinity meets it', values: { quantity: 'answers:design', min: 5 }, value: Infinity, want: true },
	{ name: 'only a maximum: a negative value meets it', values: { quantity: 'answers:design', max: 3 }, value: -2, want: true },
	{ name: 'a single-value range (min = max) meets exactly that value', values: { quantity: 'answers:design', min: 7, max: 7 }, value: 7, want: true },
	{ name: 'a single-value range misses its neighbour', values: { quantity: 'answers:design', min: 7, max: 7 }, value: 7.0000001, want: false },
	{ name: '-0 meets a minimum of 0', values: { quantity: 'answers:design', min: 0 }, value: -0, want: true },
], ( { values, value, want } ) => {
	assert.equal( met( [ measured( value ) ], values ), want );
} );

attack( S, 'the latest measurement counts: a later low value undoes an earlier good one', () => {
	assert.equal( met( [ measured( 12 ), measured( 4 ) ] ), false );
	assert.equal( met( [ measured( 4 ), measured( 12 ) ] ), true );
} );

attack( S, 'the latest measurement is the one measured last, not the one that arrived last', () => {
	const _new = measured( 12, {}, { time: shift( AT, 60000 ) } );
	const _old = measured( 4, {}, { time: shift( AT, -60000 ) } );
	assert.equal( met( [ _new, _old ] ), true );
} );

attack( S, 'a measurement of another quantity does not count, even if it comes last', () => {
	assert.equal( met( [ measured( 12 ), measured( 1, { quantity: 'answers:pay' } ) ] ), true );
	assert.equal( met( [ measured( 12, { quantity: 'answers:Design' } ) ] ), false );
} );

attack( S, 'the evidence is the latest measurement, and the reason states the value', () => {
	const _last = measured( 4 );
	const _result = make( 'number_in_range', VALUES ).check( [ measured( 12 ), _last ] );
	assert.deepEqual( _result, { met: false, evidence: [ _last.id ], reason: 'answers:design is 4' } );
	assert.equal( make( 'number_in_range', VALUES ).check( [] ).reason, 'not measured' );
} );

attack( S, 'an expired latest measurement leaves the one before it (B2)', () => {
	assert.equal( met( [ measured( 12 ), measured( 4, {}, { validUntil: '2001-01-01T00:00:00Z' } ) ] ), true );
} );

attacks( S, [
	{ name: 'K6: an empty range (min > max) is refused', values: { quantity: 'q', min: 5, max: 2 }, want: /the range is empty \(K6\)/ },
	{ name: 'a range without any bound is refused', values: { quantity: 'q' }, want: /needs min or max/ },
	{ name: 'a missing quantity is refused', values: { min: 1 }, want: /quantity is missing/ },
	{ name: 'a minimum given as text is refused', values: { quantity: 'q', min: '5' }, want: /min must be a number/ },
	{ name: 'a maximum given as a list is refused', values: { quantity: 'q', max: [ 5 ] }, want: /max must be a number/ },
], ( { values, want } ) => {
	assert.match( make( 'number_in_range', values ).validate().join(), want );
} );

attack( S, 'a range whose bounds are both null has no bound and is refused', () => {
	const _item = make( 'number_in_range', { quantity: 'q', min: null, max: null } );
	assert.ok( _item.validate().length > 0 );
	assert.equal( _item.check( [ fact( 'measured', { quantity: 'q', value: -1e9 } ) ] ).met, true );
} );

attack( S, 'a minimum of NaN is refused instead of making the criterion unreachable', () => {
	assert.ok( make( 'number_in_range', { quantity: 'q', min: NaN } ).validate().length > 0 );
} );

attack( S, 'a refused minimum explains itself without "undefined" in the text', () => {
	assert.doesNotMatch( make( 'number_in_range', { quantity: 'q', min: '5' } ).validate().join(), /undefined/ );
} );

attack( S, 'K6 at G1: a contract with an empty range is refused', () => {
	const _contract = new Contract( { id: 'c', goal: 'Enough answers', deadline: '2026-12-01T00:00:00Z', budget: 9,
		criteria: [ { id: 'k1', type: 'number_in_range', values: { quantity: 'q', min: 9, max: 1 } } ] }, registry );
	assert.match( new ContractCheck().check( _contract, { now: ms( '2026-11-03T00:00:00Z' ) } ).problems.join(), /K6/ );
} );

attacks( S, [
	{ name: 'strictness: a narrower range is stricter', a: { min: 10, max: 40 }, b: { min: 5, max: 50 }, want: true },
	{ name: 'strictness: the same range is as strict', a: { min: 5, max: 50 }, b: { min: 5, max: 50 }, want: true },
	{ name: 'strictness: a lower minimum is looser', a: { min: 4, max: 50 }, b: { min: 5, max: 50 }, want: false },
	{ name: 'strictness: a higher maximum is looser', a: { min: 5, max: 51 }, b: { min: 5, max: 50 }, want: false },
	{ name: 'strictness: dropping the maximum is looser', a: { min: 5 }, b: { min: 5, max: 50 }, want: false },
	{ name: 'strictness: adding a maximum is stricter', a: { min: 5, max: 50 }, b: { min: 5 }, want: true },
], ( { a, b, want } ) => {
	assert.equal( make( 'number_in_range', { quantity: 'q', ...a } ).atLeastAsStrict( make( 'number_in_range', { quantity: 'q', ...b } ) ), want );
} );

attack( S, 'strictness: a range on another quantity is not stricter, however narrow', () => {
	const _other = make( 'number_in_range', { quantity: 'answers:pay', min: 10, max: 20 } );
	assert.equal( _other.atLeastAsStrict( make( 'number_in_range', { quantity: 'answers:design', min: 5 } ) ), false );
} );

attack( S, 'strictness: a range is not stricter than a criterion of another type', () => {
	assert.equal( make( 'number_in_range', { quantity: 'q', min: 1 } ).atLeastAsStrict( make( 'state_is', { object: 'o', field: 'f', value: 'v' } ) ), false );
} );

attacks( S, corpus( 'numbers' ).map( item => ( { ...item, name: `a measured value of ${item.label} meets [0, 1e300] exactly when it is a finite number in it` } ) ), ( { value } ) => {
	const _inside = Number.isFinite( value ) && value >= 0 && value <= 1e300;
	assert.equal( met( [ measured( value ) ], { quantity: 'answers:design', min: 0, max: 1e300 } ), _inside );
} );
