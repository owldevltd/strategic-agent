// core/meta/proposals.js, part 1: submitting and the trusted check (6.1, 14, 19). A proposal composes only what
// exists: a strategy of catalog moves, a move as one of the five base moves with a configuration and none of the
// fixed fields, a criterion type as a conjunction of existing types. Every malformed or hostile body must come back
// red, never green and never as a crash.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { registry, Proposals, memoryDb, catalogOf, survey } from './fixtures.mjs';

const SUBJECT = 'core/meta/proposals.js';
const known = { catalog: catalogOf( survey ), registry, strategies: survey.strategies };
const STRATEGY = { id: 'report-twice', serves: 'report_delivered', price: 2, steps: [ { move: 'report.draft' }, { move: 'report.send' } ] };
const MOVE = { id: 'summary.short', executor: 'ai', role: 'writer', contract: { fields: { text: { type: 'string' } } }, price: 0.1 };
const CRITERION = { type: 'reported_and_counted', params: [ 'team' ], all: [
	{ type: 'report_delivered', values: { to: 'hr', topic: '{{team}}' } }, { type: 'number_in_range', values: { quantity: 'answers:{{team}}', min: 3 } },
] };

const fresh = () => new Proposals( memoryDb() );
const submit = ( proposals, kind, body, by = 'node-1' ) => proposals.submit( kind, body, { mission: 'survey', by } );
const check = ( kind, body ) => {
	const _proposals = fresh();
	return _proposals.check( submit( _proposals, kind, body ), known );
};
const red = ( result, pattern ) => {
	assert.equal( result.result, 'red', JSON.stringify( result ) );
	if ( pattern ) { assert.match( result.problems.join( '; ' ), pattern ); }
};

attack( SUBJECT, 'the same proposal submitted twice is one version and one row', () => {
	const _proposals = fresh();
	assert.equal( submit( _proposals, 'strategy', STRATEGY ), submit( _proposals, 'strategy', structuredClone( STRATEGY ) ) );
	assert.equal( _proposals.count(), 1 );
} );

attack( SUBJECT, 'a replay by another node keeps the first author and status', () => {
	const _proposals = fresh();
	const _version = submit( _proposals, 'strategy', STRATEGY, 'node-1' );
	submit( _proposals, 'strategy', STRATEGY, 'node-evil' );
	assert.deepEqual( [ _proposals.get( _version ).by, _proposals.get( _version ).status ], [ 'node-1', 'proposed' ] );
} );

attack( SUBJECT, 'the key order of the body does not change the version', () => {
	const _proposals = fresh();
	const _reversed = Object.fromEntries( Object.entries( STRATEGY ).reverse() );
	assert.equal( submit( _proposals, 'strategy', _reversed ), submit( _proposals, 'strategy', STRATEGY ) );
} );

attack( SUBJECT, 'any change of the body is another version', () => {
	const _proposals = fresh();
	const _versions = [ STRATEGY, { ...STRATEGY, price: 3 }, { ...STRATEGY, steps: [ { move: 'report.send' } ] }, { ...STRATEGY, startCurve: { p0: 0.9 } } ]
		.map( body => submit( _proposals, 'strategy', body ) );
	assert.equal( new Set( _versions ).size, 4 );
} );

attack( SUBJECT, 'the same body as another kind is another version', () => {
	const _proposals = fresh();
	assert.notEqual( submit( _proposals, 'strategy', MOVE ), submit( _proposals, 'move', MOVE ) );
} );

attack( SUBJECT, 'a version is 16 hex characters and the stored body is exactly the submitted one', () => {
	const _proposals = fresh();
	const _version = submit( _proposals, 'move', MOVE );
	assert.match( _version, /^[0-9a-f]{16}$/ );
	assert.deepEqual( _proposals.get( _version ).body, MOVE );
} );

attack( SUBJECT, 'an unknown version reads as nothing and checks red', () => {
	const _proposals = fresh();
	assert.equal( _proposals.get( 'ffffffffffffffff' ), null );
	assert.deepEqual( _proposals.check( 'ffffffffffffffff', known ), { result: 'red', problems: [ 'no such proposal' ] } );
} );

attack( SUBJECT, 'a proposal of an unknown kind is red', () => {
	red( check( 'trigger', { id: 'abc' } ), /unknown kind trigger/ );
} );

