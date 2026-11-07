// core/contract/contract.js, part 2: amendments by ticket (3.2, G-10), the immutables G1 and G6 compare, the rules the
// gate stores, and the check of the hard core. An amendment must never touch an immutable criterion unnoticed, and
// the rules must follow from the hashed spec alone.
import assert from 'node:assert/strict';
import { attack } from '../hostile.mjs';
import { registry, Contract, ContractCheck, goal, goalSpec, inHours, invoices } from './fixtures.mjs';

const SUBJECT = 'core/contract/contract.js';
const amended = ( contract, change ) => new Contract( contract.amend( change ), registry );
const delivered = ( id, data ) => ( { id, kind: 'delivered', evidenceClass: 'observation', source: 'gate', data: { action: 'report', to: 'hr', ...data } } );

attack( SUBJECT, 'amend merges the new values into the named criterion only', () => {
	const _before = goal();
	const _after = amended( _before, { criterion: 'k1', values: { topic: 'first findings' } } );
	assert.deepEqual( _after.criteria[ 0 ].values, { to: 'hr', topic: 'first findings' } );
	assert.deepEqual( _after.criteria.slice( 1 ).map( item => item.values ), _before.criteria.slice( 1 ).map( item => item.values ) );
} );

attack( SUBJECT, 'an amendment points at the hash of the contract it amends', () => {
	const _before = goal();
	assert.equal( _before.amend( { criterion: 'k1', values: { topic: 'x' } } ).amends, _before.hash );
} );

attack( SUBJECT, 'an amendment keeps id, goal, budget, value, kind, soft wishes and the back-translation', () => {
	const _before = goal( { soft: [ 'calm' ], understood: { task: 't', backTranslation: 'You want a report' } } );
	const _spec = _before.amend( { criterion: 'k1', values: { topic: 'x' } } );
	for ( const field of [ 'id', 'goal', 'budget', 'value', 'kind', 'soft', 'understood' ] ) {
		assert.deepEqual( _spec[ field ], _before.spec[ field ], field );
	}
} );

attack( SUBJECT, 'an amendment with a deadline moves it, one without keeps it', () => {
	const _before = goal();
	const _later = inHours( 60 );
	assert.equal( _before.amend( { criterion: 'k1', values: {}, deadline: _later } ).deadline, _later );
	assert.equal( _before.amend( { criterion: 'k1', values: {} } ).deadline, _before.deadline );
	assert.equal( _before.amend( { criterion: 'k1', values: {}, deadline: '' } ).deadline, _before.deadline );
} );

attack( SUBJECT, 'an amendment naming no existing criterion is refused', () => {
	const _before = goal();
	for ( const criterion of [ 'k9', 'K1', '', 0, {} ] ) {
		assert.throws( () => _before.amend( { criterion, values: { k: 1 } } ), /no criterion of this contract/, JSON.stringify( criterion ) );
	}
	assert.equal( _before.hash, goal().hash, 'the contract itself is untouched' );
} );

attack( SUBJECT, 'an amendment cannot change type, origin, immutable flag or id of a criterion', () => {
	const _before = goal();
	const _after = amended( _before, { criterion: 'k2', values: { k: 5 }, type: 'report_delivered', immutable: false, origin: 'agent', id: 'k9' } );
	const _k2 = _after.criteria.find( item => item.id === 'k2' );
	assert.deepEqual( [ _k2.type, _k2.immutable, _k2.origin ], [ 'min_group', true, 'client' ] );
} );

attack( SUBJECT, 'an amendment never drops or adds a criterion', () => {
	const _before = goal();
	for ( const id of [ 'k1', 'k2', 'k3', undefined ] ) {
		assert.deepEqual( _before.amend( { criterion: id, values: {} } ).criteria.map( item => item.id ), [ 'k1', 'k2', 'k3' ] );
	}
	assert.throws( () => _before.amend( { criterion: 'nope', values: {} } ), /no criterion of this contract/ );
} );

attack( SUBJECT, 'an amendment of the deadline alone names no criterion and changes none', () => {
	const _before = goal();
	const _later = inHours( 60 );
	const _spec = _before.amend( { deadline: _later } );
	assert.deepEqual( _spec.criteria, _before.spec.criteria );
	assert.equal( _spec.deadline, _later );
} );

attack( SUBJECT, 'G-10: changing an immutable criterion by amendment is found', () => {
	const _before = goal();
	const _problems = ContractCheck.amendment( _before, amended( _before, { criterion: 'k2', values: { k: 2 } } ) );
	assert.deepEqual( _problems, [ 'immutable criterion k2 would change (G-10)' ] );
} );

attack( SUBJECT, 'G-10: tightening an immutable criterion is a change as well', () => {
	const _before = goal();
	assert.equal( ContractCheck.amendment( _before, amended( _before, { criterion: 'k3', values: { k: 9 } } ) ).length, 1 );
} );

