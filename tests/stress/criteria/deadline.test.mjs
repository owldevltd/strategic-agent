// core/criteria/deadline.js: set by the system, never by the drafter; its gate rule makes every permission expire on
// its own (G-1b), even with the core down. Attacks: boundaries, the verdict's own time, unreadable or rolled-over
// times, zones and DST, and the expiry the gate derives from it.
import { AT, Contract, DEADLINE, Rules, assert, attack, attacks, fact, gate, corpus, hostile, inZone, make, ms, registry } from './kit.mjs';

const S = 'core/criteria/deadline.js';
const at = text => make( 'deadline', { at: text } );
const BUFFER = 5 * 60000;

attacks( S, [
	{ name: 'well before the time it holds', now: ms( DEADLINE ) - 86400000, want: true },
	{ name: 'exactly at the time it still holds', now: ms( DEADLINE ), want: true },
	{ name: '1 ms after the time it no longer holds', now: ms( DEADLINE ) + 1, want: false },
	{ name: 'a year after the time it no longer holds', now: ms( DEADLINE ) + 365 * 86400000, want: false },
], ( { now, want } ) => {
	const _result = at( DEADLINE ).check( [], now );
	assert.equal( _result.met, want );
	assert.equal( _result.reason, want ? '' : 'deadline passed' );
	assert.deepEqual( _result.evidence, [] );
} );

attack( S, 'facts change nothing: neither a confirmation nor a forged "deadline extended" fact', () => {
	const _facts = [ fact( 'deadline_extended', { at: '2099-01-01T00:00:00Z' } ), fact( 'confirmation', { criterion: 'k1', choice: 'yes' }, 'confirmation' ) ];
	assert.equal( at( DEADLINE ).check( _facts, ms( DEADLINE ) + 1 ).met, false );
} );

attack( S, 'check ignores even a facts list that is not a list', () => {
	assert.equal( at( DEADLINE ).check( null, ms( AT ) ).met, true );
} );

attacks( S, [
	{ name: 'verdict judges at the verdict\'s time: after the time it is broken', when: ms( '2031-01-01T00:00:00Z' ), at: '2030-01-01T00:00:00Z', want: false },
	{ name: 'verdict judges at the verdict\'s time: before the time it holds', when: ms( '2019-01-01T00:00:00Z' ), at: '2020-01-01T00:00:00Z', want: true },
], ( { when, at: time, want } ) => {
	assert.equal( at( time ).verdict( [], when ).met, want );
} );

attack( S, 'contract.check at a given time uses that time for the deadline too', () => {
	const _contract = new Contract( { id: 'c', goal: 'g', deadline: DEADLINE, criteria: [ { id: 'k1', type: 'deadline', values: { at: '2030-01-01T00:00:00Z' } } ] }, registry );
	assert.equal( _contract.check( [], ms( '2031-01-01T00:00:00Z' ) )[ 0 ].met, false );
} );

attack( S, 'it is internal: known to the registry, never offered to the drafter', () => {
	assert.equal( registry.types.deadline.INTERNAL, true );
	assert.ok( registry.has( 'deadline' ) );
	assert.ok( !registry.list().some( entry => entry.type === 'deadline' ) );
	assert.equal( at( DEADLINE ).kind, 'invariant' );
} );

attack( S, 'its gate rule makes every action expire at its time', () => {
	assert.deepEqual( at( DEADLINE ).gateRules(), [ { rule: 'expires', actions: [ '*' ], at: DEADLINE } ] );
	assert.deepEqual( [ at( DEADLINE ).flowRules(), at( DEADLINE ).allows() ], [ [], [] ] );
} );

attack( S, 'with a deadline criterion the contract adds no second expiry of its own', () => {
	const _contract = new Contract( { id: 'c', goal: 'g', deadline: DEADLINE, criteria: [ { id: 'k1', type: 'deadline', values: { at: AT } } ] }, registry );
	assert.deepEqual( _contract.rules().gate.filter( rule => rule.rule === 'expires' ).map( rule => [ rule.at, rule.criterion ] ), [ [ AT, 'k1' ] ] );
} );