attacks( SUBJECT, [
	{ name: 'a proposal of kind constructor is red', kind: 'constructor' },
	{ name: 'a proposal of kind valueOf is red', kind: 'valueOf' },
	{ name: 'a proposal of kind __proto__ is red, not a crash', kind: '__proto__' },
	{ name: 'a proposal of kind toString is red with a list of problems', kind: 'toString' },
], ( { kind } ) => {
	const _result = check( kind, { id: 'abc' } );
	red( _result );
	assert.ok( Array.isArray( _result.problems ) );
} );

// Strategies.

attack( SUBJECT, 'a strategy of catalog moves is green', () => {
	assert.deepEqual( check( 'strategy', STRATEGY ), { result: 'green', problems: [] } );
} );

attacks( SUBJECT, [ '', 'Upper', 'a', '1abc', '../escape', 'x'.repeat( 42 ) ].map( id => ( { name: `a strategy id ${JSON.stringify( id.slice( 0, 12 ) )} is no short code`, id } ) ),
	( { id } ) => red( check( 'strategy', { ...STRATEGY, id } ), /the id must be a short code/ ) );

attack( SUBJECT, 'a strategy whose id exists already is red', () => {
	red( check( 'strategy', { ...STRATEGY, id: 'team-report' } ), /a strategy team-report exists already/ );
} );

attack( SUBJECT, 'a strategy that serves no criterion type is red; one for the person as channel is fine', () => {
	red( check( 'strategy', { ...STRATEGY, serves: 'world_peace' } ), /world_peace is no criterion type/ );
	assert.equal( check( 'strategy', { ...STRATEGY, serves: '@byPerson' } ).result, 'green' );
} );

attack( SUBJECT, 'a strategy that serves an Object.prototype member is red', () => {
	red( check( 'strategy', { ...STRATEGY, serves: '__proto__' } ), /is no criterion type/ );
} );

attack( SUBJECT, 'a strategy without steps is red', () => {
	red( check( 'strategy', { ...STRATEGY, steps: [] } ), /a strategy needs steps/ );
	red( check( 'strategy', { ...STRATEGY, steps: undefined } ), /a strategy needs steps/ );
} );

attack( SUBJECT, 'steps given as text are red', () => {
	red( check( 'strategy', { ...STRATEGY, steps: 'report.send' } ), /a strategy needs steps/ );
} );

attacks( SUBJECT, [
	{ name: 'steps given as an object are red, not a crash', steps: { 0: { move: 'report.send' } } },
	{ name: 'a step that is null is red, not a crash', steps: [ null ] },
	{ name: 'steps given as a number are red, not a crash', steps: 7 },
], ( { steps } ) => {
	assert.doesNotThrow( () => red( check( 'strategy', { ...STRATEGY, steps } ) ) );
} );

attack( SUBJECT, 'a step with a move outside the catalog is red', () => {
	red( check( 'strategy', { ...STRATEGY, steps: [ { move: 'mail.everyone' } ] } ), /mail.everyone is not in the catalog/ );
} );

attacks( SUBJECT, [ 'meta.check', 'meta.register', 'move.cancel' ].map( move => ( { name: `the trusted move ${move} is no building block`, move } ) ), ( { move } ) => {
	red( check( 'strategy', { ...STRATEGY, steps: [ { move } ] } ), /trusted code of the core and no part of a strategy/ );
} );

attack( SUBJECT, 'the knowledge search is a building block', () => {
	assert.equal( check( 'strategy', { ...STRATEGY, steps: [ { move: 'knowledge.find', params: { query: 'morale' } }, { move: 'report.send' } ] } ).result, 'green' );
} );

attack( SUBJECT, 'a parameter the move does not have is red; its declared single parameter is fine', () => {
	red( check( 'strategy', { ...STRATEGY, steps: [ { move: 'report.send', params: { to: 'everyone' } } ] } ), /report.send has no parameter to/ );
	assert.equal( check( 'strategy', { ...STRATEGY, steps: [ { move: 'report.send', params: { body: 'x' } } ] } ).result, 'green' );
} );

attack( SUBJECT, 'params given as a list are red', () => {
	red( check( 'strategy', { ...STRATEGY, steps: [ { move: 'report.send', params: [ 'everyone' ] } ] } ), /report.send has no parameter 0/ );
} );

attack( SUBJECT, 'a parameter named after an Object.prototype member is red', () => {
	red( check( 'strategy', { ...STRATEGY, steps: [ { move: 'report.draft', params: JSON.parse( '{ "constructor": "x", "toString": "y" }' ) } ] } ), /has no parameter/ );
} );

