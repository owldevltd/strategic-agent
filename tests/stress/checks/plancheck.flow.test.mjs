// G2 and 10.4 (Fig. 6): no foreign value into a sensitive parameter, nothing confidential outside unless the goal allows
// it (and then only as a group), and the goal's own flow rules. Plans try to launder labels through intermediate AI
// steps, renamed values, typed-in labels, references to values that do not exist yet, and mixed groups.
import assert from 'node:assert/strict';
import { attack } from '../hostile.mjs';
import { PlanCheck, catalogs, flowCatalog, invoices, survey, contract, plan } from './fixtures.mjs';

const SUBJECT = 'core/check/plancheck.js';
const surveyGoal = survey();
const plainGoal = contract();
const freeGoal = invoices( {}, [] );
const strictGoal = invoices();
const run = ( given, steps, catalog = flowCatalog() ) => new PlanCheck().check( plan( given, steps ), { catalog, contract: given } );
const said = result => result.problems.join( '; ' );
const send = from => ( { move: 'report.send', from, target: 'hr' } );
const payFrom = ( from, extra = {} ) => ( { move: 'pay.send', from, target: 'bank', ...extra } );
const realPay = from => ( { move: 'payment.send', from, target: 'bank' } );

attack( SUBJECT, 'Fig. 6, row 1: a foreign value in a sensitive parameter is refused', () => {
	const _result = run( freeGoal, [ { move: 'prep.foreign', as: 'p' }, payFrom( 'p' ) ] );
	assert.deepEqual( _result.problems, [ 'pay.send: iban would carry foreign into a sensitive parameter (10.4)' ] );
} );

attack( SUBJECT, 'Fig. 6, row 2: confidential data leaving under a goal that does not allow it is refused', () => {
	const _result = run( plainGoal, [ { move: 'rows.read', as: 'rows' }, send( 'rows' ) ] );
	assert.deepEqual( _result.problems, [ 'report.send: body would carry confidential (10.4)' ] );
} );

attack( SUBJECT, 'Fig. 6, row 3: our own value from the master data may fill the sensitive parameter', () => {
	const _result = run( strictGoal, [ { move: 'prep.own', as: 'p' }, payFrom( 'p' ) ] );
	assert.equal( _result.ok, true, said( _result ) );
} );

attack( SUBJECT, 'a value that is own and foreign at once is still foreign in a sensitive parameter', () => {
	const _result = run( freeGoal, [ { move: 'pay.send', params: { iban: 'DE02' }, labels: { iban: [ 'own', 'foreign' ] }, target: 'bank' } ] );
	assert.match( said( _result ), /iban would carry foreign into a sensitive parameter/ );
} );

attack( SUBJECT, 'confidential data computed over a group may leave when the goal allows groups', () => {
	assert.equal( run( surveyGoal, [ { move: 'stats.read', as: 'stats' }, send( 'stats' ) ] ).ok, true );
} );

attack( SUBJECT, 'individual confidential rows may not leave even when the goal allows groups', () => {
	assert.deepEqual( run( surveyGoal, [ { move: 'rows.read', as: 'rows' }, send( 'rows' ) ] ).problems,
		[ 'report.send: body would carry confidential without a group (10.4)' ] );
} );

attack( SUBJECT, 'fifty inheriting AI steps do not turn individual rows into something that may leave', () => {
	const _steps = [ { move: 'rows.read', as: 'v0' } ];
	for ( let i = 1; i <= 50; i++ ) { _steps.push( { move: 'text.write', from: `v${i - 1}`, as: `v${i}` } ); }
	assert.match( said( run( surveyGoal, [ ..._steps, send( 'v50' ) ] ) ), /confidential without a group/ );
} );

attack( SUBJECT, 'a cycle of values a ← b ← a does not wash confidential rows', () => {
	const _steps = [ { move: 'rows.read', as: 'a' }, { move: 'text.write', from: 'a', as: 'b' }, { move: 'text.write', from: 'b', as: 'a' }, send( 'a' ) ];
	assert.match( said( run( plainGoal, _steps ) ), /body would carry confidential \(10\.4\)/ );
} );

attack( SUBJECT, 'two reports in one plan are checked one by one: only the one with rows is refused', () => {
	const _result = run( surveyGoal, [ { move: 'stats.read', as: 'stats' }, { move: 'rows.read', as: 'rows' }, send( 'stats' ), send( 'rows' ) ] );
	assert.deepEqual( _result.problems, [ 'report.send: body would carry confidential without a group (10.4)' ] );
} );