attack( SUBJECT, 'G-10: restating an immutable criterion with its own values passes', () => {
	const _before = goal();
	assert.deepEqual( ContractCheck.amendment( _before, amended( _before, { criterion: 'k2', values: { k: 5 } } ) ), [] );
} );

attack( SUBJECT, 'a __proto__ key in the new values pollutes no prototype', () => {
	const _before = goal();
	const _after = amended( _before, { criterion: 'k1', values: JSON.parse( '{ "__proto__": { "polluted": true }, "topic": "x" }' ) } );
	assert.equal( {}.polluted, undefined );
	assert.equal( Object.getPrototypeOf( _after.criteria[ 0 ].values ), Object.prototype );
	assert.equal( _after.criteria[ 0 ].values.topic, 'x' );
} );

attack( SUBJECT, 'an amendment without values changes nothing', () => {
	const _before = goal();
	assert.deepEqual( _before.amend( { criterion: 'k1', values: null } ).criteria, _before.spec.criteria );
	assert.deepEqual( _before.amend( { criterion: 'k1' } ).criteria, _before.spec.criteria );
} );

attack( SUBJECT, 'a chain of amendments links every step to the one before', () => {
	const _first = goal();
	const _second = amended( _first, { criterion: 'k1', values: { topic: 'a' } } );
	const _third = amended( _second, { criterion: 'k1', values: { topic: 'b' } } );
	assert.deepEqual( [ _second.spec.amends, _third.spec.amends ], [ _first.hash, _second.hash ] );
	assert.equal( new Set( [ _first.hash, _second.hash, _third.hash ] ).size, 3 );
} );

attack( SUBJECT, 'an amendment leaves the original contract and its hash untouched', () => {
	const _before = goal();
	const _hash = _before.hash;
	const _copy = JSON.stringify( _before.spec );
	_before.amend( { criterion: 'k1', values: { topic: 'other' }, deadline: inHours( 70 ) } );
	assert.equal( _before.hash, _hash );
	assert.equal( JSON.stringify( _before.spec ), _copy );
} );

attack( SUBJECT, 'an amendment to a deadline in the past fails G1', () => {
	const _after = amended( goal(), { criterion: 'k1', values: {}, deadline: inHours( -1 ) } );
	assert.match( new ContractCheck().check( _after ).problems.join(), /contract deadline is in the past/ );
} );

attack( SUBJECT, 'an amendment that moves the deadline before a criterion\'s own deadline fails G1 (K1)', () => {
	const _before = goal( { criteria: [ { ...goalSpec().criteria[ 0 ], deadline: inHours( 30 ) }, ...goalSpec().criteria.slice( 1 ) ] } );
	const _after = amended( _before, { criterion: 'k1', values: {}, deadline: inHours( 10 ) } );
	assert.match( new ContractCheck().check( _after ).problems.join(), /k1: deadline after the contract deadline/ );
} );

attack( SUBJECT, 'a deadline hidden in the new values does not move the contract deadline', () => {
	const _before = goal();
	const _spec = _before.amend( { criterion: 'k1', values: { deadline: inHours( 900 ) } } );
	assert.equal( _spec.deadline, _before.deadline );
} );

// Immutables: what G1 (amendment) and G6 (close) compare.

attack( SUBJECT, 'immutables() lists exactly the immutable criteria, sorted', () => {
	const _list = goal().immutables();
	assert.deepEqual( _list.map( item => JSON.parse( item )[ 0 ] ), [ 'k2', 'k3' ] );
	assert.deepEqual( [ ..._list ].sort(), _list );
} );

attack( SUBJECT, 'immutables() do not depend on the key order of equal values', () => {
	const _deadline = inHours( 5 );
	const _spec = criterion => ( { id: 'x', goal: 'y', deadline: _deadline, criteria: [ criterion ] } );
	const _one = new Contract( _spec( { id: 'k2', type: 'exactly_once', values: { key: 'invoiceId', action: 'payment' }, immutable: true } ), registry );
	const _two = new Contract( _spec( { id: 'k2', type: 'exactly_once', values: { action: 'payment', key: 'invoiceId' }, immutable: true } ), registry );
	assert.equal( _one.hash, _two.hash, 'the hash already treats them as the same contract' );
	assert.deepEqual( ContractCheck.amendment( _one, _two ), [] );
} );

attack( SUBJECT, 'soft wishes and mutable outcomes are never immutables', () => {
	const _list = goal( { soft: [ 'calm' ] } ).immutables().map( item => JSON.parse( item )[ 0 ] );
	assert.equal( _list.includes( 's1' ), false );
	assert.equal( _list.includes( 'k1' ), false );
} );

attack( SUBJECT, 'an immutable outcome is protected like an invariant', () => {
	const _before = goal( { criteria: [ { ...goalSpec().criteria[ 0 ], immutable: true }, ...goalSpec().criteria.slice( 1 ) ] } );
	assert.equal( ContractCheck.amendment( _before, amended( _before, { criterion: 'k1', values: { to: 'ceo' } } ) ).length, 1 );
} );

