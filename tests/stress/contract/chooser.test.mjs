// core/strategy/chooser.js, part 1: points and eligibility of chapter 19. Points = F_s(remaining time of c) · W − k(s),
// eligible only with F ≥ θ and k ≤ budget left; the most points win, the cheaper one on a tie. Hostile numbers (NaN,
// negative, invalid dates) must never make a strategy eligible, and the choice must be deterministic.
import assert from 'node:assert/strict';
import { attack, attacks, hostile, random } from '../hostile.mjs';
import { Chooser, Node, nodeOf, strategy, inHours, goal } from './fixtures.mjs';

const SUBJECT = 'core/strategy/chooser.js';
const NOW = Date.now();
const choose = ( node, list, options = {} ) => new Chooser().choose( node, list, { now: NOW, ...options } );
const scored = ( result, id ) => result.scored.find( item => item.id === id );
const NUMBER = { id: 'k2', type: 'number_in_range', values: { quantity: 'answers:design', min: 5 } };

attack( SUBJECT, 'an empty catalog chooses nothing and scores nothing', () => {
	assert.deepEqual( choose( nodeOf(), [] ), { chosen: null, scored: [], wall: null, undiagnosed: false } );
} );

attack( SUBJECT, 'the only eligible strategy is chosen as the very catalog entry', () => {
	const _list = [ strategy( 'a' ) ];
	assert.equal( choose( nodeOf(), _list ).chosen, _list[ 0 ] );
} );

attack( SUBJECT, 'points are F(remaining time) times W minus k', () => {
	const _a = scored( choose( nodeOf(), [ strategy( 'a', { price: 3 } ) ] ), 'a' );
	assert.deepEqual( [ _a.chance, _a.points, _a.cost ], [ 0.8, 0.8 * 50 - 3, 3 ] );
} );

attack( SUBJECT, 'the paper\'s example: the mail (18.3 points) beats the phone call (17)', () => {
	const _node = nodeOf( { value: 40, deadline: inHours( 90, NOW ) }, [ { id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'x' }, deadline: inHours( 68, NOW ) } ] );
	const _mail = strategy( 'mail', { price: 1, startCurve: { p0: 0.5, tauH: 20 } } );
	const _phone = strategy( 'phone', { price: 15, startCurve: { p0: 0.8, tauH: 2 } } );
	const _result = choose( _node, [ _phone, _mail ] );
	assert.deepEqual( [ scored( _result, 'mail' ).chance, scored( _result, 'mail' ).points ], [ 0.483, 18.33 ] );
	assert.deepEqual( [ scored( _result, 'phone' ).chance, scored( _result, 'phone' ).points ], [ 0.8, 17 ] );
	assert.equal( _result.chosen.id, 'mail' );
} );

attack( SUBJECT, 'the paper\'s example, a day later: the mail attempt is still open, so the phone call is chosen', () => {
	const _node = nodeOf( { value: 40, deadline: inHours( 90, NOW ) }, [ { id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'x' }, deadline: inHours( 68, NOW ) } ] );
	const _mail = strategy( 'mail', { price: 1, startCurve: { p0: 0.5, tauH: 20 } } );
	const _phone = strategy( 'phone', { price: 15, startCurve: { p0: 0.8, tauH: 2 } } );
	const _result = choose( _node, [ _mail, _phone ], { now: NOW + 24 * 3600000, open: [ { strategy: 'mail', criterion: 'k1' } ] } );
	assert.equal( scored( _result, 'mail' ).reason, 'an attempt of it is still open' );
	assert.equal( _result.chosen.id, 'phone' );
} );

attack( SUBJECT, 'more points win over a cheaper strategy', () => {
	const _result = choose( nodeOf(), [ strategy( 'cheap', { price: 1, startCurve: { p0: 0.3, tauH: 0.001 } } ), strategy( 'good', { price: 5 } ) ] );
	assert.equal( _result.chosen.id, 'good' );
} );

attack( SUBJECT, 'a tie in points goes to the cheaper strategy, whatever the catalog order', () => {
	const _dear = strategy( 'dear', { price: 3, startCurve: { p0: 0.54, tauH: 0.001 } } );
	const _cheap = strategy( 'cheap', { price: 1, startCurve: { p0: 0.5, tauH: 0.001 } } );
	const _result = choose( nodeOf(), [ _dear, _cheap ] );
	assert.equal( scored( _result, 'dear' ).points, scored( _result, 'cheap' ).points );
	assert.equal( _result.chosen.id, 'cheap' );
} );