attacks( S, [
	{ name: 'gate: a report before the time goes through the expiry rule', now: ms( AT ), refused: false },
	{ name: 'gate: within the buffer after the time it still goes through', now: ms( AT ) + BUFFER, refused: false },
	{ name: 'gate: 1 ms after time plus buffer it is refused as expired', now: ms( AT ) + BUFFER + 1, refused: true },
], ( { now, refused } ) => {
	const _result = gate( [ { id: 'k1', type: 'deadline', values: { at: AT } } ], { action: 'report' }, { now } );
	assert.equal( _result.rules.includes( 'expires' ), refused );
} );

attack( S, 'gate: of two deadlines the earlier one ends every permission', () => {
	const _criteria = [ { id: 'k1', type: 'deadline', values: { at: DEADLINE } }, { id: 'k2', type: 'deadline', values: { at: AT } } ];
	const _result = gate( _criteria, { action: 'payment', params: { amount: 1 } }, { now: ms( AT ) + BUFFER + 1 } );
	assert.ok( _result.rules.includes( 'expires' ) );
} );

attacks( S, [
	{ name: 'validate: a missing time is refused', value: undefined, ok: false },
	{ name: 'validate: "tomorrow" is refused', value: 'tomorrow', ok: false },
	{ name: 'validate: an epoch number is refused', value: ms( DEADLINE ), ok: false },
	{ name: 'validate: an ISO time with zone passes', value: '2026-11-06T12:00:00+01:00', ok: true },
	{ name: 'validate: the last representable instant passes', value: '+275760-09-13T00:00:00.000Z', ok: true },
	{ name: 'validate: 30 February is refused, not rolled over to 2 March', value: '2026-02-30T12:00:00Z', ok: false },
	{ name: 'validate: the text "12" is no time (Date.parse reads it as December 2001)', value: '12', ok: false },
	{ name: 'validate: a list holding a time is refused', value: [ DEADLINE ], ok: false },
	{ name: 'validate: a Symbol is refused without a TypeError', value: Symbol( 'at' ), ok: false },
], ( { value, ok } ) => {
	assert.equal( at( value ).validate().length === 0, ok );
} );

attacks( S, hostile( 'dates' ).map( item => ( { ...item, name: `the hostile time ${item.label} is refused or means one exact instant` } ) ), ( { value } ) => {
	const _item = at( value );
	if ( _item.validate().length ) { return; }
	const _instant = ms( value );
	assert.ok( !Number.isNaN( _instant ) );
	assert.equal( _item.check( [], _instant ).met, true );
	assert.equal( _item.check( [], _instant + 1 ).met, false );
} );

attack( S, 'a rolled-over time does not silently move the deadline two days', () => {
	const _item = at( '2026-02-30T12:00:00Z' );
	assert.ok( _item.validate().length > 0 || _item.check( [], ms( '2026-03-01T12:00:00Z' ) ).met === false );
} );

attack( S, 'the same time written in +14:00 and -12:00 is the same deadline', () => {
	const _east = at( '2026-11-07T02:00:00+14:00' );
	const _west = at( '2026-11-06T00:00:00-12:00' );
	for ( const now of [ ms( DEADLINE ) - 1, ms( DEADLINE ), ms( DEADLINE ) + 1 ] ) {
		assert.equal( _east.check( [], now ).met, _west.check( [], now ).met );
	}
} );

attack( S, 'a time with an explicit zone gives the same verdict in every process time zone', () => {
	const _now = ms( DEADLINE ) + 1;
	const _in = zone => inZone( zone, () => at( '2026-11-06T13:00:00+01:00' ).check( [], _now ).met );
	assert.deepEqual( [ 'UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Kathmandu' ].map( _in ), [ false, false, false, false ] );
} );

