// core/criteria/commitmentreceived.js (zusage_erhalten, 14.1, B5): the party's claim with its fixed fields, plus the
// system's own observation that nothing contradicted it until the deadline. A counter-proposal or a withdrawal
// makes it impossible. Attacks: wrong party, subject, window, class; observe() and check() disagreeing; withdrawals.
import { AT, ContractCheck, Contract, DEADLINE, WINDOW, assert, attack, attacks, fact, make, ms, registry, shift } from './kit.mjs';
import { outcomeSuite } from './suites.mjs';

const S = 'core/criteria/commitmentreceived.js';
const VALUES = { from: 'contact:4711', subject: 'meeting', window: WINDOW };
const IN = '2026-11-10T10:00:00.000Z';
const claim = ( data = {}, extra = {} ) => fact( 'commitment', { party: 'contact:4711', subject: 'meeting', at: IN, ...data }, 'claim', extra );
const quiet = ( of, extra = {} ) => fact( 'no_contradiction', { commitment: of.id }, 'observation', extra );
const refusal = ( kind, data = {} ) => fact( kind, { party: 'contact:4711', subject: 'meeting', ...data }, 'claim' );
const item = ( extra = {} ) => make( 'commitment_received', VALUES, { deadline: DEADLINE, ...extra } );
const before = ms( AT );
const after = ms( DEADLINE ) + 1;

outcomeSuite( S, {
	type: 'commitment_received', values: VALUES, refused: [ 'derivation', 'confirmation' ],
	good: () => {
		const _claim = claim();
		return [ _claim, quiet( _claim ) ];
	},
} );

attack( S, 'B5: the claim alone does not prove it was not withdrawn', () => {
	const _claim = claim();
	const _result = item().check( [ _claim ] );
	assert.equal( _result.met, false );
	assert.deepEqual( _result.evidence, [ _claim.id ] );
	assert.match( _result.reason, /not yet without contradiction/ );
} );

attack( S, 'the system\'s observation without any claim proves nothing', () => {
	assert.equal( item().check( [ quiet( { id: 'f-none' } ) ] ).met, false );
} );

attacks( S, [
	{ name: 'a claim from another party does not count', data: { party: 'contact:4712' } },
	{ name: 'a claim from the party written in another case does not count', data: { party: 'Contact:4711' } },
	{ name: 'a claim about another subject does not count', data: { subject: 'payment' } },
	{ name: 'a claim for 1 ms before the window does not count', data: { at: '2026-11-09T07:59:59.999Z' } },
	{ name: 'a claim for 1 ms after the window does not count', data: { at: '2026-11-13T17:00:00.001Z' } },
	{ name: 'a claim without a time does not count', data: { at: undefined } },
	{ name: 'a claim with an unreadable time ("Wednesday 10 am") does not count', data: { at: 'Wednesday 10 am' } },
], ( { data } ) => {
	const _claim = claim( data );
	assert.equal( item().check( [ _claim, quiet( _claim ) ] ).met, false );
} );

attacks( S, [
	{ name: 'a claim for exactly the window start counts', at: WINDOW[ 0 ] },
	{ name: 'a claim for exactly the window end counts', at: WINDOW[ 1 ] },
	{ name: 'a claim for the window start written at +14:00 counts', at: '2026-11-09T22:00:00+14:00' },
	{ name: 'a claim for the window end written at -12:00 counts', at: '2026-11-13T05:00:00-12:00' },
], ( { at } ) => {
	const _claim = claim( { at } );
	assert.equal( item().check( [ _claim, quiet( _claim ) ] ).met, true );
} );

attack( S, 'B4: a commitment read by an AI without parser match is a derivation, not a claim', () => {
	const _claim = claim( {}, { evidenceClass: 'derivation' } );
	assert.equal( item().check( [ _claim, quiet( _claim ) ] ).met, false );
} );

attack( S, 'B5: a counter-confirmation over the same channel stays a claim and is not the system\'s observation', () => {
	const _claim = claim();
	assert.equal( item().check( [ _claim, quiet( _claim, { evidenceClass: 'claim' } ) ] ).met, false );
} );

attack( S, 'the observation must name exactly this claim', () => {
	const _claim = claim();
	const _other = claim();
	assert.equal( item().check( [ _claim, quiet( _other ) ] ).met, false );
} );

attack( S, 'R1: the observation made at the deadline carries the deadline as its time, and then counts', () => {
	const _claim = claim();
	const _seen = item().observe( [ _claim ], after + 3600000 );
	assert.deepEqual( _seen, { kind: 'no_contradiction', time: DEADLINE, data: { commitment: _claim.id } } );
	assert.equal( item().check( [ _claim, { ..._seen, id: 'f-quiet', evidenceClass: 'observation' } ] ).met, true );
} );

attacks( S, [
	{ name: 'observe: nothing before the deadline', now: ms( DEADLINE ) - 1, extra: {}, seen: false },
	{ name: 'observe: exactly at the deadline it observes', now: ms( DEADLINE ), extra: {}, seen: true },
	{ name: 'observe: without a deadline there is no point to observe at', now: after, extra: { deadline: null }, seen: false },
], ( { now, extra, seen } ) => {
	assert.equal( item( extra ).observe( [ claim() ], now ) !== null, seen );
} );

attack( S, 'observe: nothing to observe without a claim of the party', () => {
	assert.equal( item().observe( [ claim( { party: 'contact:1' } ) ], after ), null );
	assert.equal( item().observe( [], after ), null );
} );

