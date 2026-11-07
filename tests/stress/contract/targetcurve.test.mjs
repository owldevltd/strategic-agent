// core/strategy/targetcurve.js: F_s(t) = p0 · (1 − e^(−t/τ)), the chance that an attempt of s meets its criterion
// within t hours (19, 20 L2). A chance is a probability: it must stay within [0, 1] (within [0, p0] for a valid
// curve), never be NaN, never fall when the time grows, and take the defaults when the catalog gives no curve.
import assert from 'node:assert/strict';
import { attack, attacks, hostile, random } from '../hostile.mjs';
import { TargetCurve } from './fixtures.mjs';

const SUBJECT = 'core/strategy/targetcurve.js';
const curve = new TargetCurve();
const F = ( startCurve, hours ) => curve.value( { startCurve }, hours );
const close = ( actual, expected, digits = 9 ) => assert.ok( Math.abs( actual - expected ) < 10 ** -digits, `${actual} ≠ ${expected}` );
const probability = value => Number.isFinite( value ) && value >= 0 && value <= 1;

attacks( SUBJECT, [
	{ name: 'at t = 0 the chance is 0', hours: 0, expected: 0 },
	{ name: 'after one τ the chance is p0 · (1 − 1/e)', hours: 2, expected: 0.8 * ( 1 - Math.exp( -1 ) ) },
	{ name: 'after half a τ the chance is p0 · (1 − e^−½)', hours: 1, expected: 0.8 * ( 1 - Math.exp( -0.5 ) ) },
	{ name: 'after five τ the chance is within 1 % of p0', hours: 10, expected: 0.8 * ( 1 - Math.exp( -5 ) ) },
	{ name: 'after a million hours the chance is p0', hours: 1e6, expected: 0.8 },
], ( { hours, expected } ) => {
	close( F( { p0: 0.8, tauH: 2 }, hours ), expected );
} );

attack( SUBJECT, 'the paper\'s mail: p0 0.5, τ 20 h, 68 h left gives 0.48', () => {
	assert.equal( Number( F( { p0: 0.5, tauH: 20 }, 68 ).toFixed( 2 ) ), 0.48 );
} );

attack( SUBJECT, 'the paper\'s phone call: p0 0.8, τ 2 h, 68 h left gives 0.80', () => {
	assert.equal( Number( F( { p0: 0.8, tauH: 2 }, 68 ).toFixed( 2 ) ), 0.8 );
} );

attack( SUBJECT, 'a strategy without a start curve has p0 0.5 and τ 24 h', () => {
	close( curve.value( {}, 24 ), 0.5 * ( 1 - Math.exp( -1 ) ) );
} );

attack( SUBJECT, 'a start curve without τ takes τ 24 h; one without p0 takes 0.5', () => {
	close( F( { p0: 0.9 }, 24 ), 0.9 * ( 1 - Math.exp( -1 ) ) );
	close( F( { tauH: 4 }, 4 ), 0.5 * ( 1 - Math.exp( -1 ) ) );
} );

attack( SUBJECT, 'a start curve of null takes the defaults', () => {
	close( F( null, 24 ), 0.5 * ( 1 - Math.exp( -1 ) ) );
} );

attack( SUBJECT, 'a past deadline (negative time) leaves no chance', () => {
	assert.equal( F( { p0: 0.9, tauH: 1 }, -5 ), 0 );
} );

attack( SUBJECT, 'p0 1 approaches certainty, p0 0 never has a chance', () => {
	close( F( { p0: 1, tauH: 1 }, 1000 ), 1 );
	assert.equal( F( { p0: 0, tauH: 1 }, 1000 ), 0 );
} );

attack( SUBJECT, 'p0 given as text in the catalog is read as a number', () => {
	close( F( { p0: '0.7', tauH: 1 }, 1000 ), 0.7 );
} );

attack( SUBJECT, 'the curve is pure: the same input gives the same chance and the strategy is not changed', () => {
	const _strategy = { id: 's', startCurve: { p0: 0.6, tauH: 3 } };
	const _before = JSON.stringify( _strategy );
	assert.equal( curve.value( _strategy, 5 ), curve.value( _strategy, 5 ) );
	assert.equal( JSON.stringify( _strategy ), _before );
} );

// Time edges from the hostile number corpus: every one gives a probability within [0, p0].
attacks( SUBJECT, hostile( 'numbers' ).map( item => ( {
	...item, name: `remaining time ${Object.is( item.value, -0 ) ? '-0' : String( item.value )} h gives a chance within [0, p0]`,
} ) ), ( { value } ) => {
	const _chance = F( { p0: 0.8, tauH: 2 }, value );
	assert.ok( probability( _chance ) && _chance <= 0.8, String( _chance ) );
} );