attack( SUBJECT, 'the choice compares the exact points; rounding is for the record only', () => {
	const _cheap = strategy( 'cheap', { price: 1, startCurve: { p0: 0.5, tauH: 0.001 } } );
	const _more = strategy( 'more', { price: 1.004, startCurve: { p0: 0.5001, tauH: 0.001 } } );
	const _result = choose( nodeOf(), [ _cheap, _more ] );
	assert.equal( scored( _result, 'cheap' ).points, scored( _result, 'more' ).points, 'both read 24 in the record' );
	assert.equal( _result.chosen.id, 'more', '24.001 points beat 24, whatever the price' );
} );

attack( SUBJECT, 'a full tie keeps the catalog order and gives the same choice every time', () => {
	const _list = [ strategy( 'first' ), strategy( 'second' ) ];
	const _ids = Array.from( { length: 5 }, () => choose( nodeOf(), _list ).chosen.id );
	assert.deepEqual( _ids, [ 'first', 'first', 'first', 'first', 'first' ] );
} );

attack( SUBJECT, 'θ is the paper\'s proposal 0.1', () => {
	assert.equal( Chooser.THETA, 0.1 );
} );

attack( SUBJECT, 'a chance of exactly θ is eligible, one just below is not', () => {
	const _result = choose( nodeOf(), [ strategy( 'at', { startCurve: { p0: 0.1, tauH: 0.001 } } ), strategy( 'below', { startCurve: { p0: 0.0999, tauH: 0.001 } } ) ] );
	assert.equal( scored( _result, 'at' ).reason, null );
	assert.equal( scored( _result, 'below' ).reason, 'chance below θ' );
} );

attack( SUBJECT, 'a negative chance is never eligible', () => {
	assert.equal( scored( choose( nodeOf(), [ strategy( 'a', { startCurve: { p0: -0.5, tauH: 1 } } ) ] ), 'a' ).reason, 'chance below θ' );
} );

attack( SUBJECT, 'a chance of NaN is never eligible', () => {
	const _result = choose( nodeOf(), [ strategy( 'a', { startCurve: { p0: Number.NaN } } ) ] );
	assert.equal( _result.chosen, null );
} );

attack( SUBJECT, 'an invalid contract deadline makes no strategy eligible', () => {
	assert.equal( choose( nodeOf( { deadline: 'next friday' } ), [ strategy( 'a' ) ] ).chosen, null );
} );

// The criterion's own deadline, from the hostile date corpus: only a valid time in the future leaves a chance.
attacks( SUBJECT, hostile( 'dates' ).map( ( item ) => {
	const _time = Date.parse( item.value );
	const _eligible = item.value === '' || ( Number.isFinite( _time ) && _time > NOW + 60000 );
	return { ...item, eligible: _eligible, name: `a criterion deadline ${item.label} leaves ${_eligible ? 'a' : 'no'} chance` };
} ), ( { value, eligible } ) => {
	const _node = nodeOf( { deadline: inHours( 48, NOW ) }, [ { id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'x' }, deadline: value } ] );
	assert.equal( choose( _node, [ strategy( 'a' ) ] ).chosen !== null, eligible );
} );

attack( SUBJECT, 'a strategy over the budget left is not eligible; one costing exactly the rest is', () => {
	const _result = choose( nodeOf(), [ strategy( 'over', { price: 5.01 } ), strategy( 'exact', { price: 5 } ) ], { budgetLeft: 5 } );
	assert.equal( scored( _result, 'over' ).reason, 'over budget' );
	assert.equal( _result.chosen.id, 'exact' );
} );

attack( SUBJECT, 'a cost of NaN is never eligible', () => {
	assert.equal( choose( nodeOf(), [ strategy( 'a' ) ], { budgetLeft: 5, cost: () => Number.NaN } ).chosen, null );
} );

attack( SUBJECT, 'a budget left of NaN admits no strategy', () => {
	assert.equal( choose( nodeOf(), [ strategy( 'a' ) ], { budgetLeft: Number.NaN } ).chosen, null );
} );

attack( SUBJECT, 'the default cost is the price, and a price of 0 costs nothing', () => {
	const _result = choose( nodeOf(), [ strategy( 'free', { price: 0 } ), strategy( 'none', { price: undefined } ) ] );
	assert.deepEqual( [ scored( _result, 'free' ).cost, scored( _result, 'none' ).cost ], [ 0, 1 ] );
} );

attack( SUBJECT, 'a cost function given by the runner decides k(s)', () => {
	const _result = choose( nodeOf(), [ strategy( 'a' ), strategy( 'b' ) ], { cost: item => ( item.id === 'a' ? 30 : 2 ) } );
	assert.equal( _result.chosen.id, 'b' );
	assert.equal( scored( _result, 'a' ).points, 0.8 * 50 - 30 );
} );