attack( SUBJECT, 'thinking with confidential data is no leak: a plan that never sends it passes', () => {
	assert.equal( run( plainGoal, [ { move: 'rows.read', as: 'rows' }, { move: 'text.write', from: 'rows', as: 'notes' } ] ).ok, true );
} );

attack( SUBJECT, 'foreign text in a report body is no problem of 10.4: the body is not a sensitive parameter', () => {
	assert.equal( run( plainGoal, [ { move: 'mail.read', as: 'mail' }, { move: 'text.write', from: 'mail', as: 'r' }, send( 'r' ) ] ).ok, true );
} );

attack( SUBJECT, 'trusted code that does not inherit may hand on a clean value (by design)', () => {
	assert.equal( run( plainGoal, [ { move: 'rows.read', as: 'rows' }, { move: 'text.clean', from: 'rows', as: 'c' }, send( 'c' ) ] ).ok, true );
} );

attack( SUBJECT, 'G2 reports the labels of every named value of the plan', () => {
	const _result = run( surveyGoal, [ { move: 'mail.read', as: 'mail' }, { move: 'stats.read', as: 'stats' },
		{ move: 'text.write', from: [ 'mail', 'stats' ], as: 'r' }, { move: 'text.write', from: 'mail', as: 'x' } ] );
	assert.deepEqual( _result.labels, { mail: [ 'foreign' ], stats: [ 'confidential' ], r: [ 'foreign', 'confidential' ], x: [ 'foreign' ] } );
} );

// Laundering foreign into the account of a payment.
attack( SUBJECT, 'a foreign invoice read straight into a payment never reaches the account parameter', () => {
	const _result = run( freeGoal, [ { move: 'invoice.read', params: { invoice: 'R-1186' }, as: 'inv' }, realPay( 'inv' ) ], catalogs.invoices() );
	assert.match( said( _result ), /iban would carry foreign into a sensitive parameter/ );
} );

attack( SUBJECT, 'a foreign invoice laundered through the AI request reader never reaches the account parameter', () => {
	const _steps = [ { move: 'invoice.read', params: { invoice: 'R-1186' }, as: 'inv' }, { move: 'request.read', from: 'inv', as: 'req' }, realPay( 'req' ) ];
	assert.match( said( run( freeGoal, _steps, catalogs.invoices() ) ), /iban would carry foreign into a sensitive parameter/ );
} );

attack( SUBJECT, 'with account_from_master in the goal the same laundering is caught, because the account lacks own', () => {
	const _steps = [ { move: 'invoice.read', params: { invoice: 'R-1186' }, as: 'inv' }, { move: 'request.read', from: 'inv', as: 'req' }, realPay( 'req' ) ];
	assert.match( said( run( strictGoal, _steps, catalogs.invoices() ) ), /payment\.send: iban lacks own \(k3\)/ );
} );

attack( SUBJECT, 'the shipped way passes: invoice → payment.prepare (account from master data) → payment', () => {
	const _steps = [ { move: 'invoice.read', params: { invoice: 'R-1186' }, as: 'inv' }, { move: 'payment.prepare', from: 'inv', as: 'prep' }, realPay( 'prep' ) ];
	const _result = run( strictGoal, _steps, catalogs.invoices() );
	assert.equal( _result.ok, true, said( _result ) );
} );

attack( SUBJECT, 'an account typed into the step without a label lacks own under account_from_master', () => {
	const _result = run( strictGoal, [ { move: 'payment.send', params: { invoiceId: 'R-1186', iban: 'DE02', amount: 1 }, target: 'bank' } ], catalogs.invoices() );
	assert.deepEqual( _result.problems, [ 'payment.send: iban lacks own (k3)' ] );
} );

attack( SUBJECT, 'labels written into a step can make a value stricter: a typed account marked foreign is refused', () => {
	const _result = run( freeGoal, [ { move: 'pay.send', params: { iban: 'DE02' }, labels: { iban: [ 'foreign' ] }, target: 'bank' } ] );
	assert.match( said( _result ), /iban would carry foreign/ );
} );

attack( SUBJECT, 'labels written into a step cannot make a foreign value own', () => {
	const _result = run( freeGoal, [ { move: 'prep.foreign', as: 'p' }, payFrom( 'p', { labels: { iban: [ 'own' ] } } ) ] );
	assert.match( said( _result ), /iban would carry foreign/ );
} );

attack( SUBJECT, 'labels written into a step cannot declare individual rows clean', () => {
	const _result = run( plainGoal, [ { move: 'rows.read', as: 'rows' }, { ...send( 'rows' ), labels: { body: [] } } ] );
	assert.match( said( _result ), /body would carry confidential/ );
} );