attacks( SUBJECT, [
	{ name: 'a strategy without a price is red', price: undefined, ok: false },
	{ name: 'a negative price is red', price: -1, ok: false },
	{ name: 'a price that is an object is red', price: { amount: 1 }, ok: false },
	{ name: 'a price that is a word is red', price: 'cheap', ok: false },
	{ name: 'a price of 0 is fine', price: 0, ok: true },
	{ name: 'a price written as a number in text is fine', price: '3', ok: true },
], ( { price, ok } ) => {
	const _result = check( 'strategy', { ...STRATEGY, price } );
	assert.equal( _result.result, ok ? 'green' : 'red', JSON.stringify( _result ) );
} );

attack( SUBJECT, 'a start curve above certainty is red, since it would win every choice', () => {
	red( check( 'strategy', { ...STRATEGY, startCurve: { p0: 1000, tauH: 0.1 } } ) );
} );

attack( SUBJECT, 'a fits pattern that does not compile is red', () => {
	red( check( 'strategy', { ...STRATEGY, fits: { topic: '(' } } ) );
} );

attacks( SUBJECT, [
	{ name: 'a fits pattern longer than 100 characters is red', pattern: `^${'a'.repeat( 100 )}$` },
	{ name: 'a fits pattern that repeats a repetition, (a+)+, is red', pattern: '^(a+)+$' },
	{ name: 'a fits pattern (\\d*)* is red', pattern: '(\\d*)*' },
	{ name: 'a fits pattern with a repetition nested two groups deep is red', pattern: '((x+)y){2,}' },
	{ name: 'a fits pattern that is no text is red', pattern: 5 },
], ( { pattern } ) => {
	red( check( 'strategy', { ...STRATEGY, fits: { topic: pattern } } ), /fits\.topic/ );
} );

attack( SUBJECT, 'fits patterns of the catalog\'s kind are green: one repetition, a class, an optional group', () => {
	for ( const pattern of [ '^answers:[a-z]+$', '^(design|product)$', '^(answers:)?[a-z]+$', '^[(a+)+]+$', '^\\(a+\\)+$', 'a'.repeat( 100 ) ] ) {
		assert.equal( check( 'strategy', { ...STRATEGY, fits: { topic: pattern } } ).result, 'green', pattern );
	}
} );

attack( SUBJECT, 'the summary for the person names what a strategy serves and its moves in order', () => {
	assert.equal( Proposals.summary( 'strategy', STRATEGY ), 'It serves report_delivered with report.draft → report.send.' );
} );

attack( SUBJECT, 'the summary for the person shows everything that changes the choice', () => {
	const _body = { ...STRATEGY, class: [ 'widen', 'direct' ], probe: true, startCurve: { tauH: 2, p0: 0.9 }, fits: { topic: '^design$' }, depth: 1,
		steps: [ { move: 'report.draft', params: { body: 'x' } }, { move: 'report.send', target: 'hr' } ] };
	assert.equal( Proposals.summary( 'strategy', _body ), 'It serves report_delivered with report.draft {"body":"x"} → report.send to hr. Class: widen, direct. '
		+ 'It is a probe. Start curve: {"p0":0.9,"tauH":2}. Fits: {"topic":"^design$"}. Depth: 1.' );
} );

// Moves.

attack( SUBJECT, 'a model move with a role and a step contract is green', () => {
	assert.deepEqual( check( 'move', MOVE ), { result: 'green', problems: [] } );
} );

attack( SUBJECT, 'a move that is not one of the five base moves is red', () => {
	for ( const executor of [ 'shell', 'gate', '__proto__', undefined ] ) {
		red( check( 'move', { ...MOVE, executor } ), /is not one of the five base moves/ );
	}
} );

attacks( SUBJECT, Proposals.FIXED.map( field => ( { name: `a proposed move may not set ${field}`, field } ) ), ( { field } ) => {
	red( check( 'move', { ...MOVE, id: `writer.${field.toLowerCase()}`, [ field ]: field === 'inherit' ? false : null } ), new RegExp( `may not set ${field}` ) );
} );

attack( SUBJECT, 'a model move without a role or a step contract is red', () => {
	red( check( 'move', { ...MOVE, role: undefined } ), /a model move needs a role and a step contract/ );
	red( check( 'move', { ...MOVE, contract: { text: 'free' } } ), /a model move needs a role and a step contract/ );
} );