attack( SUBJECT, 'W is the value of the goal, else its budget, else 1', () => {
	const _points = extra => scored( choose( nodeOf( extra ), [ strategy( 'a', { price: 0 } ) ] ), 'a' ).points;
	assert.deepEqual( [ _points( { value: 10 } ), _points( { budget: 20 } ), _points( { budget: 0 } ) ], [ 8, 16, 0.8 ] );
} );

attack( SUBJECT, 'the chance counts the remaining time of the criterion, not of the contract', () => {
	const _node = nodeOf( { deadline: inHours( 48, NOW ) }, [ { id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'x' }, deadline: inHours( 1, NOW ) } ] );
	const _chance = scored( choose( _node, [ strategy( 'a', { startCurve: { p0: 0.8, tauH: 2 } } ) ] ), 'a' ).chance;
	assert.equal( _chance, Number( ( 0.8 * ( 1 - Math.exp( -0.5 ) ) ).toFixed( 3 ) ) );
} );

attack( SUBJECT, 'a strategy that serves no open outcome is not eligible', () => {
	assert.equal( scored( choose( nodeOf(), [ strategy( 'a', { serves: 'number_in_range' } ) ] ), 'a' ).reason, 'serves no open outcome' );
} );

attack( SUBJECT, 'an outcome already met is served by no strategy any more', () => {
	const _node = nodeOf();
	_node.addFact( { kind: 'delivered', evidenceClass: 'observation', source: 'gate', data: { action: 'report', to: 'hr' } } );
	assert.equal( scored( choose( _node, [ strategy( 'a' ) ] ), 'a' ).reason, 'serves no open outcome' );
} );

attack( SUBJECT, 'a strategy meant for another depth is not eligible; one without a depth fits every depth', () => {
	const _child = new Node( { contract: goal( { criteria: [ { id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'x' } } ] } ), parent: nodeOf() } );
	const _result = choose( _child, [ strategy( 'root', { depth: 0 } ), strategy( 'any' ) ] );
	assert.equal( scored( _result, 'root' ).reason, 'meant for another depth' );
	assert.equal( _result.chosen.id, 'any' );
} );

attack( SUBJECT, 'a strategy meant for another kind of goal is not eligible; one without a kind serves every kind', () => {
	const _result = choose( nodeOf(), [ strategy( 'pay', { kind: 'supplier-payments' } ), strategy( 'any' ) ] );
	assert.equal( scored( _result, 'pay' ).reason, 'meant for another kind of goal' );
	assert.equal( _result.chosen.id, 'any' );
} );

attack( SUBJECT, 'a strategy meant for another concern is not eligible; the matching concern is', () => {
	const _node = nodeOf( { scope: { intent: 'group_question' } } );
	const _result = choose( _node, [ strategy( 'person', { intents: [ 'identify_person' ] } ), strategy( 'group', { intents: [ 'group_question' ] } ) ] );
	assert.equal( scored( _result, 'person' ).reason, 'meant for another concern' );
	assert.equal( _result.chosen.id, 'group' );
} );

attack( SUBJECT, 'without a scope, a strategy that names concerns is not eligible', () => {
	assert.equal( scored( choose( nodeOf(), [ strategy( 'a', { intents: [ 'group_question' ] } ) ] ), 'a' ).reason, 'meant for another concern' );
} );

attack( SUBJECT, '@byPerson serves the outcome a person must confirm, and only that one', () => {
	const _byPerson = nodeOf( {}, [ { id: 'k1', type: 'event_occurred', values: { event: 'x' }, byPerson: true } ] );
	assert.equal( choose( _byPerson, [ strategy( 'ask', { serves: '@byPerson' } ) ] ).chosen.id, 'ask' );
	assert.equal( scored( choose( nodeOf(), [ strategy( 'ask', { serves: '@byPerson' } ) ] ), 'ask' ).reason, 'serves no open outcome' );
} );

attack( SUBJECT, 'fits: the pattern must match the values of the criterion', () => {
	const _invite = strategy( 'invite', { serves: 'number_in_range', fits: { quantity: '^answers:[a-z]+$' } } );
	assert.equal( choose( nodeOf( {}, [ NUMBER ] ), [ _invite ] ).chosen.id, 'invite' );
	const _vague = nodeOf( {}, [ { ...NUMBER, values: { quantity: 'identified reasons', min: 1 } } ] );
	assert.equal( scored( choose( _vague, [ _invite ] ), 'invite' ).reason, 'serves no open outcome' );
} );

