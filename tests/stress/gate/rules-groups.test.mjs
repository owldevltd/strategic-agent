// Attacks on the group rules and the data-flow limits of 10.4: duplicated or padded cohorts, "the same without Anna"
// hidden behind duplicates, releases still in flight or unclear, nested labels, unlabelled sensitive values.
import assert from 'node:assert/strict';
import { attack, attacks, random } from '../hostile.mjs';
import { gate, surveySpec, invoiceSpec, reply, pay, people, actionsWith, Contract, registry, IBAN } from './fixture.mjs';

const S = 'gate/rules.js';
const twelve = people( 12 );
const reasons = result => result.reasons.map( item => item.reason ).join( ' | ' );

// The gate's own verdict on one request under hand-written rules.
const evaluate = ( g, rules, request ) => g.egress.rules.evaluate( {
	root: g.hash, hash: g.hash, rules: { gate: [], flow: [], allow: [], ...rules },
}, request );

attack( S, 'min_group: one person listed five times is a group of one, not of five', async () => {
	const g = gate();
	const _result = await g.submit( reply( [ 'r01', 'r01', 'r01', 'r01', 'r01' ] ) );
	assert.equal( _result.status, 'refused' );
	assert.match( reasons( _result ), /group of 1 < 5/ );
} );

attack( S, 'min_group: two people padded with empty and null ids are a group of two', async () => {
	const g = gate();
	const _result = await g.submit( reply( [ 'r01', 'r02', '', null, ' ' ] ) );
	assert.equal( _result.status, 'refused' );
} );

attacks( S, [
	{ name: 'min_group: exactly k distinct people pass', cohort: people( 5 ), status: 'awaiting_approval' },
	{ name: 'min_group: k minus one distinct people are refused', cohort: people( 4 ), status: 'refused' },
	{ name: 'min_group: an empty group is refused', cohort: [], status: 'refused' },
], async ( { cohort, status } ) => {
	const g = gate();
	assert.equal( ( await g.submit( reply( cohort ) ) ).status, status );
} );

attacks( S, [
	{ name: 'min_group: a cohort given as one string is refused, never read as "no release"', cohort: 'r01' },
	{ name: 'min_group: a cohort given as an object with a length is refused', cohort: { length: 12 } },
	{ name: 'min_group: a cohort given as a number is refused', cohort: 12 },
], async ( { cohort } ) => {
	const g = gate();
	const _result = await g.submit( reply( cohort ) );
	assert.equal( _result.status, 'refused' );
} );

attack( S, 'no_difference: "the same without Anna" is refused even when the earlier release listed Anna five times', async () => {
	const g = gate();
	assert.equal( ( await g.send( reply( [ ...twelve, 'r07', 'r07', 'r07', 'r07' ] ) ) ).status, 'executed' );
	const _without = await g.submit( reply( twelve.filter( id => id !== 'r07' ) ) );
	assert.equal( _without.status, 'refused', 'the groups differ by one person' );
} );

attacks( S, [
	{ name: 'no_difference: a group that differs by exactly k people passes', cohort: people( 17 ), status: 'awaiting_approval' },
	{ name: 'no_difference: a group that differs by k minus one people is refused', cohort: people( 16 ), status: 'refused' },
	{ name: 'no_difference: the same group in another order is the same group', cohort: [ ...people( 12 ) ].reverse(), status: 'awaiting_approval' },
	{ name: 'no_difference: the same group with one more person is refused', cohort: people( 13 ), status: 'refused' },
	{ name: 'no_difference: one person swapped for another is a difference of two and refused', cohort: [ ...people( 11 ), 'r99' ], status: 'refused' },
	{ name: 'no_difference: a disjoint group passes', cohort: people( 12, 50 ), status: 'awaiting_approval' },
], async ( { cohort, status } ) => {
	const g = gate();
	await g.send( reply( twelve ) );
	assert.equal( ( await g.submit( reply( cohort ) ) ).status, status );
} );

attack( S, 'no_difference: every earlier release counts, not only the last one', async () => {
	const g = gate();
	await g.send( reply( twelve ) );
	await g.send( reply( people( 12, 40 ) ) );
	const _result = await g.submit( reply( people( 11 ) ) );
	assert.equal( _result.status, 'refused' );
} );

attack( S, 'no_difference: a release that went out but stays unclear counts like an executed one', async () => {
	const g = gate( { plain: true, service: { answer: () => ( { ok: false, error: 'connection reset after the message was accepted' } ) } } );
	assert.equal( ( await g.send( reply( twelve ) ) ).status, 'unclear' );
	const _without = await g.submit( reply( twelve.filter( id => id !== 'r07' ) ) );
	assert.equal( _without.status, 'refused', 'the unclear release may well have reached the CEO' );
} );

attack( S, 'no_difference: a release under a sibling child counts for the whole tree', async () => {
	const g = gate();
	await g.send( reply( twelve ) );
	const _spec = { ...surveySpec(), id: 'sibling', parent: g.hash };
	const _child = new Contract( _spec, registry );
	assert.equal( g.egress.propose( _child.canonical(), _child.rules(), _child.hash ).status, 'confirmed' );
	const _result = await g.submit( { ...reply( people( 11 ) ), contract: _child.hash } );
	assert.equal( _result.status, 'refused' );
} );

