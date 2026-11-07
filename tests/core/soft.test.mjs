import { test } from 'node:test';
import assert from 'node:assert/strict';
import { use } from '../helper.mjs';
import { office } from '../office.mjs';

const [ SoftCheck ] = await use( 'Core.Check.SoftCheck' );

test( '21: soft gates are key/value of the base setup; they find amounts, exclamation marks and quiet days', () => {
	const _soft = SoftCheck.load();
	assert.equal( _soft.check( 'reply', { body: 'We will not pay the 3,150.00 EUR again.' } )[ 0 ].found, '3,150.00 EUR' );
	assert.equal( _soft.check( 'reply', { body: 'Thanks!' } )[ 0 ].id, 'exclamations' );
	assert.deepEqual( _soft.check( 'payment', { amount: 3150 } ), [], 'payments are not messages' );
	const _quiet = new SoftCheck( { noContactOn: [ 'sun' ] } );
	assert.equal( _quiet.check( 'reply', { body: 'ok' }, new Date( '2026-11-08T12:00:00' ) ).length, 1 );
	assert.match( _soft.instructions( 'reply' ), /Never mention prices.*Address people formally|Address people formally.*Never mention prices/ );
	const _learned = new SoftCheck( { namePrices: false, learned: { namePrices: true, exclamations: false } } );
	assert.equal( _learned.check( 'reply', { body: '50 EUR!' } ).map( flag => flag.id ).join(), 'namePrices,exclamations', 'a learned value never overrides the user' );
	assert.deepEqual( _learned.rules.map( rule => [ rule.id, rule.origin ] ), [ [ 'namePrices', 'user' ], [ 'exclamations', 'learned' ] ] );
} );

// approve(approval) decides at the gate; marked messages carry the broken soft rules in approval.summary.marked.
async function setup( { mission, answers, contract = null, approve = () => true } ) {
	const _office = await office( { mission, answers, approve, by: 'lead' } );
	const _root = await _office.run( contract || _office.mission.contractSpec() );
	return { ..._office, root: _root };
}

const replies = ( ...texts ) => ( { replier: texts.map( text => ( { text } ) ) } );

test( 'a reply that names an amount is reworked once, and the clean text goes out', async () => {
	const _s = await setup( { mission: 'invoices', answers: replies( 'We will not pay the 3,150.00 EUR again.', 'We only pay to accounts in our master data.' ) } );
	const [ _case ] = await _s.runner.newCase( _s.mission.inbound[ 0 ] );
	assert.ok( _s.log.forNode( _case.id ).some( event => event.kind === 'soft_rework' ) );
	assert.deepEqual( _s.outbox.messages( 'supplier' ).map( item => item.params.body ), [ 'We only pay to accounts in our master data.' ] );
} );

test( 'if the rework still breaks the rule, the person sees it marked at the approval; rejecting it is a wall', async () => {
	const _amount = 'We will not pay the 3,150.00 EUR again.';
	const _marked = [];
	const _approve = ( approval ) => {
		if ( !approval.summary.marked?.length ) { return true; }
		_marked.push( approval.summary.marked.map( item => item.id ) );
		return false;
	};
	const _s = await setup( { mission: 'invoices', answers: replies( _amount, _amount ), approve: _approve } );
	const [ _case ] = await _s.runner.newCase( _s.mission.inbound[ 0 ] );
	assert.deepEqual( _marked, [ [ 'namePrices' ] ] );
	assert.ok( _case.walls.some( wall => wall.cause === 'rejected_by_person' ) );
	assert.notEqual( _case.result.status, 'fulfilled' );
	assert.deepEqual( _s.outbox.messages( 'supplier' ), [] );
} );

test( 'what still breaks a soft rule after the rework goes out only after the person approved it marked', async () => {
	const _writer = { writer: [ { text: 'Great news!' }, { text: 'Still great!' } ] };
	const _seen = [];
	const _approve = ( approval ) => {
		_seen.push( approval.summary.marked.map( item => item.id ) );
		return true;
	};
	const _s = await setup( { mission: 'survey', answers: _writer, approve: _approve } );
	assert.equal( _s.root.result.status, 'fulfilled' );
	assert.ok( _seen.some( marked => marked.includes( 'exclamations' ) ) );
	assert.deepEqual( _s.outbox.messages( 'hr' )[ 0 ].params.body, 'Still great!' );
} );
