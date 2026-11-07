// core/criteria/criterion.js, part 2: the base class every type inherits: construction, the facts that count (B2,
// own deadline), verdict and U4, the person as channel (K4), the gate's receipts, describe(), the default
// strictness, and time zones.
import {
	AT, Criterion, DEADLINE, EXPIRED, VALID, assert, attack, attacks, fact, inZone, make, ms, receipt, registry, shift, yes,
} from './kit.mjs';

const S = 'core/criteria/criterion.js';

class Open extends Criterion {

	static TYPE = 'open';

	check( facts ) {
		return { met: facts.some( item => item.kind === 'done' ), evidence: [], reason: '', impossible: facts.some( item => item.kind === 'never' ) };
	}

}

const base = spec => new Criterion( { id: 'k1', type: 'criterion', ...spec } );

attacks( S, [
	{ name: 'a spec without values gets empty values', spec: {}, field: 'values', want: {} },
	{ name: 'values null become empty values', spec: { values: null }, field: 'values', want: {} },
	{ name: 'without a deadline the deadline is null', spec: {}, field: 'deadline', want: null },
	{ name: 'an empty deadline is no deadline', spec: { deadline: '' }, field: 'deadline', want: null },
	{ name: 'the origin defaults to the client (layer 1)', spec: {}, field: 'origin', want: 'client' },
	{ name: 'serves defaults to null', spec: {}, field: 'serves', want: null },
	{ name: 'immutable is a boolean even from text', spec: { immutable: 'yes' }, field: 'immutable', want: true },
	{ name: 'immutable 0 is false', spec: { immutable: 0 }, field: 'immutable', want: false },
	{ name: 'byPerson is a boolean even from 1', spec: { byPerson: 1 }, field: 'byPerson', want: true },
], ( { spec, field, want } ) => {
	assert.deepEqual( base( spec )[ field ], want );
} );

attack( S, 'the kind is the subclass\'s KIND, not the base default', () => {
	assert.equal( base( {} ).kind, 'outcome' );
	assert.equal( make( 'soft', { text: 't' } ).kind, 'soft' );
	assert.equal( make( 'min_group', { k: 5 } ).kind, 'invariant' );
} );

attack( S, 'the base class proves nothing, derives no rules and admits no commitment', () => {
	const _item = base( {} );
	assert.deepEqual( _item.check( [ fact( 'done', {} ) ] ), { met: false, evidence: [], reason: 'no evidence predicate' } );
	assert.deepEqual( [ _item.flowRules(), _item.gateRules(), _item.allows() ], [ [], [], [] ] );
	assert.equal( _item.admits( 'payment' ), false );
	assert.deepEqual( _item.validate(), [] );
} );

attack( S, 'evidence(): superseded facts and facts past their validity drop out (B2)', () => {
	const _keep = fact( 'x', {} );
	const _list = [ _keep, fact( 'x', {}, 'observation', { superseded: true } ), fact( 'x', {}, 'observation', { validUntil: EXPIRED } ) ];
	assert.deepEqual( base( {} ).evidence( _list ), [ _keep ] );
} );

attack( S, 'evidence(): a fact valid into the future stays', () => {
	assert.equal( base( {} ).evidence( [ fact( 'x', {}, 'observation', { validUntil: VALID } ) ] ).length, 1 );
} );

attack( S, 'evidence(): a fact after the own deadline drops out; one exactly at it stays', () => {
	const _item = base( { deadline: AT } );
	assert.equal( _item.evidence( [ fact( 'x', {} ) ] ).length, 1 );
	assert.equal( _item.evidence( [ fact( 'x', {}, 'observation', { time: shift( AT, 1 ) } ) ] ).length, 0 );
} );

attack( S, 'evidence(): without a deadline even a fact from the year 9999 counts', () => {
	assert.equal( base( {} ).evidence( [ fact( 'x', {}, 'observation', { time: '9999-12-31T23:59:59Z' } ) ] ).length, 1 );
} );

attack( S, 'B2 is judged at the verdict\'s time: a person\'s yes valid until 2030 does not count in a verdict for 2031', () => {
	const _yes = yes( 'k1', { validUntil: '2030-01-01T00:00:00Z' } );
	assert.equal( new Open( { id: 'k1', byPerson: true } ).verdict( [ _yes ], ms( '2031-01-01T00:00:00Z' ) ).met, false );
} );

attack( S, 'deliveries(): only observed receipts of matching actions', () => {
	const _report = receipt( 'report' );
	const _list = [ _report, receipt( 'payment' ), { ..._report, id: 'c', evidenceClass: 'claim' }, { ..._report, id: 'k', kind: 'sent' } ];
	assert.deepEqual( Criterion.deliveries( _list, action => action === 'report' ), [ _report ] );
} );

attack( S, 'deliveries(): a receipt without data is skipped, not a TypeError that stops every invariant', () => {
	const _broken = { id: 'b', kind: 'delivered', evidenceClass: 'observation', source: 'gate' };
	assert.deepEqual( Criterion.deliveries( [ _broken, receipt( 'report' ) ], () => true ).length, 1 );
} );

attack( S, 'verdict: an open criterion with an empty reason gets a clean "its deadline has passed"', () => {
	const _result = new Open( { id: 'k1', deadline: DEADLINE } ).verdict( [], ms( DEADLINE ) + 1 );
	assert.equal( _result.reason, 'its deadline has passed' );
	assert.equal( _result.impossible, true );
} );

attack( S, 'verdict: an impossibility the type reports itself is kept before the deadline', () => {
	const _result = new Open( { id: 'k1', deadline: DEADLINE } ).verdict( [ fact( 'never', {} ) ], ms( AT ) );
	assert.equal( _result.impossible, true );
	assert.equal( _result.met, false );
} );

