// Data-flow labels (10.4, Fig. 6): every value carries labels of origin (own, foreign, confidential). A move adds its own
// labels and, if it inherits, all labels of its inputs: derived text is never cleaner than its sources. Only trusted
// code may produce a value without the labels of its inputs. A value computed over a group carries that group.
import assert from 'node:assert/strict';
import { attack, attacks, hostile, random } from '../hostile.mjs';
import { Flow, flowCatalog, move, actions } from './fixtures.mjs';

const SUBJECT = 'core/label/flow.js';
const catalog = flowCatalog( { 'text.raw': move( { executor: 'ai', labels: [] } ), 'person.answer': move( { executor: 'human', labels: [] } ) } );
const infer = steps => Flow.infer( steps, catalog );
const labelsOf = ( steps, name ) => [ ...( infer( steps )[ name ]?.labels || [] ) ].sort();

attack( SUBJECT, 'the three labels of 10.4 are own, foreign and confidential', () => {
	assert.deepEqual( Flow.LABELS, [ 'own', 'foreign', 'confidential' ] );
} );

attacks( SUBJECT, [
	{ name: 'a move without labels that does not inherit makes a value without labels', move: {}, inputs: [ [ 'foreign' ] ], expected: [] },
	{ name: 'a move adds its own labels', move: { labels: [ 'own' ] }, inputs: [], expected: [ 'own' ] },
	{ name: 'an inheriting move carries every label of its inputs', move: { inherit: true }, inputs: [ [ 'foreign' ], [ 'confidential' ] ],
		expected: [ 'confidential', 'foreign' ] },
	{ name: 'an inheriting move with labels of its own carries both', move: { inherit: true, labels: [ 'own' ] }, inputs: [ [ 'foreign' ] ],
		expected: [ 'foreign', 'own' ] },
	{ name: 'the same label from several inputs is carried once', move: { inherit: true }, inputs: [ [ 'foreign', 'foreign' ], [ 'foreign' ] ],
		expected: [ 'foreign' ] },
	{ name: 'an inheriting move with no inputs carries only its own labels', move: { inherit: true, labels: [ 'confidential' ] }, inputs: [],
		expected: [ 'confidential' ] },
	{ name: 'a label the code does not know is kept, never dropped', move: { inherit: true }, inputs: [ [ 'secret' ] ], expected: [ 'secret' ] },
], ( item ) => {
	assert.deepEqual( Flow.derive( item.move, item.inputs ).sort(), item.expected );
} );

attack( SUBJECT, 'deriving never changes the labels of the move or of the inputs', () => {
	const _move = { inherit: true, labels: [ 'own' ] };
	const _inputs = [ [ 'foreign' ] ];
	Flow.derive( _move, _inputs );
	assert.deepEqual( [ _move.labels, _inputs ], [ [ 'own' ], [ [ 'foreign' ] ] ] );
} );

attacks( SUBJECT, [
	{ name: 'a step without from has no inputs', step: {}, expected: [] },
	{ name: 'a step with from as one name has that input', step: { from: 'mail' }, expected: [ 'mail' ] },
	{ name: 'a step with from as a list has every input in order', step: { from: [ 'b', 'a' ] }, expected: [ 'b', 'a' ] },
	{ name: 'a step with an empty from has no inputs', step: { from: '' }, expected: [] },
	{ name: 'a step with an empty list has no inputs', step: { from: [] }, expected: [] },
	{ name: 'a step with from null has no inputs', step: { from: null }, expected: [] },
], ( item ) => {
	assert.deepEqual( Flow.inputs( item.step ), item.expected );
} );

attack( SUBJECT, 'foreign text stays foreign through two inheriting AI steps', () => {
	assert.deepEqual( labelsOf( [
		{ move: 'mail.read', as: 'mail' }, { move: 'text.write', from: 'mail', as: 'summary' }, { move: 'text.write', from: 'summary', as: 'reply' },
	], 'reply' ), [ 'foreign' ] );
} );

