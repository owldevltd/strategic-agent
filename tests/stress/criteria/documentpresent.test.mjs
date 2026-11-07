// core/criteria/documentpresent.js (beleg_vorhanden, 14.1): the document exists unchanged. Evidence is an observation
// with a checksum, equal to the expected one or, without it, to the first one observed. Attacks: changes, missing
// checksums, near-miss kinds and references.
import { EXPIRED, assert, attack, attacks, fact, hostile, make, registry } from './kit.mjs';
import { outcomeSuite } from './suites.mjs';

const S = 'core/criteria/documentpresent.js';
const VALUES = { kind: 'delivery note', ref: 'LS-4711' };
const seen = ( checksum, data = {}, extra = {} ) => fact( 'document', { kind: 'delivery note', ref: 'LS-4711', checksum, ...data }, 'observation', extra );
const check = ( facts, values = VALUES ) => make( 'document_present', values ).check( facts );

outcomeSuite( S, { type: 'document_present', values: VALUES, good: () => [ seen( 'sha256:aa' ) ], refused: [ 'derivation', 'claim', 'confirmation' ] } );

attack( S, 'observed once: it exists, unchanged against itself', () => {
	const _doc = seen( 'sha256:aa' );
	assert.deepEqual( check( [ _doc ] ), { met: true, evidence: [ _doc.id ], reason: '' } );
} );

attack( S, 'observed twice with the same checksum: unchanged, the latest is the evidence', () => {
	const _later = seen( 'sha256:aa' );
	assert.deepEqual( check( [ seen( 'sha256:aa' ), _later ] ).evidence, [ _later.id ] );
} );

attack( S, 'observed again with another checksum: it has changed', () => {
	const _result = check( [ seen( 'sha256:aa' ), seen( 'sha256:bb' ) ] );
	assert.equal( _result.met, false );
	assert.equal( _result.reason, 'the document has changed' );
} );

attacks( S, [
	{ name: 'an expected checksum that matches the observation meets it', expected: 'sha256:aa', observed: [ 'sha256:aa' ], want: true },
	{ name: 'an expected checksum that differs from the only observation does not', expected: 'sha256:aa', observed: [ 'sha256:bb' ], want: false },
	{ name: 'an expected checksum beats the first observation: first bb, latest aa meets it', expected: 'sha256:aa', observed: [ 'sha256:bb', 'sha256:aa' ], want: true },
	{ name: 'an expected checksum in another case is another checksum', expected: 'SHA256:AA', observed: [ 'sha256:aa' ], want: false },
	{ name: 'an expected checksum with a trailing space is another checksum', expected: 'sha256:aa ', observed: [ 'sha256:aa' ], want: false },
	{ name: 'an empty expected checksum means none, so the first observation is the baseline', expected: '', observed: [ 'sha256:aa', 'sha256:aa' ], want: true },
], ( { expected, observed, want } ) => {
	assert.equal( check( observed.map( sum => seen( sum ) ), { ...VALUES, checksum: expected } ).met, want );
} );

attacks( S, [
	{ name: 'an observation without any checksum proves nothing about "unchanged"', observed: [ undefined ] },
	{ name: 'two observations without a checksum prove nothing about "unchanged"', observed: [ undefined, undefined ] },
	{ name: 'an observation whose checksum is null proves nothing', observed: [ null ] },
	{ name: 'an observation whose checksum is the empty text proves nothing', observed: [ '' ] },
], ( { observed } ) => {
	assert.equal( check( observed.map( sum => seen( sum ) ) ).met, false );
} );

attack( S, 'an expected checksum against an observation without checksum: not met', () => {
	assert.equal( check( [ seen( undefined ) ], { ...VALUES, checksum: 'sha256:aa' } ).met, false );
} );

attacks( S, [
	{ name: 'a document of another kind does not count', data: { kind: 'invoice' } },
	{ name: 'a document with another reference does not count', data: { ref: 'LS-4712' } },
	{ name: 'a reference given as a number is another reference', data: { ref: 4711 } },
	{ name: 'a reference with a leading space is another reference', data: { ref: ' LS-4711' } },
], ( { data } ) => {
	assert.equal( check( [ seen( 'sha256:aa', data ) ] ).met, false );
} );

attack( S, 'another document changing does not change this one', () => {
	assert.equal( check( [ seen( 'sha256:aa' ), seen( 'sha256:zz', { ref: 'LS-9' } ) ] ).met, true );
} );

attack( S, 'a change that is superseded (E5) leaves the document unchanged', () => {
	assert.equal( check( [ seen( 'sha256:aa' ), seen( 'sha256:bb', {}, { superseded: true } ) ] ).met, true );
} );

attack( S, 'a changed copy whose first observation has expired is compared against the oldest valid one', () => {
	const _result = check( [ seen( 'sha256:aa', {}, { validUntil: EXPIRED } ), seen( 'sha256:bb' ), seen( 'sha256:cc' ) ] );
	assert.equal( _result.met, false );
} );

attack( S, 'a thousand equal observations stay unchanged, quickly', () => {
	const _start = Date.now();
	assert.equal( check( Array.from( { length: 1000 }, () => seen( 'sha256:aa' ) ) ).met, true );
	assert.ok( Date.now() - _start < 500 );
} );

attack( S, 'one changed observation among a thousand equal ones, if it is the latest, is a change', () => {
	assert.equal( check( [ ...Array.from( { length: 999 }, () => seen( 'sha256:aa' ) ), seen( 'sha256:ab' ) ] ).met, false );
} );

attack( S, 'the reason says when the document was never observed', () => {
	assert.equal( check( [] ).reason, 'not observed' );
} );

attacks( S, hostile( 'types' ).filter( item => item.value !== null && item.value !== undefined ).slice( 0, 8 )
	.map( item => ( { ...item, name: `validate: an expected checksum ${item.label} is refused` } ) ), ( { value } ) => {
	assert.deepEqual( make( 'document_present', { ...VALUES, checksum: value } ).validate(), [ 'k1: checksum must be text' ] );
} );

attacks( S, [
	{ name: 'validate: the expected checksum is optional', values: VALUES, want: [] },
	{ name: 'validate: a missing kind is refused', values: { ref: 'LS-1' }, want: [ 'k1: kind is missing' ] },
	{ name: 'validate: a missing reference is refused', values: { kind: 'note' }, want: [ 'k1: ref is missing' ] },
], ( { values, want } ) => {
	assert.deepEqual( make( 'document_present', values ).validate(), want );
} );

attack( S, 'its evidence kind is the document observation', () => {
	assert.deepEqual( registry.types.document_present.EVIDENCE, [ 'document' ] );
} );