attack( S, 'observe: a counter-proposal stops the observation', () => {
	assert.equal( item().observe( [ claim(), refusal( 'counter_proposal', { at: '2026-11-25T10:00:00Z' } ) ], after ), null );
} );

attack( S, 'observe and check agree on the claim: a first claim outside the window must not take the observation', () => {
	const _outside = claim( { at: '2026-11-25T10:00:00Z' } );
	const _inside = claim();
	const _seen = item().observe( [ _outside, _inside ], after );
	assert.equal( item().check( [ _outside, _inside, { ..._seen, id: 'f-quiet', evidenceClass: 'observation' } ] ).met, true );
} );

attack( S, 'observe with an unreadable deadline returns nothing instead of throwing', () => {
	assert.equal( item( { deadline: 'next week' } ).observe( [ claim() ], after ), null );
} );

attack( S, 'a counter-proposal outside the window makes it impossible already before the deadline', () => {
	const _result = item().verdict( [ claim(), refusal( 'counter_proposal', { at: '2026-11-25T10:00:00Z' } ) ], before );
	assert.equal( _result.impossible, true );
	assert.equal( _result.met, false );
} );

attack( S, 'a counter-proposal still inside the window is no refusal', () => {
	assert.ok( !item().verdict( [ claim(), refusal( 'counter_proposal', { at: '2026-11-12T10:00:00Z' } ) ], before ).impossible );
} );

attack( S, 'a withdrawal without a time makes it impossible', () => {
	assert.equal( item().verdict( [ claim(), refusal( 'commitment_withdrawn' ) ], before ).impossible, true );
} );

attack( S, 'a withdrawal that names the committed time (inside the window) is still a withdrawal', () => {
	assert.equal( item().verdict( [ claim(), refusal( 'commitment_withdrawn', { at: IN } ) ], before ).impossible, true );
} );

attacks( S, [
	{ name: 'a withdrawal by another party changes nothing', data: { party: 'contact:9' } },
	{ name: 'a withdrawal of another subject changes nothing', data: { subject: 'invoice' } },
], ( { data } ) => {
	assert.ok( !item().verdict( [ claim(), refusal( 'commitment_withdrawn', data ) ], before ).impossible );
} );

attack( S, 'a withdrawal before the deadline means it was withdrawn, even next to an observation of no contradiction', () => {
	const _claim = claim();
	const _withdrawn = { ...refusal( 'commitment_withdrawn' ), time: shift( DEADLINE, -60000 ) };
	assert.equal( item().verdict( [ _claim, quiet( _claim, { time: DEADLINE } ), _withdrawn ], after ).met, false );
} );

attack( S, 'observe: a withdrawal of the committed slot before the deadline stops the observation of "no contradiction"', () => {
	const _claim = claim();
	const _withdrawn = refusal( 'commitment_withdrawn', { at: IN } );
	assert.equal( item().observe( [ _claim, _withdrawn ], after ), null );
} );

attack( S, 'a withdrawal after the deadline does not undo it: it proves receipt, not that it still holds', () => {
	const _claim = claim();
	const _late = { ...refusal( 'commitment_withdrawn' ), time: shift( DEADLINE, 60000 ) };
	assert.equal( item().verdict( [ _claim, quiet( _claim, { time: DEADLINE } ), _late ], after ).met, true );
} );

attack( S, 'of two claims the one inside the window is matched with its observation', () => {
	const _outside = claim( { at: '2026-11-25T10:00:00Z' } );
	const _inside = claim();
	assert.equal( item().check( [ _outside, _inside, quiet( _inside ) ] ).met, true );
} );

attack( S, 'E5: the newer claim replaces a superseded one', () => {
	const _old = claim( { at: '2026-11-25T10:00:00Z' }, { superseded: true } );
	const _new = claim();
	assert.equal( item().check( [ _old, _new, quiet( _new ) ] ).met, true );
	assert.equal( item().check( [ { ..._new, superseded: true }, quiet( _new ) ] ).met, false );
} );

attack( S, 'K2: its window may end after its own deadline, and it says so; its evidence kinds name both facts', () => {
	const _Type = registry.types.commitment_received;
	assert.equal( _Type.WINDOW_AFTER_DEADLINE, true );
	assert.deepEqual( _Type.EVIDENCE, [ 'commitment', 'no_contradiction' ] );
	const _contract = new Contract( { id: 'c', goal: 'g', deadline: '2026-11-20T00:00:00Z', budget: 9,
		criteria: [ { id: 'k1', type: 'commitment_received', values: VALUES, deadline: DEADLINE } ] }, registry );
	const _problems = new ContractCheck().check( _contract, { now: ms( '2026-11-03T00:00:00Z' ) } ).problems;
	assert.ok( !_problems.some( text => /k1: its window ends after/.test( text ) ), _problems.join() );
} );

attacks( S, [
	{ name: 'validate: a window that ends before it starts is refused (K2)', values: { ...VALUES, window: [ WINDOW[ 1 ], WINDOW[ 0 ] ] }, want: /K2/ },
	{ name: 'validate: a missing window is refused', values: { from: 'p', subject: 's' }, want: /window is missing/ },
	{ name: 'validate: a party given as a number is refused', values: { ...VALUES, from: 4711 }, want: /from must be text/ },
	{ name: 'validate: a subject given as a list is refused', values: { ...VALUES, subject: [ 'meeting' ] }, want: /subject must be text/ },
], ( { values, want } ) => {
	assert.match( make( 'commitment_received', values ).validate().join(), want );
} );
