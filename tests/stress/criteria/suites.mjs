// Attacks every criterion type must survive, registered per module: they go through the type's own predicate, so
// each module gets its own run. Outcomes: validity (B2), deadlines (U4), the person as channel (K4), evidence
// classes (B6), malformed facts. Invariants: gate receipts only, rules the gate can enforce, no hidden violations.
import {
	AT, DEADLINE, EXPIRED, VALID, Contract, Hash, assert, attack, ids, implemented, make, ms, noise, registry, relabel, shift, yes,
} from './kit.mjs';

const late = ms( DEADLINE ) + 1;

function strip( list, change ) {
	return list.map( ( item ) => {
		const _copy = { ...item, ...change };
		if ( change.data === undefined ) { delete _copy.data; }
		return _copy;
	} );
}

function shared( subject, { type, values }, defects ) {
	const _opt = key => ( defects[ key ] ? { defect: defects[ key ] } : {} );
	attack( subject, 'describe() is plain data: a JSON round trip keeps it, and its hash ignores the key order of the values', () => {
		const _item = make( type, values, { deadline: DEADLINE, origin: 'catalog', immutable: 1 } );
		const _described = _item.describe();
		assert.deepEqual( Object.keys( _described ).sort(), [ 'byPerson', 'deadline', 'id', 'immutable', 'kind', 'origin', 'serves', 'type', 'values' ] );
		assert.deepEqual( JSON.parse( JSON.stringify( _described ) ), _described );
		const _reversed = Object.fromEntries( Object.entries( values ).reverse() );
		assert.equal( Hash.sha256( make( type, _reversed, { deadline: DEADLINE, origin: 'catalog', immutable: 1 } ).describe() ), Hash.sha256( _described ) );
		assert.equal( _described.immutable, true );
	}, _opt( 'describe' ) );
	attack( subject, 'the catalog maps the type to this class, and the class names the same type', () => {
		const _Type = registry.types[ type ];
		assert.equal( _Type.TYPE, type );
		assert.ok( registry.has( type ) );
		assert.equal( make( type, values ).type, type );
	} );
	attack( subject, 'its values are valid as given, so every other attack starts from a clean criterion', () => {
		assert.deepEqual( make( type, values ).validate(), [] );
	} );
}