attack( SUBJECT, 'a chain of a thousand inheriting steps still carries the foreign label at its end', () => {
	const _steps = [ { move: 'mail.read', as: 'v0' } ];
	for ( let i = 1; i <= 1000; i++ ) { _steps.push( { move: 'text.write', from: `v${i - 1}`, as: `v${i}` } ); }
	assert.deepEqual( labelsOf( _steps, 'v1000' ), [ 'foreign' ] );
} );

attack( SUBJECT, 'a chain that collects foreign at step 1 and confidential at step 500 carries both at step 1000', () => {
	const _steps = [ { move: 'mail.read', as: 'v0' }, { move: 'rows.read', as: 'rows' } ];
	for ( let i = 1; i <= 1000; i++ ) { _steps.push( { move: 'text.write', from: i === 500 ? [ `v${i - 1}`, 'rows' ] : `v${i - 1}`, as: `v${i}` } ); }
	assert.deepEqual( labelsOf( _steps, 'v1000' ), [ 'confidential', 'foreign' ] );
	assert.deepEqual( labelsOf( _steps, 'v499' ), [ 'foreign' ] );
} );

attack( SUBJECT, 'trusted code that does not inherit may produce a clean value from foreign input', () => {
	assert.deepEqual( labelsOf( [ { move: 'mail.read', as: 'mail' }, { move: 'text.clean', from: 'mail', as: 'clean' } ], 'clean' ), [] );
} );

attack( SUBJECT, 'an AI step never launders: it carries its inputs\' labels even when its catalog entry forgets inherit', () => {
	assert.deepEqual( labelsOf( [ { move: 'mail.read', as: 'mail' }, { move: 'text.raw', from: 'mail', as: 'summary' } ], 'summary' ), [ 'foreign' ] );
} );

attack( SUBJECT, 'every input counts: two inputs with different labels give the union', () => {
	assert.deepEqual( labelsOf( [
		{ move: 'mail.read', as: 'mail' }, { move: 'rows.read', as: 'rows' }, { move: 'master.read', as: 'master' },
		{ move: 'text.write', from: [ 'mail', 'rows', 'master' ], as: 'all' },
	], 'all' ), [ 'confidential', 'foreign', 'own' ] );
} );

attack( SUBJECT, 'a step without a name makes no value', () => {
	assert.deepEqual( Object.keys( infer( [ { move: 'mail.read' }, { move: 'mail.read', as: '' } ] ) ), [] );
} );

attack( SUBJECT, 'a step with a move outside the catalog makes no value', () => {
	assert.deepEqual( infer( [ { move: 'mail.forge', as: 'x' } ] ), {} );
} );

attack( SUBJECT, 'the latest step that writes a name decides its labels, as at run time', () => {
	assert.deepEqual( labelsOf( [ { move: 'master.read', as: 'x' }, { move: 'mail.read', as: 'x' } ], 'x' ), [ 'foreign' ] );
	assert.deepEqual( labelsOf( [ { move: 'mail.read', as: 'x' }, { move: 'master.read', as: 'x' } ], 'x' ), [ 'own' ] );
} );

attack( SUBJECT, 'renaming through inheriting steps keeps the label: x → y → x', () => {
	assert.deepEqual( labelsOf( [
		{ move: 'mail.read', as: 'x' }, { move: 'text.write', from: 'x', as: 'y' }, { move: 'text.write', from: 'y', as: 'x' },
	], 'x' ), [ 'foreign' ] );
} );

attack( SUBJECT, 'a step that reads its own name keeps what that name carried', () => {
	assert.deepEqual( labelsOf( [ { move: 'mail.read', as: 'x' }, { move: 'text.write', from: 'x', as: 'x' } ], 'x' ), [ 'foreign' ] );
} );

attack( SUBJECT, 'a cycle a ← b, b ← a ends with both carrying the label that entered it', () => {
	const _values = infer( [ { move: 'mail.read', as: 'a' }, { move: 'text.write', from: 'a', as: 'b' }, { move: 'text.write', from: 'b', as: 'a' } ] );
	assert.deepEqual( [ _values.a.labels, _values.b.labels ], [ [ 'foreign' ], [ 'foreign' ] ] );
} );

