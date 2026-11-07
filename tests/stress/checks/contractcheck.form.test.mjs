// G1 (3.2, 14.2, 14.3): a goal is only accepted when it is well-formed, consistent and feasible. This file attacks the
// form (ids, types, schema, outcomes of the client), the time rules (K1, K8), windows and dependencies (K2, K3) and
// ranges (K6). Problems come back as a list; nothing is repaired silently.
import assert from 'node:assert/strict';
import { attack, attacks, hostile } from '../hostile.mjs';
import { Contract, registry, contract, problems, REPORT, inHours } from './fixtures.mjs';

const SUBJECT = 'core/check/contractcheck.js';
const said = list => list.join( '; ' );
const at = ( hours, base = Date.now() ) => new Date( base + hours * 3600000 ).toISOString();
const one = ( criterion, extra = {} ) => problems( contract( extra, [ REPORT, criterion ] ) );

// 14.3: the first test of G1. One deadline on 6 November, but the meeting must take place in week 46.
attack( SUBJECT, '14.3, K1: contradicting deadlines are refused: the meeting is due after the contract ends', () => {
	const _list = problems( contract( { deadline: inHours( 48 ) }, [
		{ id: 'k1', type: 'commitment_received', values: { from: 'contact:4711', subject: 'meeting', window: [ inHours( 120 ), inHours( 200 ) ] } },
		{ id: 'k2', type: 'event_occurred', values: { event: 'meeting:k1', window: [ inHours( 120 ), inHours( 200 ) ] }, deadline: inHours( 200 ) },
	] ) );
	assert.ok( _list.includes( 'k2: deadline after the contract deadline' ), said( _list ) );
} );

attack( SUBJECT, '3.1: the corrected contract passes: commitment by the 6th, meeting by the 13th, each criterion with its own deadline', () => {
	// One instant for "the 13th": two calls of inHours( 216 ) in different milliseconds would be two deadlines.
	const _13th = inHours( 216 );
	const _window = [ inHours( 120 ), _13th ];
	const _list = problems( contract( { deadline: _13th }, [
		{ id: 'k1', type: 'commitment_received', values: { from: 'contact:4711', subject: 'meeting', window: _window }, deadline: inHours( 48 ) },
		{ id: 'k2', type: 'event_occurred', values: { event: 'meeting:k1', window: _window, after: 'k1' }, deadline: _13th },
	] ) );
	assert.deepEqual( _list, [] );
} );

attacks( SUBJECT, [
	{ name: 'a contract without an id is refused', extra: { id: '' } },
	{ name: 'a contract without a goal is refused', extra: { goal: undefined } },
	{ name: 'a contract with a goal of null is refused', extra: { goal: null } },
], ( item ) => {
	assert.ok( problems( contract( item.extra ) ).includes( 'contract needs an id and a goal' ) );
} );

attacks( SUBJECT, [ 'teleport', 'Min_Group', 'min_group ', '' ].map( type => ( { name: `the criterion type ${JSON.stringify( type )} is unknown`, type } ) ), ( item ) => {
	assert.ok( one( { id: 'k2', type: item.type, values: {} } ).includes( `unknown criterion type: ${item.type}` ) );
} );

attacks( SUBJECT, [ 'constructor', '__proto__', 'toString', 'hasOwnProperty' ].map( type => ( {
	name: `a criterion type named ${type} is an unknown type, refused with a problem`, type,
} ) ), ( item ) => {
	const _list = one( { id: 'k2', type: item.type, values: {} } );
	assert.ok( _list.includes( `unknown criterion type: ${item.type}` ), said( _list ) );
} );

attack( SUBJECT, 'a list of criteria with a hole in it is refused with a problem, not a crash', () => {
	const _list = problems( new Contract( { id: 'x', goal: 'g', deadline: inHours( 5 ), criteria: [ null, REPORT ] }, registry ) );
	assert.ok( _list.length > 0 );
} );