// good(): facts that meet the criterion, all stamped AT. refused: evidence classes that must not count.
export function outcomeSuite( subject, { type, values, good, refused = [ 'derivation' ], noClass = true, defects = {} } ) {
	const _opt = key => ( defects[ key ] ? { defect: defects[ key ] } : {} );
	const _check = ( list, extra ) => make( type, values, extra ).check( list );
	shared( subject, { type, values }, defects );
	attack( subject, 'the good evidence meets it, and its evidence names only facts it was given', () => {
		const _facts = good();
		const _result = _check( _facts );
		assert.equal( _result.met, true );
		assert.ok( _result.evidence.length > 0 );
		assert.ok( _result.evidence.every( id => ids( _facts ).includes( id ) ) );
	} );
	attack( subject, 'no facts at all: open, no evidence, and a reason a person can read', () => {
		const _result = _check( [] );
		assert.equal( _result.met, false );
		assert.deepEqual( _result.evidence, [] );
		assert.ok( typeof _result.reason === 'string' && _result.reason.length > 0 );
	} );
	attack( subject, 'B2: superseded evidence counts for nothing', () => {
		assert.equal( _check( relabel( good(), { superseded: true } ) ).met, false );
	} );
	attack( subject, 'B2: evidence past its validity counts for nothing', () => {
		assert.equal( _check( relabel( good(), { validUntil: EXPIRED } ) ).met, false );
	} );
	attack( subject, 'B2: evidence still within its validity counts', () => {
		assert.equal( _check( relabel( good(), { validUntil: VALID } ) ).met, true );
	} );
	attack( subject, 'evidence 1 ms after the criterion\'s own deadline does not count', () => {
		assert.equal( _check( good(), { deadline: shift( AT, -1 ) } ).met, false );
	} );
	attack( subject, 'evidence exactly at the criterion\'s own deadline counts', () => {
		assert.equal( _check( good(), { deadline: AT } ).met, true );
	} );
	attack( subject, 'a deadline written in another zone offset is the same instant', () => {
		assert.equal( _check( good(), { deadline: '2026-11-05T11:00:00.000+01:00' } ).met, true );
		assert.equal( _check( good(), { deadline: '2026-11-05T10:59:59.999+01:00' } ).met, false );
	} );
	attack( subject, 'U4: open after its deadline is impossible, and the reason says why', () => {
		const _result = make( type, values, { deadline: DEADLINE } ).verdict( [], late );
		assert.equal( _result.impossible, true );
		assert.match( _result.reason, /deadline has passed/ );
		assert.doesNotMatch( _result.reason, /^; / );
	} );
	attack( subject, 'U4: open exactly at its deadline is not impossible yet', () => {
		assert.ok( !make( type, values, { deadline: DEADLINE } ).verdict( [], ms( DEADLINE ) ).impossible );
	} );
	attack( subject, 'U4: met before its deadline stays met after it, never impossible', () => {
		const _result = make( type, values, { deadline: DEADLINE } ).verdict( good(), late );
		assert.equal( _result.met, true );
		assert.ok( !_result.impossible );
	} );
	k4( subject, { type, values } );
	attack( subject, 'the good evidence buried among 2000 unrelated facts is still found', () => {
		const _facts = [ ...noise( 1000 ), ...good(), ...noise( 1000, 9 ) ];
		assert.equal( _check( _facts ).met, true );
	} );
	attack( subject, 'the same facts delivered twice give each piece of evidence once', () => {
		const _facts = good();
		const _evidence = _check( [ ..._facts, ..._facts ] ).evidence;
		assert.equal( new Set( _evidence ).size, _evidence.length );
	} );
	attack( subject, 'facts of the right kind without data are ignored, not a crash', () => {
		const _result = _check( strip( good(), {} ) );
		assert.equal( _result.met, false );
	}, _opt( 'noData' ) );
	attack( subject, 'facts of the right kind with data null are ignored, not a crash', () => {
		assert.equal( _check( strip( good(), { data: null } ) ).met, false );
	}, _opt( 'nullData' ) );
	attack( subject, 'the same data under another kind proves nothing', () => {
		assert.equal( _check( good().map( item => ( { ...item, kind: `${item.kind}_x` } ) ) ).met, false );
	} );
	for ( const evidenceClass of refused ) {
		attack( subject, `B6: the same facts as ${evidenceClass} do not meet it`, () => {
			assert.equal( _check( relabel( good(), { evidenceClass } ) ).met, false );
		}, _opt( `class:${evidenceClass}` ) );
	}
	if ( noClass ) {
		attack( subject, 'B6: the same facts without any evidence class do not meet it', () => {
			assert.equal( _check( good().map( ( { evidenceClass: _drop, ...rest } ) => rest ) ).met, false );
		}, _opt( 'noClass' ) );
	}
}

function k4( subject, { type, values } ) {
	const _by = extra => make( type, values, { byPerson: true, deadline: DEADLINE, ...extra } );
	attack( subject, 'K4: a person\'s yes to this criterion meets it when the person is its channel', () => {
		const _yes = yes();
		const _result = _by().verdict( [ _yes ], ms( AT ) );
		assert.equal( _result.met, true );
		assert.deepEqual( _result.evidence, [ _yes.id ] );
	} );
	attack( subject, 'K4: a person\'s yes to another criterion does not', () => {
		assert.equal( _by().verdict( [ yes( 'k2' ) ], ms( AT ) ).met, false );
	} );
	attack( subject, 'K4: a person\'s yes counts for nothing when no person is its channel', () => {
		assert.equal( make( type, values ).verdict( [ yes() ], ms( AT ) ).met, false );
	} );
	attack( subject, 'K4: a person\'s no, a claimed yes, or a yes after the deadline do not meet it', () => {
		assert.equal( _by().verdict( [ yes( 'k1', {}, { choice: 'no' } ) ], ms( AT ) ).met, false );
		assert.equal( _by().verdict( [ yes( 'k1', { evidenceClass: 'claim' } ) ], ms( AT ) ).met, false );
		assert.equal( _by().verdict( [ yes( 'k1', { time: shift( DEADLINE, 1 ) } ) ], ms( AT ) ).met, false );
	} );
}

