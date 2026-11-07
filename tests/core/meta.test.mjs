import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';
import { registry, Mission } from '../office.mjs';

const [ Proposals, Catalog, Db ] = await use( 'Core.Meta.Proposals', 'Core.Move.Catalog', 'Lib.Db' );
const mission = Mission.load( 'survey' );
const catalog = Catalog.load( mission );
const known = { catalog, registry, strategies: mission.strategies };
const proposals = () => new Proposals( new Db( ':memory:' ) );

test( '6.1: a strategy proposal may only compose catalog moves; its version is the hash of exactly what is approved', () => {
	const _p = proposals();
	const _good = { id: 'report-twice', serves: 'report_delivered', price: 2, steps: [ { move: 'report.draft' }, { move: 'report.send' } ] };
	const _version = _p.submit( 'strategy', _good, { mission: 'survey', by: 'node-1' } );
	assert.equal( _p.check( _version, known ).result, 'green' );
	assert.notEqual( _p.submit( 'strategy', { ..._good, price: 3 }, { mission: 'survey', by: 'node-1' } ), _version );
	const _bad = _p.submit( 'strategy', { id: 'leak', serves: 'report_delivered', price: 1, steps: [ { move: 'mail.everyone' } ] }, { mission: 'survey', by: 'n' } );
	assert.match( _p.check( _bad, known ).problems.join(), /mail.everyone is not in the catalog/ );
	const _trusted = _p.submit( 'strategy', { id: 'self-approve', serves: 'report_delivered', price: 1, steps: [ { move: 'meta.register' } ] }, { mission: 'survey', by: 'n' } );
	assert.match( _p.check( _trusted, known ).problems.join(), /trusted code of the core/ );
} );

test( '6.1: a new move is a base move with a configuration, never a new base move or an action to the outside', () => {
	const _p = proposals();
	const _check = body => _p.check( _p.submit( 'move', body, { mission: 'survey', by: 'n' } ), known );
	assert.equal( _check( { id: 'summary.short', executor: 'ai', role: 'writer', contract: { fields: { text: { type: 'string' } } }, price: 0.1 } ).result, 'green' );
	assert.match( _check( { id: 'shell.run', executor: 'shell' } ).problems.join(), /not one of the five base moves/ );
	assert.match( _check( { id: 'mail.all', executor: 'code', tool: 'sandbox/tools/acceptance.py', action: 'report' } ).problems.join(), /may not set action/ );
	// 10.4: a proposal can neither launder labels, claim a group, nor produce evidence for a criterion.
	const _writer = { executor: 'ai', role: 'writer', contract: { fields: { text: { type: 'string' } } }, price: 0.1 };
	for ( const [ field, value ] of [ [ 'inherit', false ], [ 'labels', [ 'own' ] ], [ 'group', true ], [ 'fieldLabels', { text: [ 'own' ] } ],
		[ 'fact', 'measured' ], [ 'evidence', [ 'delivered' ] ], [ 'template', '../../etc/passwd' ] ] ) {
		assert.match( _check( { id: `writer.${field.toLowerCase()}`, ..._writer, [ field ]: value } ).problems.join(), new RegExp( `may not set ${field}` ) );
	}
} );

test( '14: a new criterion type combines existing types; once registered it holds only when all its parts hold', () => {
	const _p = proposals();
	const _body = { type: 'reported_and_counted', params: [ 'team' ], all: [
		{ type: 'report_delivered', values: { to: 'hr', topic: '{{team}}' } },
		{ type: 'number_in_range', values: { quantity: 'answers:{{team}}', min: 3 } },
	] };
	const _version = _p.submit( 'criterion', _body, { mission: 'survey', by: 'n' } );
	assert.equal( _p.check( _version, known ).result, 'green' );
	assert.equal( _p.register( _version, { approved: null, runner: null } ), false, 'nothing is registered without a person\'s yes' );
	const _registry = { types: { ...registry.types }, has: type => Boolean( _registry.types[ type ] ) };
	_registry.create = spec => registry.create.call( _registry, spec );
	const _runner = { mission: { id: 'survey', strategies: [] }, catalog, registry: _registry };
	assert.equal( _p.register( _version, { approved: 'person hr-lead', runner: _runner } ), true );
	const _criterion = _registry.create( { id: 'k9', type: 'reported_and_counted', values: { team: 'design' } } );
	const _measured = { id: 'f1', kind: 'measured', evidenceClass: 'observation', data: { quantity: 'answers:design', value: 4 } };
	assert.equal( _criterion.check( [ _measured ] ).met, false, 'the report is still missing' );
	assert.deepEqual( _p.get( _version ).status, 'approved' );
} );

test( '6.2: every catalog entry carries its fields; an outward action shows exactly what the gate\'s action table says', () => {
	for ( const id of [ 'survey', 'invoices' ] ) {
		const _catalog = Catalog.load( Mission.load( id ) );
		assert.deepEqual( _catalog.validate(), [], id );
	}
	const _payment = Catalog.load( Mission.load( 'invoices' ) ).get( 'payment.send' );
	assert.deepEqual( [ _payment.criticality, _payment.sensitive, _payment.commits, _payment.idempotencyH ], [ 'money_or_law', [ 'iban' ], 'payment', 168 ] );
	for ( const strategy of [ ...Mission.load( 'survey' ).strategies, ...Mission.load( 'invoices' ).strategies ] ) {
		assert.ok( strategy.id && strategy.serves && strategy.class && strategy.startCurve && strategy.steps?.length && 'price' in strategy, strategy.id );
	}
} );
