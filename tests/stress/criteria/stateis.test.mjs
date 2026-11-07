// core/criteria/stateis.js (zustand, 14.1): the object has the value when checked. Evidence is an observation read from
// the leading system, no older than its validity (B2). Attacks: stale readings, other fields, value types, the
// order of readings, readings from people or the agent.
import { AT, DEADLINE, EXPIRED, VALID, assert, attack, attacks, fact, hostile, make, ms, registry, shift } from './kit.mjs';
import { outcomeSuite } from './suites.mjs';

const S = 'core/criteria/stateis.js';
const VALUES = { object: 'calendar', field: 'slot:2026-11-11T10:00', value: 'free' };
const read = ( value, data = {}, extra = {} ) => fact( 'state_read', { object: 'calendar', field: 'slot:2026-11-11T10:00', value, ...data }, 'observation', extra );
const check = ( facts, values = VALUES ) => make( 'state_is', values ).check( facts );

outcomeSuite( S, { type: 'state_is', values: VALUES, good: () => [ read( 'free' ) ], refused: [ 'derivation', 'claim', 'confirmation' ] } );

attack( S, 'a reading of the value meets it, with the reading as evidence', () => {
	const _read = read( 'free' );
	assert.deepEqual( check( [ _read ] ), { met: true, evidence: [ _read.id ], reason: 'reads free' } );
} );

attack( S, 'a reading of another value does not, shows the value read, and names no evidence', () => {
	assert.deepEqual( check( [ read( 'busy' ) ] ), { met: false, evidence: [], reason: 'reads busy' } );
} );

attack( S, 'the latest reading counts: free then busy is busy', () => {
	assert.equal( check( [ read( 'free' ), read( 'busy' ) ] ).met, false );
	assert.equal( check( [ read( 'busy' ), read( 'free' ) ] ).met, true );
} );

attack( S, 'the latest reading is the one read last, not the one that arrived last', () => {
	const _now = read( 'busy', {}, { time: shift( AT, 60000 ) } );
	const _older = read( 'free', {}, { time: shift( AT, -60000 ) } );
	assert.equal( check( [ _now, _older ] ).met, false );
} );

attacks( S, [
	{ name: 'a reading of another field does not count', data: { field: 'slot:2026-11-11T11:00' } },
	{ name: 'a reading of another object does not count', data: { object: 'room' } },
	{ name: 'a reading of the value in another case is another value', data: { value: 'Free' } },
	{ name: 'a reading of the value with a trailing space is another value', data: { value: 'free ' } },
	{ name: 'a reading without a value does not count', data: { value: undefined } },
], ( { data } ) => {
	assert.equal( check( [ read( 'free', data ) ] ).met, false );
} );

attack( S, 'a reading of another field coming last does not hide the reading of this one', () => {
	assert.equal( check( [ read( 'free' ), read( 'busy', { field: 'slot:other' } ) ] ).met, true );
} );

attack( S, 'a number read for a value given as text is another value', () => {
	assert.equal( check( [ read( 5 ) ], { ...VALUES, value: '5' } ).met, false );
} );

attack( S, 'B2: an expired latest reading leaves the valid one before it', () => {
	assert.equal( check( [ read( 'free', {}, { validUntil: VALID } ), read( 'busy', {}, { validUntil: EXPIRED } ) ] ).met, true );
} );

attack( S, 'B2: an expired reading of the value is no reading at all', () => {
	assert.deepEqual( check( [ read( 'free', {}, { validUntil: EXPIRED } ) ] ), { met: false, evidence: [], reason: 'not read' } );
} );

attack( S, 'B2 at the time of the check: a reading valid until 2030 is stale in a verdict for 2031', () => {
	const _read = read( 'free', {}, { validUntil: '2030-01-01T00:00:00Z' } );
	assert.equal( make( 'state_is', VALUES ).verdict( [ _read ], ms( '2031-01-01T00:00:00Z' ) ).met, false );
} );

attack( S, 'a person saying the slot is free is a confirmation, not a reading of the leading system', () => {
	assert.equal( check( [ read( 'free', {}, { evidenceClass: 'confirmation', source: 'person lead' } ) ] ).met, false );
} );

attack( S, 'a reading after the criterion\'s deadline does not count', () => {
	assert.equal( make( 'state_is', VALUES, { deadline: DEADLINE } ).check( [ read( 'free', {}, { time: shift( DEADLINE, 1 ) } ) ] ).met, false );
} );

attack( S, 'the catalog\'s own reading of a registered proposal (meta.register shape) meets a matching criterion', () => {
	const _values = { object: 'catalog', field: 'criterion:combo', value: 'v-1' };
	const _read = fact( 'state_read', { object: 'catalog', field: 'criterion:combo', value: 'v-1' }, 'observation', { source: 'trusted meta.register' } );
	assert.equal( check( [ _read ], _values ).met, true );
} );

attack( S, 'a thousand readings: only the latest of this field decides', () => {
	const _many = Array.from( { length: 1000 }, ( _x, i ) => read( i % 2 ? 'free' : 'busy', { field: `slot:${i}` } ) );
	assert.equal( check( [ ..._many, read( 'busy' ), ..._many ] ).met, false );
	assert.equal( check( [ ..._many, read( 'free' ), ..._many ] ).met, true );
} );

attacks( S, hostile( 'strings' ).filter( item => item.value.trim() && item.value.length < 100 ).slice( 20, 30 )
	.map( item => ( { ...item, name: `the hostile expected value ${item.label} is met only by exactly that reading` } ) ), ( { value } ) => {
	const _values = { ...VALUES, value };
	assert.deepEqual( make( 'state_is', _values ).validate(), [] );
	assert.equal( check( [ read( value ) ], _values ).met, true );
	assert.equal( check( [ read( `${value}.` ) ], _values ).met, false );
} );

attacks( S, [
	{ name: 'validate: a missing object is refused', values: { field: 'f', value: 'v' }, want: /object is missing/ },
	{ name: 'validate: a missing field is refused', values: { object: 'o', value: 'v' }, want: /field is missing/ },
	{ name: 'validate: an expected value that is no text is refused', values: { object: 'o', field: 'f', value: 5 }, want: /value must be text/ },
	{ name: 'validate: an expected value of true is refused', values: { object: 'o', field: 'f', value: true }, want: /value must be text/ },
], ( { values, want } ) => {
	assert.match( make( 'state_is', values ).validate().join(), want );
} );

attack( S, 'its evidence kind is the reading, and it derives no rules', () => {
	assert.deepEqual( registry.types.state_is.EVIDENCE, [ 'state_read' ] );
	assert.deepEqual( make( 'state_is', VALUES ).gateRules(), [] );
} );