// clean(): receipts that keep the invariant; violating(): receipts that break it.
export function invariantSuite( subject, { type, values, clean, violating, defects = {} } ) {
	const _opt = key => ( defects[ key ] ? { defect: defects[ key ] } : {} );
	const _check = ( list, extra ) => make( type, values, extra ).check( list );
	shared( subject, { type, values }, defects );
	attack( subject, 'no receipts: it holds, with no evidence and no reason', () => {
		assert.deepEqual( _check( [] ), { met: true, evidence: [], reason: '' } );
	} );
	attack( subject, 'receipts that keep it: it holds', () => {
		assert.equal( _check( clean() ).met, true );
	} );
	attack( subject, 'receipts that break it: it fails, names them as evidence and gives a reason', () => {
		const _facts = violating();
		const _result = _check( _facts );
		assert.equal( _result.met, false );
		assert.ok( _result.reason.length > 0 );
		assert.ok( _result.evidence.length > 0 && _result.evidence.every( id => ids( _facts ).includes( id ) ) );
	} );
	attack( subject, 'the same breach as the agent\'s claim is no receipt: only the gate\'s observations count', () => {
		assert.equal( _check( relabel( violating(), { evidenceClass: 'claim' } ) ).met, true );
		assert.equal( _check( relabel( violating(), { evidenceClass: 'derivation' } ) ).met, true );
	} );
	attack( subject, 'the same breach under another kind of fact is no receipt', () => {
		assert.equal( _check( relabel( violating(), { kind: 'delivery' } ) ).met, true );
	} );
	attack( subject, 'a breach exactly at the criterion\'s own deadline is still a breach', () => {
		assert.equal( _check( violating(), { deadline: AT } ).met, false );
	} );
	attack( subject, 'a breach buried among 2000 unrelated facts and clean receipts is found', () => {
		assert.equal( _check( [ ...noise( 1000 ), ...clean(), ...violating(), ...noise( 1000, 3 ) ] ).met, false );
	} );
	attack( subject, 'it is an invariant: never an outcome to close, no evidence channel needed (K4), offered to the drafter', () => {
		const _item = make( type, values );
		assert.equal( _item.kind, 'invariant' );
		assert.deepEqual( _item.constructor.EVIDENCE, [] );
		assert.ok( registry.list().some( entry => entry.type === type && entry.kind === 'invariant' ) );
		const _contract = new Contract( { id: 'c', goal: 'g', deadline: DEADLINE, criteria: [ { id: 'k1', type, values } ] }, registry );
		assert.deepEqual( [ _contract.outcomes().length, _contract.invariants().length ], [ 0, 1 ] );
	} );
	attack( subject, 'every gate rule it derives is one the gate implements, so it never refuses everything by accident', () => {
		const _rules = make( type, values ).gateRules();
		assert.ok( _rules.length > 0 );
		assert.ok( _rules.every( rule => implemented( rule.rule ) && Array.isArray( rule.actions ) && rule.actions.length > 0 ) );
	} );
	attack( subject, 'the contract tags its derived rules with the criterion and still adds the expiry of the contract', () => {
		const _contract = new Contract( { id: 'c', goal: 'g', deadline: DEADLINE, criteria: [ { id: 'k9', type, values } ] }, registry );
		const _rules = _contract.rules();
		const _all = [ ..._rules.flow, ..._rules.gate, ..._rules.allow ].filter( rule => rule.criterion !== 'contract' );
		assert.ok( _all.length > 0 && _all.every( rule => rule.criterion === 'k9' ) );
		assert.ok( _rules.gate.some( rule => rule.rule === 'expires' && rule.at === DEADLINE ) );
	} );
	attack( subject, 'B1: the same clean receipts delivered twice (same ids) are one receipt each, still clean', () => {
		const _facts = clean();
		assert.equal( _check( [ ..._facts, ..._facts ] ).met, true );
	}, _opt( 'twice' ) );
}