attack( SUBJECT, 'fits compares the text form of a value that is no text, and the empty text of a missing one', () => {
	assert.equal( choose( nodeOf( {}, [ NUMBER ] ), [ strategy( 'five', { serves: 'number_in_range', fits: { min: '^5$' } } ) ] ).chosen.id, 'five' );
	assert.equal( choose( nodeOf( {}, [ NUMBER ] ), [ strategy( 'nomax', { serves: 'number_in_range', fits: { max: '^$' } } ) ] ).chosen.id, 'nomax' );
} );

attack( SUBJECT, 'an invalid fits pattern makes that strategy ineligible, never the whole choice', () => {
	const _result = choose( nodeOf(), [ strategy( 'broken', { fits: { topic: '(' } } ), strategy( 'fine' ) ] );
	assert.equal( _result.chosen.id, 'fine' );
} );

attack( SUBJECT, 'every strategy is scored exactly once, with chance, points, cost, rank, probe and reason', () => {
	const _result = choose( nodeOf(), [ strategy( 'a' ), strategy( 'b', { serves: 'x' } ), strategy( 'c', { probe: true } ) ] );
	assert.deepEqual( _result.scored.map( item => item.id ), [ 'a', 'b', 'c' ] );
	assert.ok( _result.scored.every( item => [ 'chance', 'points', 'cost', 'rank', 'probe', 'reason' ].every( key => key in item ) ) );
	assert.equal( scored( _result, 'c' ).probe, true );
} );

attack( SUBJECT, 'chance and points are rounded for the record', () => {
	const _a = scored( choose( nodeOf(), [ strategy( 'a', { price: 0.333333, startCurve: { p0: 0.123456, tauH: 0.001 } } ) ] ), 'a' );
	assert.deepEqual( [ _a.chance, _a.points ], [ 0.123, 5.84 ] );
} );

attack( SUBJECT, 'choosing changes neither the catalog nor the node', () => {
	const _node = nodeOf();
	const _list = [ strategy( 'a' ), strategy( 'b', { probe: true, class: [ 'direct', 'widen' ] } ) ];
	const _before = JSON.stringify( [ _list, _node.contract.spec, _node.walls, _node.facts ] );
	choose( _node, _list, { exclude: 'a', open: [ { strategy: 'b' } ] } );
	assert.equal( JSON.stringify( [ _list, _node.contract.spec, _node.walls, _node.facts ] ), _before );
} );

attack( SUBJECT, 'five thousand strategies are scored without delay', () => {
	const _list = Array.from( { length: 5000 }, ( _item, i ) => strategy( `s${i}`, { price: i % 7, startCurve: { p0: ( i % 10 ) / 10, tauH: 1 } } ) );
	const _started = Date.now();
	const _result = choose( nodeOf(), _list );
	assert.equal( _result.scored.length, 5000 );
	assert.ok( Date.now() - _started < 3000, 'linear, not quadratic, in the size of the catalog' );
} );

// Random catalogs: the chosen strategy is eligible and no eligible one has more points (or the same for less).
attacks( SUBJECT, [ 1, 2, 3, 4, 5, 6 ].map( seed => ( { name: `random catalog ${seed}: the choice is the best eligible strategy`, seed } ) ), ( { seed } ) => {
	const _random = random( seed );
	const _list = Array.from( { length: 40 }, ( _item, i ) => strategy( `r${i}`, {
		price: _random.int( 0, 20 ), serves: _random.pick( [ 'report_delivered', 'number_in_range' ] ), class: _random.pick( [ 'direct', 'widen' ] ),
		startCurve: { p0: _random(), tauH: _random.pick( [ 0.5, 2, 24, 200 ] ) }, ...( _random() < 0.2 ? { kind: 'other' } : {} ),
	} ) );
	const _result = choose( nodeOf(), _list, { budgetLeft: _random.int( 5, 25 ) } );
	const _eligible = _result.scored.filter( item => !item.reason );
	if ( !_result.chosen ) {
		assert.equal( _eligible.length, 0 );
		return;
	}
	const _mine = scored( _result, _result.chosen.id );
	assert.equal( _mine.reason, null );
	assert.ok( _eligible.every( item => item.points < _mine.points || ( item.points === _mine.points && item.cost >= _mine.cost ) ) );
} );

attack( SUBJECT, 'with duplicate strategy ids the chosen strategy is the eligible one', () => {
	const _result = choose( nodeOf(), [ strategy( 'twin', { serves: 'number_in_range' } ), strategy( 'twin' ) ] );
	assert.equal( _result.chosen.serves, 'report_delivered' );
} );