// Start curves of a hostile type: the curve falls back to the defaults.
attacks( SUBJECT, hostile( 'types' ).map( item => ( { ...item, name: `a start curve ${item.label} falls back to the default curve` } ) ), ( { value } ) => {
	close( curve.value( { startCurve: value }, 24 ), 0.5 * ( 1 - Math.exp( -1 ) ) );
} );

// Hostile τ: whatever the catalog or a proposal writes, the chance stays a probability and never falls over time.
const TAUS = [
	{ label: 'τ 0 at t = 0', tauH: 0, hours: 0 },
	{ label: 'τ 0 after an hour', tauH: 0, hours: 1 },
	{ label: 'τ −2', tauH: -2, hours: 5 },
	{ label: 'τ NaN', tauH: Number.NaN, hours: 5 },
	{ label: 'τ as text "abc"', tauH: 'abc', hours: 5 },
	{ label: 'τ as text "2"', tauH: '2', hours: 2 },
	{ label: 'τ null at t = 0', tauH: null, hours: 0 },
	{ label: 'τ Infinity', tauH: Infinity, hours: 5 },
	{ label: 'τ 5e-324', tauH: 5e-324, hours: 5 },
	{ label: 'τ 1e308', tauH: 1e308, hours: 5 },
];
attacks( SUBJECT, TAUS.map( item => ( { ...item, name: `${item.label} keeps the chance a probability` } ) ), ( { tauH, hours } ) => {
	const _chance = F( { p0: 0.8, tauH }, hours );
	assert.ok( probability( _chance ), String( _chance ) );
	assert.ok( F( { p0: 0.8, tauH }, hours + 10 ) >= _chance, 'more time never lowers the chance' );
} );

// Hostile p0: a chance above 1 or below 0 is no probability; it would let a strategy win every choice.
const P0 = [
	{ label: 'p0 5', p0: 5 },
	{ label: 'p0 1e9', p0: 1e9 },
	{ label: 'p0 −0.5', p0: -0.5 },
	{ label: 'p0 NaN', p0: Number.NaN },
	{ label: 'p0 "high"', p0: 'high' },
	{ label: 'p0 Infinity', p0: Infinity },
	{ label: 'p0 true', p0: true },
	{ label: 'p0 null', p0: null },
];
attacks( SUBJECT, P0.map( item => ( { ...item, name: `${item.label} keeps the chance a probability` } ) ), ( { p0 } ) => {
	for ( const hours of [ 0, 1, 1000 ] ) {
		const _chance = F( { p0, tauH: 2 }, hours );
		assert.ok( probability( _chance ), `${hours} h: ${_chance}` );
	}
} );

// Random valid curves: monotone in time and bounded by p0.
attacks( SUBJECT, [ 11, 12, 13, 14, 15 ].map( seed => ( { name: `random curve ${seed}: the chance never falls as time grows`, seed } ) ), ( { seed } ) => {
	const _random = random( seed );
	const _start = { p0: _random(), tauH: 0.01 + _random() * 100 };
	let _last = -1;
	for ( let hours = -10; hours < 500; hours += _random() * 7 ) {
		const _chance = F( _start, hours );
		assert.ok( _chance >= _last, `${hours} h: ${_chance} < ${_last}` );
		_last = _chance;
	}
} );

attacks( SUBJECT, [ 21, 22, 23 ].map( seed => ( { name: `random curve ${seed}: the chance stays within [0, p0]`, seed } ) ), ( { seed } ) => {
	const _random = random( seed );
	for ( let i = 0; i < 200; i++ ) {
		const _start = { p0: _random(), tauH: 0.001 + _random() * 1000 };
		const _chance = F( _start, ( _random() - 0.2 ) * 1e4 );
		assert.ok( _chance >= 0 && _chance <= _start.p0, JSON.stringify( { _start, _chance } ) );
	}
} );

attack( SUBJECT, 'a shorter τ reaches its chance earlier, for the same p0', () => {
	assert.ok( F( { p0: 0.6, tauH: 1 }, 3 ) > F( { p0: 0.6, tauH: 10 }, 3 ) );
} );

attack( SUBJECT, 'the remaining time given as text is read as hours', () => {
	close( F( { p0: 0.8, tauH: 2 }, '2' ), 0.8 * ( 1 - Math.exp( -1 ) ) );
} );
