// The cause codes of walls (16.4) are catalog data: a fixed list, what each means, which gate rules produce it, and
// whether it belongs to the strategy (then another strategy may answer it, U3). Walls are compared by these codes
// only, and G4 writes a lesson only with a known code, so every cause the engine can produce must be in the list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attack, attacks, hostile } from '../hostile.mjs';
import { ROOT } from '../../helper.mjs';
import { Causes, Mission, causes, registry, inHours, contract } from './fixtures.mjs';

const SUBJECT = 'core/move/causes.js';
const CODES = causes.codes();
const source = dir => fs.readdirSync( path.join( ROOT, dir ), { recursive: true } ).map( String ).filter( name => name.endsWith( '.js' ) )
	.map( name => fs.readFileSync( path.join( ROOT, dir, name ), 'utf8' ) ).join( '\n' );
const literals = ( text, pattern ) => [ ...new Set( [ ...text.matchAll( pattern ) ].map( match => match[ 1 ] ) ) ].sort();

attacks( SUBJECT, CODES.map( code => ( { name: `the cause ${code} is a code with a meaning, a strategy flag and only its own rules`, code } ) ), ( item ) => {
	const _entry = causes.table[ item.code ];
	assert.match( item.code, /^[a-z][a-z_]{1,40}$/, 'a code the memory and the diagnosis accept' );
	assert.equal( typeof _entry.says, 'string' );
	assert.ok( _entry.says.length > 10 );
	assert.equal( typeof _entry.strategy, 'boolean' );
	assert.equal( causes.ofStrategy( item.code ), _entry.strategy );
	for ( const rule of _entry.rules || [] ) { assert.equal( causes.ofRule( rule ), item.code, rule ); }
} );

attack( SUBJECT, 'no gate rule belongs to two causes', () => {
	const _rules = Object.values( causes.table ).flatMap( entry => entry.rules || [] );
	assert.equal( new Set( _rules ).size, _rules.length );
} );

attack( SUBJECT, 'the catalog shipped with the engine validates without problems', () => {
	assert.deepEqual( causes.validate(), [] );
} );

attack( SUBJECT, 'a gate rule two causes claim belongs to the first, and validate reports the second', () => {
	const _table = new Causes( { first: { says: 'the first cause', rules: [ 'flow' ], strategy: true }, second: { says: 'the second', rules: [ 'flow' ], strategy: false } } );
	assert.equal( _table.ofRule( 'flow' ), 'first' );
	assert.ok( _table.validate().some( problem => /flow/.test( problem ) && /second/.test( problem ) ), _table.validate().join( '; ' ) );
} );

attacks( SUBJECT, [ 'yes', 1, null, undefined ].map( value => ( { name: `a strategy flag ${JSON.stringify( value ) ?? 'undefined'} is no boolean: reported, and no strategy`, value } ) ),
	( item ) => {
		const _table = new Causes( { odd: { says: 'an odd cause', strategy: item.value } } );
		assert.equal( _table.ofStrategy( 'odd' ), false );
		assert.ok( _table.validate().some( problem => /odd: strategy must be true or false/.test( problem ) ) );
	} );

// 16.4: U3 for causes of the strategy (no_reaction, not_reached), U2 for a missing precondition, U4 for the rest.
attacks( SUBJECT, [
	[ 'no_reaction', true ], [ 'not_reached', true ], [ 'precondition_missing', false ], [ 'unachievable', false ], [ 'conflict', false ],
	[ 'expired', false ], [ 'aborted', false ], [ 'escalated', false ],
].map( ( [ code, strategy ] ) => ( { name: `16.4: ${code} ${strategy ? 'belongs to the strategy (U3)' : 'is no question of another strategy'}`, code, strategy } ) ), ( item ) => {
	assert.ok( CODES.includes( item.code ) );
	assert.equal( causes.ofStrategy( item.code ), item.strategy );
} );

