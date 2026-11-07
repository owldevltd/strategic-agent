// core/criteria/soft.js (weich, 14): free text an AI reviewer with fresh context assesses when the node closes. The
// assessment is a derivation and never closes a goal on its own. Attacks: assessments for other criteria, verdicts
// that are no booleans, the order of assessments, and the hard core that must never include it.
import { ContractCheck, Contract, assert, attack, attacks, fact, hostile, make, ms, registry } from './kit.mjs';
import { outcomeSuite } from './suites.mjs';

const S = 'core/criteria/soft.js';
const VALUES = { text: 'friendly and factual' };
const assessed = ( met, criterion = 'k1', extra = {} ) => fact( 'soft_assessed', { criterion, met }, 'derivation', { source: 'reviewer', origin: 'reviewer', ...extra } );
const met = facts => make( 'soft', VALUES ).check( facts ).met;
const contract = ( soft, criteria = [ { id: 'k1', type: 'number_in_range', values: { quantity: 'q', min: 1 } } ] ) =>
	new Contract( { id: 'c', goal: 'g', deadline: '2026-12-01T00:00:00Z', budget: 9, soft, criteria }, registry );

outcomeSuite( S, { type: 'soft', values: VALUES, good: () => [ assessed( true ) ], refused: [], noClass: false } );

attack( S, 'the reviewer\'s yes meets it; its no does not', () => {
	assert.equal( met( [ assessed( true ) ] ), true );
	assert.equal( met( [ assessed( false ) ] ), false );
} );

attack( S, 'the latest assessment counts, both ways', () => {
	assert.equal( met( [ assessed( true ), assessed( false ) ] ), false );
	assert.equal( met( [ assessed( false ), assessed( true ) ] ), true );
} );

attack( S, 'an assessment of another soft criterion does not count, even when it comes last', () => {
	assert.equal( met( [ assessed( true, 'k2' ) ] ), false );
	assert.equal( met( [ assessed( true ), assessed( false, 'k2' ) ] ), true );
} );

attacks( S, [
	{ name: 'an assessment whose verdict is the text "no" is not a yes', value: 'no' },
	{ name: 'an assessment whose verdict is the text "false" is not a yes', value: 'false' },
	{ name: 'an assessment whose verdict is an object is not a yes', value: { met: false } },
], ( { value } ) => {
	assert.equal( met( [ assessed( value ) ] ), false );
} );

attacks( S, [
	{ name: 'an assessment without a verdict is no yes', value: undefined },
	{ name: 'an assessment with verdict null is no yes', value: null },
	{ name: 'an assessment with verdict 0 is no yes', value: 0 },
], ( { value } ) => {
	assert.equal( met( [ assessed( value ) ] ), false );
} );

attack( S, 'the evidence is the latest assessment; without one the reason says so', () => {
	const _last = assessed( false );
	assert.deepEqual( make( 'soft', VALUES ).check( [ assessed( true ), _last ] ), { met: false, evidence: [ _last.id ], reason: '' } );
	assert.equal( make( 'soft', VALUES ).check( [] ).reason, 'not assessed yet' );
} );

attack( S, 'the fact the closing reviewer writes (derivation, met as a boolean) is what it reads', () => {
	const _review = { id: 'r1', kind: 'soft_assessed', evidenceClass: 'derivation', source: 'reviewer', origin: 'reviewer', data: { criterion: 's1', met: true } };
	assert.equal( registry.create( { id: 's1', type: 'soft', values: VALUES } ).check( [ _review ] ).met, true );
} );

attack( S, 'a contract turns its soft texts into soft criteria s1, s2 of the client', () => {
	const _contract = contract( [ 'friendly', 'short' ] );
	assert.deepEqual( _contract.softs().map( item => [ item.id, item.values.text, item.origin, item.kind ] ),
		[ [ 's1', 'friendly', 'client', 'soft' ], [ 's2', 'short', 'client', 'soft' ] ] );
} );

attack( S, '14: the hard core never contains a soft criterion, whatever the reviewer said', () => {
	const _contract = contract( [ 'friendly' ] );
	const _check = _contract.check( [ assessed( false, 's1' ) ] );
	assert.deepEqual( _check.map( item => item.id ), [ 'k1' ] );
} );

attack( S, '14: a soft criterion never closes alone, a goal of only soft criteria is refused at G1', () => {
	const _problems = new ContractCheck().check( contract( [ 'nice' ], [] ), { now: ms( '2026-11-03T00:00:00Z' ) } ).problems;
	assert.match( _problems.join(), /no outcome criterion/ );
} );

attack( S, 'the person confirms the soft texts: the contract hash binds them', () => {
	assert.notEqual( contract( [ 'friendly' ] ).hash, contract( [ 'friendly!' ] ).hash );
	assert.deepEqual( contract( [ 'friendly' ] ).canonical().soft, [ 'friendly' ] );
} );

attack( S, 'two soft criteria are assessed independently', () => {
	const _contract = contract( [ 'friendly', 'short' ] );
	const _facts = [ assessed( true, 's1' ), assessed( false, 's2' ) ];
	assert.deepEqual( _contract.softs().map( item => item.check( _facts ).met ), [ true, false ] );
} );

attack( S, 'it is offered to the drafter as a soft kind that only needs a text, and it derives no rules', () => {
	const _entry = registry.list().find( entry => entry.type === 'soft' );
	assert.equal( _entry.kind, 'soft' );
	assert.deepEqual( Object.keys( _entry.params ), [ 'text' ] );
	assert.deepEqual( registry.types.soft.EVIDENCE, [ 'soft_assessed' ] );
	assert.deepEqual( [ make( 'soft', VALUES ).gateRules(), make( 'soft', VALUES ).flowRules(), make( 'soft', VALUES ).allows() ], [ [], [], [] ] );
} );

attacks( S, hostile( 'strings' ).filter( item => item.value.trim() ).slice( 12, 24 )
	.map( item => ( { ...item, name: `the hostile wish ${item.label} is only text: valid, kept verbatim, changes no rule` } ) ), ( { value } ) => {
	const _item = make( 'soft', { text: value } );
	assert.deepEqual( _item.validate(), [] );
	assert.equal( _item.describe().values.text, value );
	assert.deepEqual( _item.gateRules(), [] );
	assert.equal( _item.check( [ assessed( true ) ] ).met, true );
} );

attacks( S, [
	{ name: 'validate: a missing text is refused', values: {}, want: /text is missing/ },
	{ name: 'validate: an empty text is refused', values: { text: '' }, want: /text is missing/ },
	{ name: 'validate: a text given as a list is refused', values: { text: [ 'friendly' ] }, want: /text must be text/ },
], ( { values, want } ) => {
	assert.match( make( 'soft', values ).validate().join(), want );
} );
