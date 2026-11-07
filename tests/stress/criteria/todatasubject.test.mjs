// core/criteria/todatasubject.js: a person's own data goes to that person, and only there (a data access request).
// Attacks think like someone who wants another person's data or a copy at another address: two people in one release,
// an address that is not the one on file, a near copy of it, an id padded or repeated, a target that is no text.
import { assert, attack, attacks, gate, make, release } from './kit.mjs';
import { invariantSuite } from './suites.mjs';

const S = 'core/criteria/todatasubject.js';
const CRITERIA = [ { id: 'k1', type: 'to_data_subject', values: {} } ];
const ON_FILE = [ 'cust-77 max@example.org', 'cust-30 lisa@example.com' ];
const copy = ( cohort, target, extra = {} ) => ( {
	action: 'report', target, params: { body: 'your data' }, labels: { body: [ 'confidential' ] }, cohort, ...extra,
} );
const refused = ( request, master = ON_FILE ) => gate( CRITERIA, request, { master } ).rules.includes( 'data_subject' );

invariantSuite( S, {
	type: 'to_data_subject', values: {},
	clean: () => [ release( [ 'cust-77' ] ), release( null ), release( [ 'cust-30' ] ) ],
	violating: () => [ release( [ 'cust-77' ] ), release( [ 'cust-77', 'cust-30' ] ) ],
} );

attacks( S, [
	{ name: 'check(): a release about nobody is a breach', cohort: [], met: false },
	{ name: 'check(): a release about one person holds', cohort: [ 'cust-77' ], met: true },
	{ name: 'check(): one person listed three times is one person', cohort: [ 'cust-77', 'cust-77', ' cust-77 ' ], met: true },
	{ name: 'check(): two people in one copy is a breach', cohort: [ 'cust-77', 'cust-30' ], met: false },
	{ name: 'check(): a whole team in one copy is a breach', cohort: Array.from( { length: 12 }, ( _x, i ) => `r${i}` ), met: false },
	{ name: 'check(): an entry that is no id is a breach (fail closed)', cohort: [ 'cust-77', { id: 'x' } ], met: false },
], ( { cohort, met } ) => {
	assert.equal( make( 'to_data_subject', {} ).check( [ release( cohort ) ] ).met, met );
} );

attack( S, 'gate: the copy for one person to the address on file for that person goes', () => {
	assert.equal( refused( copy( [ 'cust-77' ], 'max@example.org' ) ), false );
} );

attack( S, 'gate: blanks around the address are no other address', () => {
	assert.equal( refused( copy( [ 'cust-77' ], '  max@example.org ' ) ), false );
} );

attack( S, 'gate: an id padded with blanks is the same person', () => {
	assert.equal( refused( copy( [ ' cust-77 ' ], 'max@example.org' ) ), false );
} );

attacks( S, [
	'm.muster.private@freemail.example', 'MAX@example.org', 'max@example.org.attacker.example', 'max@example.org,evil@example.net',
	'max@example.org\nBcc: evil@example.net', 'lisa@example.com', 'max@example.org ', 'max @example.org', 'cust-77', '', 'max＠example.org',
].map( target => ( { name: `gate: ${JSON.stringify( target ).slice( 0, 40 )} is not the address on file for cust-77`, target } ) ), ( { target } ) => {
	const _refused = refused( copy( [ 'cust-77' ], target ) );
	assert.equal( _refused, target.trim() !== 'max@example.org', target );
} );

attacks( S, [ null, 42, { to: 'max@example.org' }, [ 'max@example.org' ], true ].map( target => ( {
	name: `gate: a target ${JSON.stringify( target )} is no address`, target,
} ) ), ( { target } ) => {
	assert.equal( refused( copy( [ 'cust-77' ], target ) ), true );
} );

attacks( S, [
	{ name: 'gate: two people in one copy never go, not even to one of them', cohort: [ 'cust-77', 'cust-30' ] },
	{ name: 'gate: a copy about nobody never goes', cohort: [] },
	{ name: 'gate: a copy about one person and an empty entry never goes (fail closed)', cohort: [ 'cust-77', '' ] },
	{ name: 'gate: a copy about one person and an object never goes (fail closed)', cohort: [ 'cust-77', { id: 'cust-30' } ] },
	{ name: 'gate: the address of another customer never takes a copy about this one', cohort: [ 'cust-30' ], target: 'max@example.org' },
	{ name: 'gate: a customer that has no address on file gets nothing', cohort: [ 'cust-99' ] },
], ( { cohort, target = 'max@example.org' } ) => {
	assert.equal( refused( copy( cohort, target ) ), true );
} );

attack( S, 'gate: without master data no copy goes anywhere', () => {
	assert.equal( refused( copy( [ 'cust-77' ], 'max@example.org' ), [] ), true );
} );

attack( S, 'gate: a message about nobody (no cohort) is no release: the rule does not stop it', () => {
	assert.equal( refused( { action: 'report', target: 'anyone@example.net', params: { body: 'hello' }, labels: { body: [ 'own' ] } } ), false );
} );

attack( S, 'gate: an action that carries no data is no release of data', () => {
	assert.equal( refused( { action: 'invite', target: 'anyone', params: { questions: 'x' }, labels: { questions: [ 'own' ] }, cohort: [ 'cust-77' ] } ), false );
} );

attack( S, 'gate: an id that looks like an id plus an address cannot make a pair of its own', () => {
	assert.equal( refused( copy( [ 'cust-77 evil@example.net' ], 'max@example.org' ) ), true );
} );

attack( S, 'allows(): confidential data, as a copy for one person, through actions that carry data', () => {
	assert.deepEqual( make( 'to_data_subject', {} ).allows(), [ { label: 'confidential', actions: [ 'carries:data' ], as: 'subject' } ] );
} );

attack( S, 'gateRules(): the gate checks the pair itself', () => {
	assert.deepEqual( make( 'to_data_subject', {} ).gateRules(), [ { rule: 'data_subject', actions: [ 'carries:data' ] } ] );
} );

attacks( S, [
	{ name: 'atLeastAsStrict(): the same type is as strict', other: { type: 'to_data_subject', values: {} }, want: true },
	{ name: 'atLeastAsStrict(): min_group is another rule', other: { type: 'min_group', values: { k: 5 } }, want: false },
	{ name: 'atLeastAsStrict(): nothing is no rule', other: null, want: false },
	{ name: 'atLeastAsStrict(): a type spelled otherwise is another rule', other: { type: 'To_Data_Subject', values: {} }, want: false },
], ( { other, want } ) => {
	assert.equal( make( 'to_data_subject', {} ).atLeastAsStrict( other ), want );
} );