attack( S, 'a time without a zone is refused, or means the same instant in core and gate whatever their zone', () => {
	const _now = ms( '2026-11-06T06:00:00Z' );
	const _in = zone => inZone( zone, () => {
		const _item = at( '2026-11-06T12:00' );
		return _item.validate().length ? 'refused' : _item.check( [], _now ).met;
	} );
	const _east = _in( 'Pacific/Kiritimati' );
	assert.ok( _east === 'refused' || _east === _in( 'Pacific/Pago_Pago' ) );
} );

attack( S, 'DST spring: 02:30 local on the switch day, written with its offset, is exact', () => {
	const _item = at( '2026-03-29T03:30:00+02:00' );
	assert.equal( inZone( 'Europe/Berlin', () => _item.check( [], ms( '2026-03-29T01:30:00Z' ) ).met ), true );
	assert.equal( inZone( 'Europe/Berlin', () => _item.check( [], ms( '2026-03-29T01:30:00.001Z' ) ).met ), false );
} );

attack( S, 'DST autumn: the repeated hour, told apart by its offset, gives two different deadlines', () => {
	const _first = at( '2026-10-25T02:30:00+02:00' );
	const _second = at( '2026-10-25T02:30:00+01:00' );
	const _between = ms( '2026-10-25T01:00:00Z' );
	assert.deepEqual( [ _first.check( [], _between ).met, _second.check( [], _between ).met ], [ false, true ] );
} );

attack( S, 'strictness: the same deadline is as strict as itself', () => {
	assert.equal( at( DEADLINE ).atLeastAsStrict( at( DEADLINE ) ), true );
} );

attack( S, 'strictness: the same instant written with another offset is the same deadline, not a contradiction', () => {
	assert.equal( at( DEADLINE ).atLeastAsStrict( at( '2026-11-06T13:00:00+01:00' ) ), true );
} );

attacks( S, corpus( 'numbers' ).map( item => ( {
	...item, name: `validate: the ${item.label} is no date and time`,
} ) ), ( { value } ) => {
	assert.ok( at( value ).validate().length > 0 );
} );

attacks( S, [ 'report', 'reply', 'invite', 'payment' ].map( action => ( { name: `gate: after time and buffer even a ${action} is refused as expired`, action } ) ),
	( { action } ) => {
		const _result = gate( [ { id: 'k1', type: 'deadline', values: { at: AT } } ], { action, params: { amount: 1, invoiceId: 'r-1' } },
			{ now: ms( AT ) + BUFFER + 1 } );
		assert.ok( _result.rules.includes( 'expires' ) );
	} );

attack( S, 'gate: the expiry of every permission is the earliest deadline plus the buffer', () => {
	const _contract = new Contract( { id: 'c', goal: 'g', deadline: DEADLINE, criteria: [ { id: 'k1', type: 'deadline', values: { at: AT } } ] }, registry );
	const _rules = new Rules( {}, { bufferMinutes: 5 } );
	assert.equal( _rules.expiresAt( { rules: _contract.rules() } ), new Date( ms( AT ) + BUFFER ).toISOString() );
} );

attack( S, 'its own "bis" does not shorten it: before its time it holds, whatever its bis says', () => {
	const _item = make( 'deadline', { at: '2999-01-01T00:00:00Z' }, { deadline: '2020-01-01T00:00:00Z' } );
	assert.equal( _item.verdict( [], ms( '2021-01-01T00:00:00Z' ) ).met, true );
} );

attack( S, 'check without a time uses the wall clock', () => {
	assert.equal( at( '2999-01-01T00:00:00Z' ).check( [] ).met, true );
	assert.equal( at( '2001-01-01T00:00:00Z' ).check( [] ).met, false );
} );

attack( S, 'describe() shows the time exactly as given', () => {
	assert.deepEqual( at( DEADLINE ).describe().values, { at: DEADLINE } );
	assert.equal( at( DEADLINE ).describe().kind, 'invariant' );
} );
