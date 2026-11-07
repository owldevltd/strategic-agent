// core/criteria/countmatches.js (menge_erhalten, 14.1): both counts observed in the same run, their difference within
// the tolerance (never negative, K6). Attacks: boundaries, duplicates in the export, counts that are no counts.
import { ContractCheck, Contract, assert, attack, attacks, fact, hostile, make, ms, registry } from './kit.mjs';
import { outcomeSuite } from './suites.mjs';

const S = 'core/criteria/countmatches.js';
const VALUES = { source: 'db:customers', target: 'export.csv', tolerance: 0 };
const counted = ( sourceCount, targetCount, data = {}, extra = {} ) =>
	fact( 'count', { source: 'db:customers', target: 'export.csv', sourceCount, targetCount, ...data }, 'observation', extra );
const met = ( facts, tolerance = 0 ) => make( 'count_matches', { ...VALUES, tolerance } ).check( facts ).met;

outcomeSuite( S, { type: 'count_matches', values: VALUES, good: () => [ counted( 1200, 1200 ) ], refused: [ 'derivation', 'claim', 'confirmation' ] } );

attacks( S, [
	{ name: 'equal counts with tolerance 0 meet it', source: 1200, target: 1200, tolerance: 0, want: true },
	{ name: 'one record lost with tolerance 0 does not', source: 1200, target: 1199, tolerance: 0, want: false },
	{ name: 'a difference exactly at the tolerance meets it', source: 1200, target: 1190, tolerance: 10, want: true },
	{ name: 'one more than the tolerance does not', source: 1200, target: 1189, tolerance: 10, want: false },
	{ name: 'extra records in the export (duplicates) count as a difference too', source: 1200, target: 1260, tolerance: 10, want: false },
	{ name: 'a 10 % loss (the paper\'s example) fails a tolerance of 0', source: 1000, target: 900, tolerance: 0, want: false },
	{ name: 'a fractional tolerance 0.5 lets no whole record go missing', source: 10, target: 9, tolerance: 0.5, want: false },
	{ name: 'counts given as numeric text are compared as numbers', source: '1200', target: '1200', tolerance: 0, want: true },
	{ name: 'an export of nothing from a source of nothing is complete', source: 0, target: 0, tolerance: 0, want: true },
	{ name: 'large exact counts keep their difference', source: 1e15, target: 1e15 + 1, tolerance: 0, want: false },
	{ name: 'a missing target count is no match', source: 1200, target: undefined, tolerance: 1e6, want: false },
	{ name: 'an unreadable count is no match', source: 'many', target: 'many', tolerance: 1e6, want: false },
	{ name: 'infinite counts are no match', source: Infinity, target: Infinity, tolerance: 0, want: false },
], ( { source, target, tolerance, want } ) => {
	assert.equal( met( [ counted( source, target ) ], tolerance ), want );
} );

attacks( S, [
	{ name: 'a run whose counts are both null counted nothing and proves nothing', source: null, target: null },
	{ name: 'a run whose counts are both true counted nothing and proves nothing', source: true, target: true },
	{ name: 'negative counts are no counts', source: -5, target: -5 },
	{ name: 'counts that are empty text are no counts', source: '', target: '' },
], ( { source, target } ) => {
	assert.equal( met( [ counted( source, target ) ] ), false );
} );

attack( S, 'the latest count of the pair counts: a later loss undoes an earlier match', () => {
	assert.equal( met( [ counted( 10, 10 ), counted( 10, 9 ) ] ), false );
	assert.equal( met( [ counted( 10, 9 ), counted( 10, 10 ) ] ), true );
} );

attack( S, 'a count of another export does not count for this one, even if it comes last', () => {
	assert.equal( met( [ counted( 10, 10 ), counted( 10, 3, { target: 'other.csv' } ) ] ), true );
	assert.equal( met( [ counted( 10, 10, { target: 'other.csv' } ) ] ), false );
} );

attack( S, 'a count from another source does not count', () => {
	assert.equal( met( [ counted( 10, 10, { source: 'db:suppliers' } ) ] ), false );
} );

attack( S, 'a count of the pair given as two separate facts is not "both counts in the same run"', () => {
	const _source = fact( 'count', { source: 'db:customers', target: 'export.csv', sourceCount: 10 } );
	const _target = fact( 'count', { source: 'db:customers', target: 'export.csv', targetCount: 10 } );
	assert.equal( met( [ _source, _target ] ), false );
} );

attack( S, 'the evidence is the latest count only, and the reason shows it', () => {
	const _old = counted( 10, 10 );
	const _new = counted( 10, 9 );
	const _result = make( 'count_matches', VALUES ).check( [ _old, _new ] );
	assert.deepEqual( _result.evidence, [ _new.id ] );
	assert.equal( _result.reason, '9 of 10' );
	assert.equal( make( 'count_matches', VALUES ).check( [] ).reason, 'not counted' );
} );

attack( S, 'a superseded latest count leaves the one before it (E5)', () => {
	assert.equal( met( [ counted( 10, 10 ), counted( 10, 9, {}, { superseded: true } ) ] ), true );
} );

attacks( S, [
	{ name: 'K6: a negative tolerance is refused', tolerance: -1, want: /tolerance must be a number >= 0/ },
	{ name: 'K6: a tolerance of 0 is a valid tolerance, not a missing one', tolerance: 0, want: null },
	{ name: 'a tolerance given as text is refused', tolerance: '0', want: /must be a number/ },
	{ name: 'a missing tolerance is refused', tolerance: undefined, want: /tolerance is missing/ },
	{ name: 'a tolerance of NaN is refused', tolerance: NaN, want: /tolerance/ },
], ( { tolerance, want } ) => {
	const _problems = make( 'count_matches', { ...VALUES, tolerance } ).validate();
	if ( want === null ) {
		assert.deepEqual( _problems, [] );
	} else {
		assert.match( _problems.join(), want );
	}
} );

attacks( S, hostile( 'types' ).map( item => ( { ...item, name: `the source ${item.label} is refused cleanly` } ) ), ( { value } ) => {
	const _problems = make( 'count_matches', { ...VALUES, source: value } ).validate();
	assert.deepEqual( _problems, [ `k1: source ${value === null || value === undefined ? 'is missing' : 'must be text'}` ] );
} );

attack( S, 'K6 at G1: a contract with a negative tolerance is refused', () => {
	const _contract = new Contract( { id: 'c', goal: 'Export all customers', deadline: '2026-12-01T00:00:00Z', budget: 9,
		criteria: [ { id: 'k1', type: 'count_matches', values: { ...VALUES, tolerance: -3 } } ] }, registry );
	assert.match( new ContractCheck().check( _contract, { now: ms( '2026-11-03T00:00:00Z' ) } ).problems.join(), /tolerance/ );
} );

attack( S, 'its evidence kind is the count, which a move must deliver (K4)', () => {
	assert.deepEqual( registry.types.count_matches.EVIDENCE, [ 'count' ] );
} );
