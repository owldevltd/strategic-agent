// core/criteria/confirmedby.js (bestaetigt_durch, 14.1, 3.4): the role said yes to exactly this question, known to a
// fact only by the question's hash. Attacks: other roles, other questions, near-miss answers, free text, classes.
import { ConfirmedBy, assert, attack, attacks, fact, hostile, make, random, registry } from './kit.mjs';
import { outcomeSuite } from './suites.mjs';

const S = 'core/criteria/confirmedby.js';
const QUESTION = 'Is the delivery from supplier X complete?';
const VALUES = { role: 'client', question: QUESTION };
const answer = ( data = {}, extra = {} ) => fact( 'confirmation', { role: 'client', question: ConfirmedBy.key( QUESTION ), choice: 'yes', ...data }, 'confirmation', extra );
const met = ( facts, values = VALUES ) => make( 'confirmed_by', values ).check( facts ).met;

outcomeSuite( S, { type: 'confirmed_by', values: VALUES, good: () => [ answer() ], refused: [ 'derivation', 'claim', 'observation' ] } );

attack( S, 'key(): 16 hex characters, the same for the same question', () => {
	assert.match( ConfirmedBy.key( QUESTION ), /^[0-9a-f]{16}$/ );
	assert.equal( ConfirmedBy.key( QUESTION ), ConfirmedBy.key( `${QUESTION}` ) );
} );

attacks( S, [
	{ name: 'key(): a trailing space is another question', other: `${QUESTION} ` },
	{ name: 'key(): another case is another question', other: QUESTION.toLowerCase() },
	{ name: 'key(): a question without its question mark is another question', other: QUESTION.slice( 0, -1 ) },
	{ name: 'key(): a question with "not" added is another question', other: 'Is the delivery from supplier X not complete?' },
], ( { other } ) => {
	assert.notEqual( ConfirmedBy.key( other ), ConfirmedBy.key( QUESTION ) );
	assert.equal( met( [ answer( { question: ConfirmedBy.key( other ) } ) ] ), false );
} );

attack( S, 'key(): 5000 random questions give 5000 different keys', () => {
	const _random = random( 42 );
	const _keys = new Set( Array.from( { length: 5000 }, ( _x, i ) => ConfirmedBy.key( `${i}:${_random.string( 20 )}` ) ) );
	assert.equal( _keys.size, 5000 );
} );

attack( S, 'key(): a number and its text are the same question, so the parameter must be text', () => {
	assert.equal( ConfirmedBy.key( 5 ), ConfirmedBy.key( '5' ) );
	assert.match( make( 'confirmed_by', { role: 'client', question: 5 } ).validate().join(), /question must be text/ );
} );

attacks( S, [
	{ name: 'the answer "Yes" is not the choice "yes"', choice: 'Yes' },
	{ name: 'the answer "YES" is not the choice "yes"', choice: 'YES' },
	{ name: 'the answer "y" is not the choice "yes"', choice: 'y' },
	{ name: 'the answer true is not the choice "yes"', choice: true },
	{ name: 'the German "ja" is not the choice "yes"', choice: 'ja' },
	{ name: 'the answer "no" is a no', choice: 'no' },
	{ name: 'no choice at all is no yes', choice: undefined },
	{ name: 'the answer " yes" with a space is not the choice', choice: ' yes' },
], ( { choice } ) => {
	assert.equal( met( [ answer( { choice } ) ] ), false );
} );

attacks( S, [
	{ name: 'a yes from another role does not count', data: { role: 'cfo' } },
	{ name: 'a yes from the role in another case does not count', data: { role: 'Client' } },
	{ name: 'a yes without a role does not count', data: { role: undefined } },
	{ name: 'a yes to the question as free text instead of its key does not count', data: { question: QUESTION } },
	{ name: 'a yes to no question does not count', data: { question: undefined } },
], ( { data } ) => {
	assert.equal( met( [ answer( data ) ] ), false );
} );

attack( S, 'a yes for the criterion (K4) is no yes of the role to this question', () => {
	const _k4 = fact( 'confirmation', { criterion: 'k1', choice: 'yes', role: 'client' }, 'confirmation' );
	assert.equal( met( [ _k4 ] ), false );
	assert.equal( make( 'confirmed_by', VALUES, { byPerson: true } ).verdict( [ _k4 ] ).met, true );
} );

attack( S, 'the fact the person\'s ticket answer produces (executor shape) meets it', () => {
	const _ticket = fact( 'confirmation', { criterion: null, role: 'client', question: ConfirmedBy.key( QUESTION ), choice: 'yes' }, 'confirmation',
		{ source: 'person lead' } );
	const _result = make( 'confirmed_by', VALUES ).check( [ _ticket ] );
	assert.deepEqual( _result, { met: true, evidence: [ _ticket.id ], reason: '' } );
} );

attack( S, 'the reason names the role that has not confirmed yet', () => {
	assert.equal( make( 'confirmed_by', { role: 'cfo', question: QUESTION } ).check( [] ).reason, 'not confirmed by cfo' );
} );

attack( S, 'of a no and a yes from the role, the yes is the evidence', () => {
	const _yes = answer();
	const _result = make( 'confirmed_by', VALUES ).check( [ answer( { choice: 'no' } ), _yes ] );
	assert.deepEqual( _result.evidence, [ _yes.id ] );
} );

attack( S, 'two criteria with other questions are not met by one yes', () => {
	const _yes = answer();
	assert.equal( met( [ _yes ] ), true );
	assert.equal( met( [ _yes ], { role: 'client', question: 'Is the invoice correct?' } ), false );
} );

attacks( S, hostile( 'strings' ).filter( item => item.value.trim() ).slice( 0, 12 ).map( item => ( { ...item, name: `a hostile question ${item.label} is only hashed: met by its own key alone` } ) ),
	( { value } ) => {
		const _values = { role: 'client', question: value };
		assert.deepEqual( make( 'confirmed_by', _values ).validate(), [] );
		assert.equal( met( [ answer( { question: ConfirmedBy.key( value ) } ) ], _values ), true );
		assert.equal( met( [ answer( { question: value } ) ], _values ), false );
	} );

attacks( S, [
	{ name: 'validate: a missing role is refused', values: { question: QUESTION }, want: /role is missing/ },
	{ name: 'validate: an empty question is refused', values: { role: 'client', question: '' }, want: /question is missing/ },
	{ name: 'validate: a role given as a list is refused', values: { role: [ 'client' ], question: QUESTION }, want: /role must be text/ },
], ( { values, want } ) => {
	assert.match( make( 'confirmed_by', values ).validate().join(), want );
} );

attack( S, 'its evidence kind is the confirmation a person gives, so a person is always a channel (K4)', () => {
	assert.deepEqual( registry.types.confirmed_by.EVIDENCE, [ 'confirmation' ] );
	assert.equal( make( 'confirmed_by', VALUES ).kind, 'outcome' );
} );