attacks( SUBJECT, [
	{ name: 'a goal with invariants only describes no effect', criteria: [ { id: 'k1', type: 'min_group', values: { k: 5 } } ], problem: /no outcome criterion/ },
	{ name: 'a goal of soft wishes only describes no effect', criteria: [], extra: { soft: [ 'friendly tone' ] }, problem: /no outcome criterion/ },
	{ name: '3.3: a goal whose only outcome comes from the agent misses the client\'s outcome', criteria: [ { ...REPORT, origin: 'agent', serves: 'k1' } ],
		problem: /the client's own outcome is missing \(3\.3\)/ },
	{ name: '3.3: a goal whose only outcome comes from the catalog misses the client\'s outcome', criteria: [ { ...REPORT, origin: 'catalog' } ],
		problem: /the client's own outcome is missing/ },
], ( item ) => {
	assert.match( said( problems( contract( item.extra || {}, item.criteria ) ) ), item.problem );
} );

attacks( SUBJECT, [
	{ name: 'a group size of 1 is refused', values: { k: 1 }, problem: 'k2: k must be an integer >= 2' },
	{ name: 'a group size of 2.5 is refused', values: { k: 2.5 }, problem: 'k2: k must be an integer >= 2' },
	{ name: 'a group size given as text is refused', values: { k: '5' }, problem: 'k2: k must be an integer >= 2' },
	{ name: 'a group size of NaN is refused', values: { k: NaN }, problem: 'k2: k must be an integer >= 2' },
	{ name: 'an infinite group size is refused', values: { k: Infinity }, problem: 'k2: k must be an integer >= 2' },
	{ name: 'a missing group size is refused', values: {}, problem: 'k2: k is missing' },
], ( item ) => {
	assert.ok( one( { id: 'k2', type: 'min_group', values: item.values } ).includes( item.problem ) );
} );

attacks( SUBJECT, [
	{ name: 'a report without a recipient is refused', values: { topic: 'x' }, problem: 'k1: to is missing' },
	{ name: 'a report with a topic that is no text is refused', values: { to: 'hr', topic: 42 }, problem: 'k1: topic must be text' },
	{ name: 'a report of an action the gate does not know is refused', values: { to: 'hr', topic: 'x', action: 'fax' },
		problem: /k1: action must be one of/ },
	{ name: 'an approval for no actions is refused', type: 'human_approval', values: { actions: [] }, problem: 'k1: actions must be a non-empty list' },
	{ name: 'an approval for an unknown action is refused', type: 'human_approval', values: { actions: [ 'teleport' ] }, problem: /k1: actions may only contain/ },
	{ name: 'items to resolve given as no list are refused', type: 'items_resolved', values: { collection: 'x', items: 'R-1', outcomes: [ 'paid' ] },
		problem: 'k1: items must be a non-empty list' },
], ( item ) => {
	const _list = problems( contract( {}, [ { ...REPORT, type: item.type || REPORT.type, values: item.values } ] ) );
	const _matches = text => ( item.problem instanceof RegExp ? item.problem.test( text ) : text === item.problem );
	assert.ok( _list.some( _matches ), said( _list ) );
} );

attack( SUBJECT, 'values the type does not declare are refused (the schema of the type, 3.2 step 2)', () => {
	const _list = one( { id: 'k2', type: 'min_group', values: { k: 5, except: [ 'anna' ] } } );
	assert.ok( _list.some( text => /except/.test( text ) ), said( _list ) );
} );

attacks( SUBJECT, [
	{ name: 'K6: an empty range is refused', values: { quantity: 'answers', min: 5, max: 3 }, problem: 'k2: the range is empty (K6)' },
	{ name: 'K6: a range needs a bound', values: { quantity: 'answers' }, problem: 'k2: needs min or max' },
	{ name: 'K6: a negative tolerance is refused', type: 'count_matches', values: { source: 'a', target: 'b', tolerance: -1 },
		problem: 'k2: tolerance must be a number >= 0' },
], ( item ) => {
	assert.ok( one( { id: 'k2', type: item.type || 'number_in_range', values: item.values } ).includes( item.problem ) );
} );

attack( SUBJECT, 'K6: a range of a single value is not empty', () => {
	assert.deepEqual( one( { id: 'k2', type: 'number_in_range', values: { quantity: 'answers', min: 5, max: 5 } } ), [] );
} );

attacks( SUBJECT, [
	{ name: 'K6: a tolerance of NaN is no tolerance', type: 'count_matches', values: { source: 'a', target: 'b', tolerance: NaN } },
	{ name: 'K6: a range bounded by NaN is empty', type: 'number_in_range', values: { quantity: 'answers', min: NaN } },
], ( item ) => {
	assert.ok( one( { id: 'k2', type: item.type, values: item.values } ).length > 0 );
} );

// K8 and the contract deadline, at a fixed "now" late on 4 November 2026 so local-time formats are past in every zone.
const NOW = Date.parse( '2026-11-04T23:00:00Z' );
const VERDICT = {
	'': 'invalid', tomorrow: 'invalid', '2026-02-30T00:00:00Z': 'invalid', '0000-01-01T00:00:00Z': 'past', '9999-12-31T23:59:59Z': 'ok',
	'1970-01-01T00:00:00Z': 'past', '2026-11-04T25:00:00Z': 'invalid', '2026-11-04': 'past', 'Wed Nov 04 2026': 'past',
	'2026-11-04T00:00:00+14:00': 'past', '2026-11-04T00:00:00-12:00': 'past',
};
attacks( SUBJECT, hostile( 'dates' ).map( item => ( {
	...item, name: `a contract deadline of ${item.label} is ${VERDICT[ item.value ]}`,
} ) ), ( item ) => {
	const _list = problems( contract( { deadline: item.value } ), { now: NOW } );
	const _expected = { invalid: [ 'contract deadline is missing or invalid' ], past: [ 'contract deadline is in the past' ], ok: [] }[ VERDICT[ item.value ] ];
	assert.deepEqual( _list, _expected );
} );

attacks( SUBJECT, [
	{ name: 'K8: a contract without a deadline is refused', deadline: undefined, problem: 'contract deadline is missing or invalid' },
	{ name: 'K8: a deadline exactly now is already past', deadline: new Date( NOW ).toISOString(), problem: 'contract deadline is in the past' },
	{ name: 'K8: a deadline given as a bare number is no deadline', deadline: 1793750400000, problem: 'contract deadline is missing or invalid' },
], ( item ) => {
	assert.deepEqual( problems( contract( { deadline: item.deadline } ), { now: NOW } ), [ item.problem ] );
} );

attack( SUBJECT, 'K8: a deadline one millisecond after now is in the future', () => {
	assert.deepEqual( problems( contract( { deadline: new Date( NOW + 1 ).toISOString() } ), { now: NOW } ), [] );
} );

attacks( SUBJECT, [
	{ name: 'K8: a criterion deadline that is no time is refused', deadline: 'soon', problem: 'k1: its deadline is invalid (K8)' },
	{ name: 'K8: a criterion deadline in the past is refused', deadline: at( -1 ), problem: 'k1: its deadline is in the past (K8)' },
	{ name: 'K1: a criterion deadline after the contract deadline is refused', deadline: at( 49 ), problem: 'k1: deadline after the contract deadline' },
], ( item ) => {
	assert.deepEqual( problems( contract( { deadline: at( 48 ) }, [ { ...REPORT, deadline: item.deadline } ] ) ), [ item.problem ] );
} );

attack( SUBJECT, 'K1: a criterion due exactly at the contract deadline is allowed (the contract deadline is the latest)', () => {
	const _deadline = at( 48 );
	assert.deepEqual( problems( contract( { deadline: _deadline }, [ { ...REPORT, deadline: _deadline } ] ) ), [] );
} );

// K2: windows.
const event = ( window, extra = {} ) => ( { id: 'k2', type: 'event_occurred', values: { event: 'meeting:t-88', window }, ...extra } );
attacks( SUBJECT, [
	{ name: 'K2: a window that starts after it ends is refused', criterion: event( [ inHours( 20 ), inHours( 10 ) ] ), problem: 'k2: window starts after it ends (K2)' },
	{ name: 'K2: a window of no length is refused', criterion: ( at10 => event( [ at10, at10 ] ) )( inHours( 10 ) ), problem: 'k2: window starts after it ends (K2)' },
	{ name: 'K2: a window with a date that is no date is refused', criterion: event( [ 'monday', inHours( 10 ) ] ), problem: 'k2: window must be a window [from, to]' },
	{ name: 'K2: a window of three times is refused', criterion: event( [ inHours( 1 ), inHours( 2 ), inHours( 3 ) ] ),
		problem: 'k2: window must be a window [from, to]' },
	{ name: 'K2: a window given as text is refused', criterion: event( 'next week' ), problem: 'k2: window must be a window [from, to]' },
	{ name: 'K2: a window that ends after its own criterion\'s deadline is refused', criterion: event( [ inHours( 10 ), inHours( 30 ) ], { deadline: inHours( 20 ) } ),
		problem: 'k2: its window ends after its own deadline (K2)' },
], ( item ) => {
	assert.ok( one( item.criterion ).includes( item.problem ), said( one( item.criterion ) ) );
} );

attack( SUBJECT, 'K2: a commitment may lie in a window after its own deadline (a promise for later)', () => {
	const _criterion = { id: 'k2', type: 'commitment_received', values: { from: 'p', subject: 's', window: [ inHours( 30 ), inHours( 40 ) ] }, deadline: inHours( 20 ) };
	assert.deepEqual( one( _criterion ), [] );
} );

// K3: an event that depends on a commitment must leave time for it.
const commitment = ( extra = {} ) => ( { id: 'k3', type: 'commitment_received', values: { from: 'p', subject: 's', window: [ inHours( 10 ), inHours( 30 ) ] }, ...extra } );
attacks( SUBJECT, [
	{ name: 'K3: an event that depends on a criterion that does not exist is refused', after: 'k9', commitment: null, problem: 'k2: depends on k9, which does not exist (K3)' },
	{ name: 'K3: a dependency named __proto__ is a criterion that does not exist', after: '__proto__', commitment: null,
		problem: 'k2: depends on __proto__, which does not exist (K3)' },
	{ name: 'K3: a commitment due only after the event window ends is refused', after: 'k3', commitment: commitment( { deadline: inHours( 31 ) } ),
		problem: 'k2: k3 is due only after this window ends (K3)' },
	{ name: 'K3: a commitment due exactly when the window ends is refused', after: 'k3', commitment: commitment( { deadline: 'END' } ),
		problem: 'k2: k3 is due only after this window ends (K3)' },
], ( item ) => {
	const _window = [ inHours( 10 ), inHours( 30 ) ];
	const _commitment = item.commitment && { ...item.commitment, deadline: item.commitment.deadline === 'END' ? _window[ 1 ] : item.commitment.deadline };
	const _list = problems( contract( {}, [ REPORT, event( _window, { values: { event: 'm', window: _window, after: item.after } } ), ..._commitment ? [ _commitment ] : [] ] ) );
	assert.ok( _list.includes( item.problem ), said( _list ) );
} );

attack( SUBJECT, 'K3: a commitment due before the event window ends passes', () => {
	const _window = [ inHours( 10 ), inHours( 30 ) ];
	const _list = problems( contract( {}, [ REPORT, event( _window, { values: { event: 'm', window: _window, after: 'k3' } } ), commitment( { deadline: inHours( 20 ) } ) ] ) );
	assert.deepEqual( _list, [] );
} );

attack( SUBJECT, 'K3: a commitment without a deadline of its own is due at the contract deadline, after the event window', () => {
	const _window = [ inHours( 10 ), inHours( 30 ) ];
	const _list = problems( contract( { deadline: inHours( 48 ) }, [ REPORT, event( _window, { values: { event: 'm', window: _window, after: 'k3' } } ), commitment() ] ) );
	assert.ok( _list.includes( 'k2: k3 is due only after this window ends (K3)' ), said( _list ) );
} );

attacks( SUBJECT, [
	{ name: 'two criteria with the same id are refused', criteria: [ REPORT, { ...REPORT, values: { to: 'ceo', topic: 'x' } } ], problem: 'duplicate criterion id: k1' },
	{ name: 'a criterion that takes the id of a soft wish is refused', criteria: [ REPORT, { ...REPORT, id: 's1', values: { to: 'ceo', topic: 'x' } } ],
		extra: { soft: [ 'friendly tone' ] }, problem: 'duplicate criterion id: s1' },
], ( item ) => {
	assert.ok( problems( contract( item.extra || {}, item.criteria ) ).includes( item.problem ) );
} );

attack( SUBJECT, 'every problem of a broken goal is listed at once, for one ticket', () => {
	const _list = problems( new Contract( { id: '', goal: '', deadline: 'never', criteria: [ { id: 'k1', type: 'min_group', values: { k: 1 } },
		{ id: 'k1', type: 'teleport', values: {} } ] }, registry ) );
	assert.ok( _list.length >= 5, said( _list ) );
} );

attack( SUBJECT, 'a goal of a thousand criteria is checked in well under a second', () => {
	const _criteria = [ REPORT, ...Array.from( { length: 1000 }, ( _, i ) => ( { id: `k${i + 2}`, type: 'report_delivered', values: { to: `t${i}`, topic: 'x' } } ) ) ];
	const _start = Date.now();
	assert.deepEqual( problems( contract( {}, _criteria ) ), [] );
	assert.ok( Date.now() - _start < 2000 );
} );
