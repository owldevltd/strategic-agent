// core/criteria/testgreen.js (test_gruen, 14.1, 3.3): the test passes on exactly this commit, observed in the sandbox.
// As a criterion of the agent (layer 2) it can demand more: red first, and enough mutations caught, so a test that
// cannot fail does not count. Attacks: other commits, times in other zones, mutation runs that are no observation.
import { AT, assert, attack, attacks, fact, make, registry, shift } from './kit.mjs';
import { outcomeSuite } from './suites.mjs';

const S = 'core/criteria/testgreen.js';
const VALUES = { test: 'umlauts', commit: 'c2' };
const run = ( result, commit = 'c2', extra = {}, data = {} ) => fact( 'test_run', { test: 'umlauts', commit, result, ...data }, 'observation', extra );
const mutants = ( caught, of, extra = {}, data = {} ) => fact( 'mutation_run', { test: 'umlauts', commit: 'c2', caught, of, ...data }, 'observation', extra );
const check = ( facts, values = VALUES ) => make( 'test_green', values ).check( facts );
const red = ( time = shift( AT, -3600000 ) ) => run( 'red', 'c1', { time } );
const STRICT = { ...VALUES, firstRed: true };
const MUT = { ...VALUES, mutation: { caught: 9, of: 10 } };

outcomeSuite( S, { type: 'test_green', values: VALUES, good: () => [ run( 'green' ) ], refused: [ 'derivation', 'claim', 'confirmation' ] } );

attack( S, 'a green run on exactly this commit meets it', () => {
	const _green = run( 'green' );
	assert.deepEqual( check( [ _green ] ), { met: true, evidence: [ _green.id ], reason: '' } );
} );

attacks( S, [
	{ name: 'a green run on another commit does not count', fact: () => run( 'green', 'c3' ) },
	{ name: 'a green run on the commit with another case does not count', fact: () => run( 'green', 'C2' ) },
	{ name: 'a green run of another test does not count', fact: () => run( 'green', 'c2', {}, { test: 'format' } ) },
	{ name: 'a red run on the commit does not count', fact: () => run( 'red' ) },
	{ name: 'a run whose result is "GREEN" is not "green"', fact: () => run( 'GREEN' ) },
	{ name: 'a run whose result is "passed" is not "green"', fact: () => run( 'passed' ) },
	{ name: 'the agent saying the test is green is no run', fact: () => run( 'green', 'c2', { evidenceClass: 'claim', source: 'agent' } ) },
], ( { fact: build } ) => {
	assert.equal( check( [ build() ] ).met, false );
} );

attack( S, 'a green run anywhere among red ones on the commit counts (flaky test)', () => {
	assert.equal( check( [ run( 'red' ), run( 'green' ), run( 'red' ) ] ).met, true );
} );

attack( S, 'firstRed: never red before: not met, with the green run as evidence', () => {
	const _green = run( 'green' );
	assert.deepEqual( check( [ _green ], STRICT ), { met: false, evidence: [ _green.id ], reason: 'it was never red first' } );
} );

attacks( S, [
	{ name: 'firstRed: red on the earlier commit before the green run meets it', facts: () => [ red(), run( 'green' ) ], want: true },
	{ name: 'firstRed: red only after the green run is not "red first"', facts: () => [ run( 'green' ), red( shift( AT, 1 ) ) ], want: false },
	{ name: 'firstRed: red on this very commit is not "red before the change"', facts: () => [ run( 'red', 'c2', { time: shift( AT, -1 ) } ), run( 'green' ) ], want: false },
	{ name: 'firstRed: a red run without a time proves no order', facts: () => [ run( 'red', 'c1', { time: undefined } ), run( 'green' ) ], want: false },
	{ name: 'firstRed: a red run claimed by the agent does not count', facts: () => [ { ...red(), evidenceClass: 'claim' }, run( 'green' ) ], want: false },
	{ name: 'firstRed: a red run of another test does not count', facts: () => [ run( 'red', 'c1', { time: shift( AT, -1 ) }, { test: 'format' } ), run( 'green' ) ], want: false },
], ( { facts, want } ) => {
	assert.equal( check( facts(), STRICT ).met, want );
} );

attack( S, 'firstRed: a red run one hour AFTER the green one, written at -05:00, is not "red first"', () => {
	const _red = run( 'red', 'c1', { time: '2026-11-05T06:00:00-05:00' } );
	assert.equal( check( [ _red, run( 'green' ) ], STRICT ).met, false );
} );

attack( S, 'firstRed: a red run one hour BEFORE the green one, written at +05:00, is "red first"', () => {
	const _red = run( 'red', 'c1', { time: '2026-11-05T14:00:00+05:00' } );
	assert.equal( check( [ _red, run( 'green' ) ], STRICT ).met, true );
} );