// Pentest C: a second goal could otherwise tell apart whom the first one grouped. Only the operator keeps the ledger
// to each goal (GATE_LEDGER_SCOPE=goal, a public demo where every run is a simulated week of its own).
attack( S, 'no_difference: releases of another root goal count too, unless the operator keeps the ledger to each goal', async () => {
	for ( const [ ledger, status ] of [ [ undefined, 'refused' ], [ 'gate', 'refused' ], [ 'goal', 'awaiting_approval' ] ] ) {
		const g = gate( { ledger } );
		await g.send( reply( twelve ) );
		const _other = new Contract( surveySpec( { id: 'another-root' } ), registry );
		g.egress.propose( _other.canonical(), _other.rules(), _other.hash );
		g.egress.confirm( _other.hash, 'person' );
		const _result = await g.submit( { ...reply( people( 11 ) ), contract: _other.hash }, g.lease( 'worker', 5, _other.hash ) );
		assert.equal( _result.status, status, `ledger ${ledger}` );
	}
} );

attacks( S, [ 11, 23, 37 ].map( seed => ( { name: `no_difference fuzz (seed ${seed}): any two releases that went out differ by 0 or at least k people`, seed } ) ),
	async ( { seed } ) => {
		const _random = random( seed );
		const g = gate();
		const _pool = people( 30 );
		for ( let i = 0; i < 25; i++ ) {
			const _cohort = _pool.filter( () => _random() < 0.6 );
			await g.send( reply( _cohort ) );
		}
		const _released = g.db.all( 'SELECT cohort FROM releases' ).map( row => new Set( JSON.parse( row.cohort ) ) );
		for ( const a of _released ) {
			for ( const b of _released ) {
				const _diff = [ ...a ].filter( id => !b.has( id ) ).length + [ ...b ].filter( id => !a.has( id ) ).length;
				assert.ok( _diff === 0 || _diff >= 5, `two releases differ by ${_diff}` );
				assert.ok( a.size >= 5 );
			}
		}
	} );

attack( S, '10.4: a confidential label hidden one list deeper is still confidential', async () => {
	const g = gate( { spec: invoiceSpec() } );
	const _result = evaluate( g, {}, { action: 'reply', params: { body: 'salaries' }, labels: { body: [ [ 'confidential' ] ] } } );
	assert.ok( _result.refusals.some( item => item.rule === 'confidential' ) );
} );

attack( S, '10.4: a confidential label given as a plain string instead of a list is still confidential', () => {
	const g = gate( { spec: invoiceSpec() } );
	const _result = evaluate( g, {}, { action: 'reply', params: { body: 'salaries' }, labels: { body: 'confidential' } } );
	assert.ok( _result.refusals.some( item => item.rule === 'confidential' ) );
} );

attack( S, '10.4: a confidential label under the key __proto__ is still seen', () => {
	const g = gate( { spec: invoiceSpec() } );
	const _labels = JSON.parse( '{ "__proto__": [ "confidential" ] }' );
	const _result = evaluate( g, {}, { action: 'reply', params: { body: 'salaries' }, labels: _labels } );
	assert.ok( _result.refusals.some( item => item.rule === 'confidential' ) );
} );

attack( S, '10.4: confidential data allowed as a group still needs a declared group (null, not a list)', () => {
	const g = gate();
	const _allow = [ { label: 'confidential', actions: [ 'carries:data' ], as: 'group' } ];
	const _result = evaluate( g, { allow: _allow }, { action: 'reply', params: {}, labels: { body: [ 'confidential' ] }, cohort: null } );
	assert.match( _result.refusals.map( item => item.reason ).join(), /without a declared group/ );
} );

attack( S, '10.4: a foreign value hidden one list deeper in a sensitive parameter is still foreign', () => {
	const g = gate( { spec: invoiceSpec() } );
	const _result = evaluate( g, {}, pay( 'R-1187', 100, { labels: [ [ 'foreign' ] ] } ) );
	assert.ok( _result.refusals.some( item => item.rule === 'sensitive' ) );
} );

attack( S, '10.4: a foreign label among others in a sensitive parameter is refused', () => {
	const g = gate( { spec: invoiceSpec() } );
	const _result = evaluate( g, {}, pay( 'R-1187', 100, { labels: [ 'own', 'foreign' ] } ) );
	assert.ok( _result.refusals.some( item => item.rule === 'sensitive' ) );
} );

attack( S, 'A8: a sensitive parameter without any label is of unknown origin and refused', () => {
	const g = gate( { spec: invoiceSpec() } );
	const _result = evaluate( g, {}, { action: 'payment', params: { iban: IBAN, amount: 10, invoiceId: 'R-1' }, labels: {} } );
	assert.ok( _result.refusals.length > 0, 'the gate cannot tell where the IBAN came from' );
} );

attack( S, 'flow: an own account required by the goal is checked on the parameter the rule names, not on another one', async () => {
	const g = gate( { spec: invoiceSpec() } );
	const _result = await g.submit( { ...pay( 'R-1187', 100 ), labels: { invoiceId: [ 'own' ], iban: [ 'foreign' ] } } );
	assert.equal( _result.status, 'refused' );
	assert.ok( _result.reasons.some( item => item.rule === 'flow' ) );
} );

attack( S, 'outward: every outward action of the catalog waits for a person even when the goal names no approval rule', () => {
	const g = gate();
	for ( const action of [ 'report', 'reply', 'invite', 'payment' ] ) {
		assert.equal( evaluate( g, {}, { action, params: {}, labels: {} } ).needsApproval, true, action );
	}
} );

attack( S, 'outward: an action the table marks internal passes without a person, but only that one', () => {
	const g = gate( { actions: actionsWith( { note: { criticality: 'internal', carries: [ 'message' ], sensitive: [] } } ) } );
	assert.equal( evaluate( g, {}, { action: 'note', params: {}, labels: {} } ).needsApproval, false );
	assert.equal( evaluate( g, {}, { action: 'reply', params: {}, labels: {} } ).needsApproval, true );
} );