attack( SUBJECT, 'a value that no earlier step produced carries nothing (G2 has to refuse such a reference)', () => {
	assert.deepEqual( labelsOf( [ { move: 'text.write', from: 'ghost', as: 'x' }, { move: 'mail.read', as: 'ghost' } ], 'x' ), [] );
} );

attacks( SUBJECT, hostile( 'keys' ).map( item => ( { ...item, name: `a value named ${item.label} carries its label to the step that reads it` } ) ), ( item ) => {
	const _values = infer( [ { move: 'mail.read', as: item.value }, { move: 'text.write', from: item.value, as: 'out' } ] );
	assert.deepEqual( _values.out.labels, item.value ? [ 'foreign' ] : [], 'an empty name is no name' );
} );

attack( SUBJECT, 'a value named __proto__ is an entry of its own, visible with its labels', () => {
	const _values = infer( [ { move: 'mail.read', as: '__proto__' } ] );
	assert.ok( Object.keys( _values ).includes( '__proto__' ) );
} );

attack( SUBJECT, 'reading a prototype name that nobody wrote gives no labels and no crash', () => {
	const _values = infer( [ { move: 'text.write', from: [ 'toString', 'constructor' ], as: 'out' } ] );
	assert.deepEqual( _values.out, { labels: [], group: false } );
} );

attack( SUBJECT, 'a group move makes a group value', () => {
	assert.equal( infer( [ { move: 'stats.read', as: 'stats' } ] ).stats.group, true );
} );

attack( SUBJECT, 'a group stays a group through an inheriting step', () => {
	assert.equal( infer( [ { move: 'stats.read', as: 'stats' }, { move: 'text.write', from: 'stats', as: 'report' } ] ).report.group, true );
} );

attack( SUBJECT, 'a group does not pass through a step that does not inherit', () => {
	assert.equal( infer( [ { move: 'stats.read', as: 'stats' }, { move: 'text.clean', from: 'stats', as: 'x' } ] ).x.group, false );
} );

attack( SUBJECT, 'individual rows are never a group', () => {
	assert.equal( infer( [ { move: 'rows.read', as: 'rows' }, { move: 'text.write', from: 'rows', as: 'report' } ] ).report.group, false );
} );

attack( SUBJECT, 'two groups together are still a group', () => {
	const _values = infer( [ { move: 'stats.read', as: 'a' }, { move: 'stats.read', as: 'b' }, { move: 'text.write', from: [ 'a', 'b' ], as: 'report' } ] );
	assert.equal( _values.report.group, true );
} );

attack( SUBJECT, 'a group with our own master data is still a group: nothing individual came in', () => {
	const _values = infer( [ { move: 'stats.read', as: 'a' }, { move: 'master.read', as: 'b' }, { move: 'text.write', from: [ 'a', 'b' ], as: 'r' } ] );
	assert.equal( _values.r.group, true );
} );

attack( SUBJECT, 'a group mixed with individual confidential rows is no longer a group', () => {
	const _values = infer( [
		{ move: 'stats.read', as: 'stats' }, { move: 'rows.read', as: 'rows' }, { move: 'text.write', from: [ 'stats', 'rows' ], as: 'report' },
	] );
	assert.deepEqual( _values.report, { labels: [ 'confidential' ], group: false } );
} );

attack( SUBJECT, 'inferring changes nothing in the plan', () => {
	const _steps = [ { move: 'mail.read', as: 'm' }, { move: 'text.write', from: [ 'm' ], as: 'r' } ];
	const _copy = structuredClone( _steps );
	infer( _steps );
	assert.deepEqual( _steps, _copy );
} );