// Rules: what the gate enforces by itself.

attack( SUBJECT, 'without a deadline criterion the contract deadline yields one expiry rule for every action', () => {
	const _contract = goal();
	const _expires = _contract.rules().gate.filter( rule => rule.rule === 'expires' );
	assert.deepEqual( _expires, [ { rule: 'expires', actions: [ '*' ], at: _contract.deadline, criterion: 'contract' } ] );
} );

attack( SUBJECT, 'a deadline criterion yields the expiry; no second one is added', () => {
	const _at = inHours( 20 );
	const _contract = goal( { criteria: [ ...goalSpec().criteria, { id: 'd1', type: 'deadline', values: { at: _at } } ] } );
	const _expires = _contract.rules().gate.filter( rule => rule.rule === 'expires' );
	assert.deepEqual( _expires.map( rule => [ rule.at, rule.criterion ] ), [ [ _at, 'd1' ] ] );
} );

attack( SUBJECT, 'every rule names the criterion it came from', () => {
	const _rules = invoices.contractSpec();
	const _all = Object.values( new Contract( _rules, registry ).rules() ).flat();
	assert.ok( _all.length > 3 );
	assert.ok( _all.every( rule => typeof rule.criterion === 'string' && rule.criterion.length ) );
} );

attack( SUBJECT, 'the survey goal yields its group rules and allows confidential data only as a group', () => {
	const _rules = goal().rules();
	assert.deepEqual( _rules.gate.map( rule => rule.rule ).sort(), [ 'expires', 'min_group', 'no_difference' ] );
	assert.deepEqual( _rules.allow.map( rule => [ rule.label, rule.as ] ), [ [ 'confidential', 'group' ] ] );
} );

attack( SUBJECT, 'the invoice goal binds the account to our own data and allows nothing confidential to leave', () => {
	const _rules = new Contract( invoices.contractSpec(), registry ).rules();
	assert.ok( _rules.flow.some( rule => rule.param === 'iban' && rule.mustHave.includes( 'own' ) ) );
	assert.deepEqual( _rules.allow, [] );
} );

attack( SUBJECT, 'soft wishes and unknown types yield no rules', () => {
	const _plain = goal().rules();
	const _noisy = goal( { soft: [ 'never mention salaries' ], criteria: [ ...goalSpec().criteria, { id: 'k4', type: 'teleport', values: {} } ] } ).rules();
	assert.deepEqual( _noisy, _plain );
} );

attack( SUBJECT, 'rules() gives the same rules every time', () => {
	const _contract = goal();
	assert.deepEqual( _contract.rules(), _contract.rules() );
} );

attack( SUBJECT, 'a goal whose deadline has passed still carries its expiry, so the gate lets nothing new out', () => {
	const _past = inHours( -2 );
	assert.equal( goal( { deadline: _past } ).rules().gate.find( rule => rule.rule === 'expires' ).at, _past );
} );

// The check of the hard core.

attack( SUBJECT, 'check() covers the hard core only, each verdict with id, type and kind', () => {
	const _verdicts = goal( { soft: [ 'calm' ] } ).check( [] );
	assert.deepEqual( _verdicts.map( item => [ item.id, item.type, item.kind ] ), [
		[ 'k1', 'report_delivered', 'outcome' ], [ 'k2', 'min_group', 'invariant' ], [ 'k3', 'no_difference', 'invariant' ],
	] );
} );

attack( SUBJECT, 'without facts the outcome is open and the invariants hold', () => {
	const _verdicts = Object.fromEntries( goal().check( [] ).map( item => [ item.id, item.met ] ) );
	assert.deepEqual( _verdicts, { k1: false, k2: true, k3: true } );
} );

attack( SUBJECT, 'a confirmed delivery to HR meets the outcome; one to someone else does not', () => {
	assert.equal( goal().check( [ delivered( 'f1', {} ) ] )[ 0 ].met, true );
	assert.equal( goal().check( [ delivered( 'f1', { to: 'ceo' } ) ] )[ 0 ].met, false );
} );

attack( SUBJECT, 'a release about fewer than k people breaks the group invariant', () => {
	const _verdicts = goal().check( [ delivered( 'f1', { cohort: [ 'a', 'b', 'c' ] } ) ] );
	assert.equal( _verdicts.find( item => item.id === 'k2' ).met, false );
} );

attack( SUBJECT, 'an outcome whose own deadline has passed unmet is impossible', () => {
	const _contract = goal( { criteria: [ { ...goalSpec().criteria[ 0 ], deadline: inHours( 1 ) }, ...goalSpec().criteria.slice( 1 ) ] } );
	const [ _k1 ] = _contract.check( [], Date.now() + 2 * 3600000 );
	assert.deepEqual( [ _k1.met, _k1.impossible ], [ false, true ] );
	assert.match( _k1.reason, /deadline has passed/ );
} );