// Every cause the engine writes into a wall itself.
const WALLS = [ ...literals( source( 'core' ), /hitWall\(\s*'([a-z_]+)'/g ), 'conflict', 'unachievable', 'aborted' ];
attacks( SUBJECT, WALLS.map( code => ( { name: `the wall cause ${code} the engine writes is in the catalog`, code } ) ), ( item ) => {
	assert.ok( CODES.includes( item.code ), `${item.code} is no code of catalog/causes.json` );
} );

// Every rule the gate can refuse with turns into a cause of the list (human_approval asks a person, it never refuses).
const RULES = ( () => {
	const _fromGate = literals( source( 'gate' ), /rule:\s*'([a-z_]+)'/g );
	const _types = Object.keys( registry.types ).filter( type => registry.types[ type ].KIND === 'invariant' );
	const _sample = { k: 5, key: 'invoiceId', action: 'payment', max: 10, actions: [ 'payment' ], at: inHours( 1 ) };
	const _fromCriteria = _types.flatMap( type => registry.create( { id: 'x', type, values: _sample } ).gateRules().map( rule => rule.rule ) );
	const _fromContract = contract().rules().gate.map( rule => rule.rule );
	return [ ...new Set( [ ..._fromGate, ..._fromCriteria, ..._fromContract ] ) ].filter( rule => rule !== 'human_approval' ).sort();
} )();

attack( SUBJECT, 'the gate and the criteria name at least the refusal rules the paper describes', () => {
	for ( const rule of [ 'action', 'sensitive', 'confidential', 'flow', 'min_group', 'no_difference', 'known_account', 'exactly_once', 'sum_max', 'expires' ] ) {
		assert.ok( RULES.includes( rule ), rule );
	}
} );

attacks( SUBJECT, RULES.map( rule => ( {
	name: `a refusal by the gate rule ${rule} becomes a cause of the list`, rule,
} ) ), ( item ) => {
	assert.ok( CODES.includes( causes.ofRule( item.rule ) ), `${item.rule} → ${causes.ofRule( item.rule )}` );
} );

attacks( SUBJECT, [ 'rejected', 'unclear', 'not_sent', 'expired' ].map( status => ( {
	name: `an end state ${status} of an outside action without a rule becomes a cause of the list`, status,
} ) ), ( item ) => {
	assert.ok( CODES.includes( causes.ofRule( item.status ) ) );
} );

attacks( SUBJECT, [ 'catalog', 'survey', 'invoices' ].map( name => ( { name: `5.6: every cause the ${name} diagnosis reads is a code of the list`, mission: name } ) ), ( item ) => {
	const _causes = item.mission === 'catalog'
		? JSON.parse( fs.readFileSync( path.join( ROOT, 'catalog', 'diagnosis.json' ), 'utf8' ) ).causes : Mission.load( item.mission ).diagnosis;
	assert.ok( Object.keys( _causes ).length > 0 );
	for ( const cause of Object.keys( _causes ) ) { assert.ok( CODES.includes( cause ), cause ); }
} );

attack( SUBJECT, 'a rule nobody mapped keeps its own name: nothing is guessed', () => {
	assert.equal( causes.ofRule( 'teleport' ), 'teleport' );
	assert.equal( CODES.includes( 'teleport' ), false );
} );

attack( SUBJECT, 'hostile rule names keep their own value and never turn into a known cause', () => {
	for ( const { label, value } of hostile( 'strings', 'keys', 'types' ) ) {
		assert.ok( Object.is( causes.ofRule( value ), value ), label );
	}
} );

attack( SUBJECT, 'hostile cause names are never causes of the strategy (fail towards a person, U4)', () => {
	for ( const { label, value } of hostile( 'strings', 'keys', 'types', 'numbers' ) ) {
		assert.equal( causes.ofStrategy( value ), false, label );
	}
	for ( const name of [ 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__' ] ) { assert.equal( causes.ofStrategy( name ), false, name ); }
} );

attack( SUBJECT, 'a cause in other case is another code', () => {
	assert.equal( causes.ofStrategy( 'NO_REACTION' ), false );
	assert.equal( causes.ofRule( 'MIN_GROUP' ), 'MIN_GROUP' );
} );

attack( SUBJECT, 'codes() hands out a copy: changing it changes nothing in the catalog', () => {
	const _codes = causes.codes();
	_codes.push( 'pay_anyway' );
	_codes.length = 0;
	assert.deepEqual( causes.codes(), CODES );
} );

attack( SUBJECT, 'an empty table knows no code, no rule and no strategy', () => {
	const _empty = new Causes( {} );
	assert.deepEqual( [ _empty.codes(), _empty.ofRule( 'min_group' ), _empty.ofStrategy( 'no_reaction' ) ], [ [], 'min_group', false ] );
} );

attack( SUBJECT, 'a cause without rules is a code no rule leads to', () => {
	const _table = new Causes( { lonely: { says: 'x', strategy: true } } );
	assert.deepEqual( [ _table.codes(), _table.ofRule( 'lonely' ), _table.ofStrategy( 'lonely' ) ], [ [ 'lonely' ], 'lonely', true ] );
} );

attack( SUBJECT, 'a cause named __proto__ in the JSON is a code like any other', () => {
	const _table = new Causes( JSON.parse( '{"__proto__": {"says": "x", "rules": ["weird"], "strategy": true}}' ) );
	assert.deepEqual( [ _table.codes(), _table.ofRule( 'weird' ), _table.ofStrategy( '__proto__' ) ], [ [ '__proto__' ], '__proto__', true ] );
} );

attack( SUBJECT, 'a broken entry in the table is refused with a clear error, not a TypeError', () => {
	for ( const table of [ { broken: null }, { broken: { rules: 'min_group' } } ] ) {
		assert.throws( () => new Causes( table ), error => !( error instanceof TypeError ) && /broken/.test( error.message ), JSON.stringify( table ) );
	}
} );

attack( SUBJECT, 'a cause catalog that does not exist is a loud error, not an empty list', () => {
	assert.throws( () => Causes.load( 'catalog/no-such-causes.json' ), /ENOENT/ );
} );

attack( SUBJECT, 'a cause catalog that is no JSON is a loud error', () => {
	const _dir = fs.mkdtempSync( path.join( os.tmpdir(), 'causes-' ) );
	try {
		fs.writeFileSync( path.join( _dir, 'causes.json' ), '{ "no_reaction": ' );
		assert.throws( () => Causes.load( path.relative( ROOT, path.join( _dir, 'causes.json' ) ) ), SyntaxError );
	} finally {
		fs.rmSync( _dir, { recursive: true, force: true } );
	}
} );

attack( SUBJECT, 'a cause catalog from another file is read as given', () => {
	const _dir = fs.mkdtempSync( path.join( os.tmpdir(), 'causes-' ) );
	try {
		fs.writeFileSync( path.join( _dir, 'causes.json' ), '{"too_late": {"says": "late", "rules": ["expires"], "strategy": false}}' );
		const _loaded = Causes.load( path.relative( ROOT, path.join( _dir, 'causes.json' ) ) );
		assert.deepEqual( [ _loaded.codes(), _loaded.ofRule( 'expires' ) ], [ [ 'too_late' ], 'too_late' ] );
	} finally {
		fs.rmSync( _dir, { recursive: true, force: true } );
	}
} );

attack( SUBJECT, 'the catalog shipped with the engine is the one load() reads by default', () => {
	const _file = JSON.parse( fs.readFileSync( path.join( ROOT, 'catalog', 'causes.json' ), 'utf8' ) );
	assert.deepEqual( Causes.load().codes(), Object.keys( _file ) );
} );