attack( SUBJECT, 'confidential typed into a step with no inputs is no group', () => {
	const _result = run( surveyGoal, [ { move: 'report.send', target: 'hr', labels: { body: [ 'confidential' ] } } ] );
	assert.match( said( _result ), /confidential without a group/ );
} );

attack( SUBJECT, 'a name reused for a foreign value cannot borrow the field labels of the earlier own value', () => {
	const _result = run( strictGoal, [ { move: 'prep.own', as: 'p' }, { move: 'prep.foreign', as: 'p' }, payFrom( 'p' ) ] );
	assert.match( said( _result ), /iban would carry foreign/ );
} );

attack( SUBJECT, 'a step that reads a value produced only later in the plan is refused', () => {
	const _result = run( plainGoal, [ send( 'rows' ), { move: 'rows.read', as: 'rows' } ] );
	assert.equal( _result.ok, false );
} );

attack( SUBJECT, 'a later step that reuses a name cannot hide what an earlier step sent under that name', () => {
	const _result = run( plainGoal, [ { move: 'rows.read', as: 'x' }, send( 'x' ), { move: 'master.read', as: 'x' } ] );
	assert.match( said( _result ), /body would carry confidential/ );
} );

attack( SUBJECT, 'individual survey rows cannot leave by rewriting the report\'s name with the aggregate after the send', () => {
	const _steps = [
		{ move: 'survey.rows', params: { teams: [ 'design' ] }, as: 'rows' }, { move: 'report.draft', from: 'rows', as: 'r' }, send( 'r' ),
		{ move: 'survey.query', params: { teams: [ 'design' ] }, as: 'r' },
	];
	assert.match( said( run( surveyGoal, _steps, catalogs.survey() ) ), /confidential without a group/ );
} );

attack( SUBJECT, 'a step that reads a value no step produces is refused', () => {
	const _result = run( plainGoal, [ send( 'ghost' ) ] );
	assert.equal( _result.ok, false );
} );

attack( SUBJECT, 'the shipped survey way with individual rows is refused: rows → draft → report', () => {
	const _steps = [ { move: 'survey.rows', params: { teams: [ 'design' ] }, as: 'rows' }, { move: 'report.draft', from: 'rows', as: 'r' }, send( 'r' ) ];
	assert.deepEqual( run( surveyGoal, _steps, catalogs.survey() ).problems, [ 'report.send: body would carry confidential without a group (10.4)' ] );
} );

attack( SUBJECT, 'the shipped survey way with the aggregate passes: query → draft → report', () => {
	const _steps = [ { move: 'survey.query', params: { teams: [ 'design' ] }, as: 'stats' }, { move: 'report.draft', from: 'stats', as: 'r' }, send( 'r' ) ];
	assert.equal( run( surveyGoal, _steps, catalogs.survey() ).ok, true );
} );

attack( SUBJECT, 'individual rows mixed into an aggregate do not leave as a "group"', () => {
	const _steps = [
		{ move: 'survey.query', params: { teams: [ 'design' ] }, as: 'stats' }, { move: 'survey.rows', params: { teams: [ 'design' ] }, as: 'rows' },
		{ move: 'report.draft', from: [ 'stats', 'rows' ], as: 'r' }, send( 'r' ),
	];
	assert.match( said( run( surveyGoal, _steps, catalogs.survey() ) ), /confidential without a group/ );
} );

attack( SUBJECT, 'individual rows handed to the AI coder do not come out clean in its code', () => {
	const _steps = [ { move: 'survey.rows', params: { teams: [ 'design' ] }, as: 'rows' }, { move: 'analysis.write', from: 'rows', as: 'script' }, send( 'script' ) ];
	assert.match( said( run( surveyGoal, _steps, catalogs.survey() ) ), /confidential/ );
} );

attack( SUBJECT, 'flow problems and the budget are reported together', () => {
	const _result = new PlanCheck().check( plan( plainGoal, [ { move: 'rows.read', as: 'rows' }, send( 'rows' ) ] ),
		{ catalog: flowCatalog(), contract: plainGoal, budgetLeft: 0.1 } );
	assert.deepEqual( _result.problems, [ 'report.send: body would carry confidential (10.4)', 'plan costs 0.2, budget left 0.1' ] );
} );

attack( SUBJECT, 'a goal\'s flow rule binds every action of its class, here every money action', () => {
	const _result = run( strictGoal, [ { move: 'master.read', as: 'm' }, { move: 'pay.send', params: { iban: 'DE02' }, target: 'bank' } ] );
	assert.deepEqual( _result.problems, [ 'pay.send: iban lacks own (k3)' ] );
} );