attack( S, 'verdict: an unreadable own deadline neither throws nor ends the criterion', () => {
	const _result = new Open( { id: 'k1', deadline: 'next week' } ).verdict( [], ms( VALID ) );
	assert.equal( _result.met, false );
	assert.ok( !_result.impossible );
} );

attack( S, 'verdict K4: the person\'s yes is its own reason and its only evidence', () => {
	const _yes = yes();
	const _result = new Open( { id: 'k1', byPerson: true } ).verdict( [ fact( 'done', {} ), _yes ] );
	assert.deepEqual( _result, { met: true, evidence: [ _yes.id ], reason: 'confirmed by a person (K4)' } );
} );

attack( S, 'verdict K4: a superseded or expired yes does not count (B2)', () => {
	const _item = new Open( { id: 'k1', byPerson: true } );
	assert.equal( _item.verdict( [ yes( 'k1', { superseded: true } ) ] ).met, false );
	assert.equal( _item.verdict( [ yes( 'k1', { validUntil: EXPIRED } ) ] ).met, false );
} );

attack( S, 'describe() names exactly what a person confirms about a criterion', () => {
	const _item = make( 'min_group', { k: 5 }, { deadline: DEADLINE, origin: 'agent', serves: 'k0', immutable: true } );
	assert.deepEqual( _item.describe(), {
		id: 'k1', type: 'min_group', kind: 'invariant', values: { k: 5 }, immutable: true, deadline: DEADLINE, origin: 'agent', serves: 'k0', byPerson: false,
	} );
} );

attacks( S, [
	{ name: 'default strictness: equal values are as strict', a: { action: 'payment', key: 'invoiceId' }, b: { action: 'payment', key: 'invoiceId' }, want: true },
	{ name: 'default strictness: other values are not', a: { action: 'payment', key: 'invoiceId' }, b: { action: 'payment', key: 'supplier' }, want: false },
	{ name: 'default strictness: the same values in another key order are as strict', a: { action: 'payment', key: 'invoiceId' },
		b: { key: 'invoiceId', action: 'payment' }, want: true },
	{ name: 'default strictness: an extra unknown value makes it differ', a: { action: 'payment', key: 'invoiceId', note: 'x' },
		b: { action: 'payment', key: 'invoiceId' }, want: false },
], ( { a, b, want } ) => {
	assert.equal( make( 'exactly_once', a ).atLeastAsStrict( make( 'exactly_once', b ) ), want );
} );

attack( S, 'a deadline with an explicit zone gives the same verdict in UTC+14 and UTC-11', () => {
	const _verdict = () => make( 'report_delivered', { to: 'hr', topic: 't' }, { deadline: '2026-11-06T12:00:00+01:00' } )
		.verdict( [], ms( '2026-11-06T11:00:00.001Z' ) ).impossible;
	assert.equal( inZone( 'Pacific/Kiritimati', _verdict ), true );
	assert.equal( inZone( 'Pacific/Pago_Pago', _verdict ), true );
} );

attack( S, 'a deadline without a zone means one instant everywhere, or is refused; never one per process time zone', () => {
	const _run = () => {
		const _item = make( 'report_delivered', { to: 'hr', topic: 't' }, { deadline: '2026-11-06T12:00' } );
		return { refused: _item.validate().length > 0 || Number.isNaN( ms( _item.deadline ) ), late: _item.verdict( [], ms( '2026-11-06T06:00:00Z' ) ).impossible === true };
	};
	const _east = inZone( 'Pacific/Kiritimati', _run );
	const _west = inZone( 'Pacific/Pago_Pago', _run );
	assert.ok( _east.refused || _east.late === _west.late, `UTC+14 says late=${_east.late}, UTC-11 says late=${_west.late}` );
} );

attack( S, 'DST: a window over the autumn switch, written with offsets, contains the repeated hour exactly once', () => {
	const _window = [ '2026-10-25T02:30:00+02:00', '2026-10-25T02:30:00+01:00' ];
	assert.equal( Criterion.window( _window ), null );
	assert.equal( ms( _window[ 1 ] ) - ms( _window[ 0 ] ), 3600000 );
	assert.equal( inZone( 'Europe/Berlin', () => Criterion.inWindow( '2026-10-25T01:00:00Z', _window ) ), true );
	assert.equal( inZone( 'Europe/Berlin', () => Criterion.inWindow( '2026-10-25T01:30:00.001Z', _window ) ), false );
} );

attack( S, 'DST: a deadline in the spring gap, written with an offset, is an exact instant in every zone', () => {
	const _late = () => make( 'deadline', { at: '2026-03-29T02:30:00+01:00' } ).check( [], ms( '2026-03-29T01:30:00.001Z' ) ).met;
	assert.equal( inZone( 'Europe/Berlin', _late ), false );
	assert.equal( inZone( 'America/New_York', _late ), false );
} );

attack( S, 'U4 keeps the evidence and the reason of the open check and adds the passed deadline', () => {
	const _low = fact( 'measured', { quantity: 'q', value: 3 } );
	const _result = make( 'number_in_range', { quantity: 'q', min: 5 }, { deadline: DEADLINE } ).verdict( [ _low ], ms( DEADLINE ) + 1 );
	assert.deepEqual( _result.evidence, [ _low.id ] );
	assert.equal( _result.reason, 'q is 3; its deadline has passed' );
	assert.equal( registry.create( { id: 'k1', type: 'number_in_range', values: { quantity: 'q', min: 5 } } ).verdict( [ _low ] ).impossible, undefined );
} );
