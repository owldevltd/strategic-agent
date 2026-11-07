// core/mission/mission.js, bundle(): a kind of task written down as a mission folder, from what people approved for it.
// Only what was approved goes in, with who approved it; the gate's approved actions come with the send moves trusted
// code derives; the template is the last goal a person confirmed, its deadline relative again; every file mission.json
// names is in the bundle, and no file it does not name.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { Mission, app } from './fixtures.mjs';

await app.use( [ 'Core.Move.Catalog' ] );
const SUBJECT = 'core/mission/mission.js';
const STRATEGY = { body: { id: 'proposed-1', kind: 'notices', proposed: true, serves: 'report_delivered', steps: [ { move: 'report.draft' } ] }, version: 'v1', approvedBy: 'person ops-lead' };
const MOVE = { body: { id: 'summary.short', executor: 'ai', role: 'writer', contract: { fields: { text: { type: 'string' } } } }, version: 'v2', approvedBy: 'ops-lead' };
const ACTION = { kind: 'action', body: { name: 'notice', entry: { criticality: 'outward', carries: [ 'message' ], says: 'a notice' } } };
const GOAL = { spec: { id: 'notices-x', goal: 'C104 has a notice', deadline: '2026-11-08T00:00:00Z', budget: 20, value: 20, kind: 'notices',
	criteria: [ { id: 'k1', type: 'report_delivered', values: { to: 'C104', topic: 'late', action: 'carries:message' } } ], understood: { backTranslation: 'x' } }, hours: 23.6 };

attacks( SUBJECT, [
	{ name: 'bundle: a kind with path parts is refused', kind: '../x' },
	{ name: 'bundle: a kind in capitals is refused', kind: 'Notices' },
	{ name: 'bundle: no kind is refused', kind: undefined },
], ( { kind } ) => {
	assert.throws( () => Mission.bundle( { kind } ), /no kind of task/ );
} );

attack( SUBJECT, 'bundle: a kind nothing was approved for is its frame only: mission.json and a goal frame', () => {
	const _files = Mission.bundle( { kind: 'notices' } );
	assert.deepEqual( Object.keys( _files ).sort(), [ 'contract.json', 'mission.json' ] );
	assert.deepEqual( _files[ 'mission.json' ], { id: 'notices', title: 'Tasks: notices', kind: 'notices', task: '', contract: 'contract.json' } );
	assert.deepEqual( _files[ 'contract.json' ].criteria, [] );
} );

attack( SUBJECT, 'bundle: the template is the goal a person confirmed, without its id, kind and understanding, its deadline relative', () => {
	const _contract = Mission.bundle( { kind: 'notices', goal: GOAL } )[ 'contract.json' ];
	assert.deepEqual( _contract, { id: 'notices', goal: 'C104 has a notice', deadline: '{{in:24h}}', budget: 20, value: 20, criteria: GOAL.spec.criteria } );
} );

attack( SUBJECT, 'bundle: approved strategies come with who approved them, never with the marks of a proposal or a kind', () => {
	const _files = Mission.bundle( { kind: 'notices', strategies: [ STRATEGY ] } );
	assert.equal( _files[ 'mission.json' ].strategies, 'strategies.json' );
	assert.deepEqual( _files[ 'strategies.json' ], [ { id: 'proposed-1', serves: 'report_delivered', steps: [ { move: 'report.draft' } ], approved: { version: 'v1', by: 'person ops-lead' } } ] );
} );

attack( SUBJECT, 'bundle: an approved move keeps what its registration fixed: it inherits, and is internal', () => {
	const _move = Mission.bundle( { kind: 'notices', moves: [ MOVE ] } )[ 'moves.json' ][ 'summary.short' ];
	assert.deepEqual( [ _move.inherit, _move.criticality, _move.approved.by ], [ true, 'internal', 'ops-lead' ] );
} );

attack( SUBJECT, 'bundle: an approved action is an action of the mission, with the send move trusted code derives for it', () => {
	const _files = Mission.bundle( { kind: 'notices', actions: [ ACTION ] } );
	assert.deepEqual( _files[ 'actions.json' ], { notice: ACTION.body.entry } );
	assert.equal( _files[ 'moves.json' ][ 'notice.send' ].action, 'notice' );
	assert.equal( _files[ 'moves.json' ][ 'notice.send' ].param, 'body' );
} );

attack( SUBJECT, 'bundle: approved master data is grouped by its kind, and mission.json names the file', () => {
	const _master = [ { body: { kind: 'recipient', value: 'finance' } }, { body: { kind: 'recipient', value: 'legal' } }, { body: { kind: 'contact', value: 'C104 a@b.example' } } ];
	const _files = Mission.bundle( { kind: 'notices', master: _master } );
	assert.deepEqual( _files[ 'master.json' ], { recipient: [ 'finance', 'legal' ], contact: [ 'C104 a@b.example' ] } );
	assert.equal( _files[ 'mission.json' ].master, 'master.json' );
} );

attack( SUBJECT, 'bundle: strategy gates in force are rules of the mission, without the marks of the store', () => {
	const _gate = { rule: 'order', before: 'report.draft', after: 'notice.send', id: 'sg-1', scope: 'notices', expires: '2027-01-01', by: 'agent' };
	assert.deepEqual( Mission.bundle( { kind: 'notices', gates: [ _gate ] } )[ 'gates.json' ], [ { rule: 'order', before: 'report.draft', after: 'notice.send' } ] );
} );

attack( SUBJECT, 'bundle: every file mission.json names is there, and only those (actions.json is found by its name)', () => {
	const _files = Mission.bundle( { kind: 'notices', goal: GOAL, strategies: [ STRATEGY ], moves: [ MOVE ], actions: [ ACTION ], master: [ { body: { kind: 'recipient', value: 'x' } } ] } );
	const _meta = _files[ 'mission.json' ];
	const _named = [ _meta.contract, _meta.strategies, _meta.moves, _meta.master ].filter( Boolean );
	assert.deepEqual( [ ..._named, 'actions.json', 'mission.json' ].sort(), Object.keys( _files ).sort() );
} );