attacks( S, [
	{ name: 'mutation: 9 of 10 caught meets a demand of 9 of 10, with both runs as evidence', facts: () => [ run( 'green' ), mutants( 9, 10 ) ], want: true },
	{ name: 'mutation: 8 of 10 caught does not meet 9 of 10', facts: () => [ run( 'green' ), mutants( 8, 10 ) ], want: false },
	{ name: 'mutation: 90 of 100 is the same rate and meets it', facts: () => [ run( 'green' ), mutants( 90, 100 ) ], want: true },
	{ name: 'mutation: a run on another commit does not count', facts: () => [ run( 'green' ), mutants( 10, 10, {}, { commit: 'c1' } ) ], want: false },
	{ name: 'mutation: a run of another test does not count', facts: () => [ run( 'green' ), mutants( 10, 10, {}, { test: 'format' } ) ], want: false },
	{ name: 'mutation: without a green run there is nothing to measure', facts: () => [ mutants( 10, 10 ) ], want: false },
], ( { facts, want } ) => {
	const _facts = facts();
	const _result = check( _facts, MUT );
	assert.equal( _result.met, want );
	if ( want ) { assert.deepEqual( _result.evidence, _facts.map( item => item.id ) ); }
} );

attack( S, 'mutation: the reason says how many mutations it must catch', () => {
	assert.equal( check( [ run( 'green' ), mutants( 1, 10 ) ], MUT ).reason, 'catches fewer than 9 of 10 mutations' );
} );

attacks( S, [
	{ name: 'mutation: the agent claiming 10 of 10 caught is no mutation run', fact: () => mutants( 10, 10, { evidenceClass: 'claim', source: 'agent' } ) },
	{ name: 'mutation: an AI\'s reading of a log (derivation) is no mutation run', fact: () => mutants( 10, 10, { evidenceClass: 'derivation' } ) },
], ( { fact: build } ) => {
	assert.equal( check( [ run( 'green' ), build() ], MUT ).met, false );
} );

attacks( S, [
	{ name: 'mutation: "1 caught of 0 mutants" is no mutation run', caught: 1, of: 0 },
	{ name: 'mutation: more caught than there were mutants is no mutation run', caught: 20, of: 10 },
], ( { caught, of } ) => {
	assert.equal( check( [ run( 'green' ), mutants( caught, of ) ], MUT ).met, false );
} );

attack( S, 'mutation: zero of zero mutants proves nothing', () => {
	assert.equal( check( [ run( 'green' ), mutants( 0, 0 ) ], MUT ).met, false );
} );

attack( S, 'firstRed and mutation together: both must hold', () => {
	const _both = { ...VALUES, firstRed: true, mutation: { caught: 9, of: 10 } };
	assert.equal( check( [ run( 'green' ), mutants( 10, 10 ) ], _both ).met, false );
	assert.equal( check( [ red(), run( 'green' ) ], _both ).met, false );
	assert.equal( check( [ red(), run( 'green' ), mutants( 10, 10 ) ], _both ).met, true );
} );

attack( S, 'layer 2: as a criterion of the agent it names the criterion of the client it serves', () => {
	const _described = make( 'test_green', VALUES, { origin: 'agent', serves: 'k1' } ).describe();
	assert.deepEqual( [ _described.origin, _described.serves ], [ 'agent', 'k1' ] );
} );

attack( S, 'the proposal check\'s own run (meta.check shape) meets a criterion on that version', () => {
	const _run = fact( 'test_run', { test: 'criterion_check', commit: 'v-7', result: 'green' }, 'observation', { source: 'trusted meta.check' } );
	assert.equal( check( [ _run ], { test: 'criterion_check', commit: 'v-7' } ).met, true );
} );

attacks( S, [
	{ name: 'validate: firstRed as text is refused', values: { ...VALUES, firstRed: 'yes' }, want: /firstRed must be true or false/ },
	{ name: 'validate: a mutation demand as a list is refused', values: { ...VALUES, mutation: [ 9, 10 ] }, want: /mutation must be an object/ },
	{ name: 'validate: a mutation demand as text is refused', values: { ...VALUES, mutation: '9 of 10' }, want: /mutation must be an object/ },
	{ name: 'validate: a missing commit is refused', values: { test: 't' }, want: /commit is missing/ },
	{ name: 'validate: a test given as a number is refused', values: { test: 7, commit: 'c' }, want: /test must be text/ },
], ( { values, want } ) => {
	assert.match( make( 'test_green', values ).validate().join(), want );
} );

attack( S, 'its evidence kinds are the test run and the mutation run', () => {
	assert.deepEqual( registry.types.test_green.EVIDENCE, [ 'test_run', 'mutation_run' ] );
} );