attacks( SUBJECT, [ '../sandbox/tools/rows.py', 'sandbox/tools/../../bin/x.py', '/etc/passwd', 'sandbox/tools/Rows.py', 'sandbox/tools/rows.sh', undefined ]
	.map( tool => ( { name: `a code move with the tool ${JSON.stringify( tool )} is red`, tool } ) ), ( { tool } ) => {
	red( check( 'move', { id: 'rows.again', executor: 'code', tool, price: 0.1 } ), /a code move runs a sandbox tool/ );
} );

attack( SUBJECT, 'a code move with a sandbox tool that exists is green; one that does not exist is red', () => {
	assert.equal( check( 'move', { id: 'rows.again', executor: 'code', tool: 'sandbox/tools/acceptance.py', price: 0.1 } ).result, 'green' );
	red( check( 'move', { id: 'rows.again', executor: 'code', tool: 'sandbox/tools/nothing.py', price: 0.1 } ), /does not exist/ );
} );

attack( SUBJECT, 'a move whose id exists already is red', () => {
	red( check( 'move', { ...MOVE, id: 'report.draft' } ), /a move report.draft exists already/ );
} );

attack( SUBJECT, 'a move with a negative price is red; one without a price is free', () => {
	red( check( 'move', { ...MOVE, price: -0.5 } ), /the price must be a number/ );
	assert.equal( check( 'move', { ...MOVE, price: undefined } ).result, 'green' );
} );

// Criterion types.

attack( SUBJECT, 'a conjunction of two existing types is green', () => {
	assert.deepEqual( check( 'criterion', CRITERION ), { result: 'green', problems: [] } );
} );

attacks( SUBJECT, [ 'ab', 'Has_caps', 'with-dash', 'x'.repeat( 42 ), '' ].map( type => ( { name: `a criterion type ${JSON.stringify( type.slice( 0, 12 ) )} is no short code`, type } ) ),
	( { type } ) => red( check( 'criterion', { ...CRITERION, type } ), /the type must be a short code/ ) );

attack( SUBJECT, 'a criterion type that exists already is red', () => {
	red( check( 'criterion', { ...CRITERION, type: 'min_group' } ), /a type min_group exists already/ );
} );

attack( SUBJECT, 'a criterion type of fewer than two parts is red', () => {
	red( check( 'criterion', { ...CRITERION, all: [ CRITERION.all[ 0 ] ] } ), /combines at least two existing types/ );
} );

attack( SUBJECT, 'a part of an unknown type is red, also the new type itself', () => {
	red( check( 'criterion', { ...CRITERION, all: [ CRITERION.all[ 0 ], { type: 'teleport' } ] } ), /teleport is no criterion type/ );
	red( check( 'criterion', { ...CRITERION, all: [ CRITERION.all[ 0 ], { type: CRITERION.type } ] } ), /reported_and_counted is no criterion type/ );
} );

attack( SUBJECT, 'a part named after an Object.prototype member is red', () => {
	red( check( 'criterion', { ...CRITERION, all: [ CRITERION.all[ 0 ], { type: 'constructor' } ] } ), /constructor is no criterion type/ );
} );

attacks( SUBJECT, [
	{ name: 'parts given as an object are red, not a crash', all: { a: CRITERION.all[ 0 ], b: CRITERION.all[ 1 ] } },
	{ name: 'a part that is null is red, not a crash', all: [ CRITERION.all[ 0 ], null ] },
], ( { all } ) => {
	assert.doesNotThrow( () => red( check( 'criterion', { ...CRITERION, all } ) ) );
} );

attack( SUBJECT, 'a body of a megabyte is stored and checked without delay', () => {
	const _started = Date.now();
	const _result = check( 'strategy', { ...STRATEGY, describe: 'x'.repeat( 1024 * 1024 ) } );
	assert.equal( _result.result, 'green' );
	assert.ok( Date.now() - _started < 4000 );
} );

attack( SUBJECT, 'mission and author names that look like SQL are stored as given', () => {
	const _proposals = fresh();
	const _version = _proposals.submit( 'strategy', STRATEGY, { mission: '\'; DROP TABLE proposals; --', by: '" OR 1=1 --' } );
	assert.deepEqual( [ _proposals.get( _version ).mission, _proposals.get( _version ).by, _proposals.count() ], [ '\'; DROP TABLE proposals; --', '" OR 1=1 --', 1 ] );
} );