attack( SUBJECT, 'fuzz: in 300 seeded random plans no inheriting step is ever cleaner than any of its inputs', () => {
	const _next = random( 17 );
	const _moves = [ 'mail.read', 'rows.read', 'stats.read', 'master.read', 'text.write', 'text.clean' ];
	for ( let round = 0; round < 300; round++ ) {
		const _steps = [];
		for ( let i = 0; i < _next.int( 1, 12 ); i++ ) {
			const _from = Array.from( { length: _next.int( 0, 3 ) }, () => `v${_next.int( 0, 6 )}` );
			_steps.push( { move: _next.pick( _moves ), from: _from, as: `v${_next.int( 0, 6 )}` } );
		}
		const _seen = {};
		for ( let i = 0; i < _steps.length; i++ ) {
			const _step = _steps[ i ];
			const _out = Flow.infer( _steps.slice( 0, i + 1 ), catalog )[ _step.as ];
			const _move = catalog.get( _step.move );
			assert.ok( ( _move.labels || [] ).every( label => _out.labels.includes( label ) ) );
			if ( _move.inherit ) {
				const _in = _step.from.flatMap( name => _seen[ name ]?.labels || [] );
				assert.ok( _in.every( label => _out.labels.includes( label ) ), JSON.stringify( _steps ) );
			}
			_seen[ _step.as ] = _out;
		}
	}
} );

// The goal's own flow rules for one outgoing action.
const rules = [
	{ actions: [ 'carries:money' ], param: 'iban', mustHave: [ 'own' ], criterion: 'k3' },
	{ actions: [ 'report' ], param: 'body', mustNot: [ 'foreign' ], criterion: 'k7' },
];

attacks( SUBJECT, [
	{ name: 'an account that is our own value passes the rule', action: 'payment', labels: { iban: [ 'own' ] }, expected: [] },
	{ name: 'an account without own lacks it', action: 'payment', labels: { iban: [ 'foreign' ] }, expected: [ 'iban lacks own (k3)' ] },
	{ name: 'a parameter nobody labelled lacks own', action: 'payment', labels: {}, expected: [ 'iban lacks own (k3)' ] },
	{ name: 'own and foreign together still lack nothing but are caught by the sensitive rule elsewhere', action: 'payment',
		labels: { iban: [ 'own', 'foreign' ] }, expected: [] },
	{ name: 'a rule for another action does not apply', action: 'reply', labels: { body: [ 'foreign' ], iban: [] }, expected: [] },
	{ name: 'a forbidden label in the report body is found', action: 'report', labels: { body: [ 'foreign' ] }, expected: [ 'body would carry foreign (k7)' ] },
	{ name: 'a clean report body passes', action: 'report', labels: { body: [ 'confidential' ] }, expected: [] },
], ( item ) => {
	assert.deepEqual( Flow.violations( rules, item.action, item.labels, actions ), item.expected );
} );

attack( SUBJECT, 'a rule without actions applies to every action', () => {
	assert.deepEqual( Flow.violations( [ { param: 'x', mustNot: [ 'foreign' ], criterion: 'k1' } ], 'invite', { x: [ 'foreign' ] }, actions ),
		[ 'x would carry foreign (k1)' ] );
} );

attack( SUBJECT, 'a rule for every action (*) applies to payments too', () => {
	assert.deepEqual( Flow.violations( [ { actions: [ '*' ], param: 'iban', mustHave: [ 'own' ], criterion: 'k1' } ], 'payment', {}, actions ),
		[ 'iban lacks own (k1)' ] );
} );

attack( SUBJECT, 'a rule with both lists reports both violations', () => {
	const _rule = { actions: [ 'outward' ], param: 'body', mustNot: [ 'confidential' ], mustHave: [ 'own' ], criterion: 'k2' };
	assert.deepEqual( Flow.violations( [ _rule ], 'reply', { body: [ 'confidential' ] }, actions ), [ 'body would carry confidential (k2)', 'body lacks own (k2)' ] );
} );

attack( SUBJECT, 'no rules, no violations', () => {
	assert.deepEqual( Flow.violations( [], 'payment', { iban: [ 'foreign' ] }, actions ), [] );
} );

attack( SUBJECT, 'a rule about a parameter named like a prototype property is checked, not a crash', () => {
	const _rule = { actions: [ '*' ], param: 'constructor', mustHave: [ 'own' ], criterion: 'k3' };
	assert.deepEqual( Flow.violations( [ _rule ], 'payment', {}, actions ), [ 'constructor lacks own (k3)' ] );
} );
