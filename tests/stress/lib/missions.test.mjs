// lib/missions.js under attack: where a deployment's missions live (AGENCY_MISSIONS), which folders count as
// missions, and the files every mission may bring that core and gate read (master.json, actions.json, criteria.json).
// Attacks: hostile folder names, paths that climb out, one id in two folders, broken JSON, and the action and criterion
// tables a mission tries to change instead of extend.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attack, attacks } from '../hostile.mjs';
import { agency, tempDir, ROOT } from './tools.mjs';

const [ Missions, Actions, Registry ] = await agency.use( [ 'Lib.Missions', 'Lib.Actions', 'Core.Criteria.Registry' ] );
const S = 'lib/missions.js';

// A folder of missions: { id: { 'mission.json': {...}, other files } }.
function folder( missions, name = 'missions' ) {
	const _dir = tempDir( name );
	for ( const [ id, files ] of Object.entries( missions ) ) {
		fs.mkdirSync( path.join( _dir, id ), { recursive: true } );
		for ( const [ file, value ] of Object.entries( files ) ) {
			fs.writeFileSync( path.join( _dir, id, file ), typeof value === 'string' ? value : JSON.stringify( value ) );
		}
	}
	return _dir;
}
const mission = id => ( { 'mission.json': { id } } );

attacks( S, [
	{ name: 'dirs(): unset is the demo folder', value: undefined, want: [ 'missions' ] },
	{ name: 'dirs(): empty is the demo folder', value: '', want: [ 'missions' ] },
	{ name: 'dirs(): only commas and blanks is the demo folder', value: ' , ,, ', want: [ 'missions' ] },
	{ name: 'dirs(): two folders in the order given', value: 'missions,tests/usecases', want: [ 'missions', 'tests/usecases' ] },
	{ name: 'dirs(): blanks around names are no part of them', value: '  missions ,  tests/usecases  ', want: [ 'missions', 'tests/usecases' ] },
	{ name: 'dirs(): a folder named twice counts once', value: 'missions,missions,./missions', want: [ 'missions' ] },
	{ name: 'dirs(): a folder given as a number is a name', value: 42, want: [ '42' ] },
], ( { value, want } ) => {
	assert.deepEqual( Missions.dirs( value ), want.map( name => path.resolve( ROOT, name ) ) );
} );

attack( S, 'dirs(): an absolute folder stays where it is', () => {
	const _dir = tempDir( 'abs' );
	assert.deepEqual( Missions.dirs( _dir ), [ _dir ] );
} );

attack( S, 'all(): the missions of every folder, each with the folder that holds it', () => {
	const _a = folder( { alpha: mission( 'alpha' ) } );
	const _b = folder( { beta: mission( 'beta' ), gamma: mission( 'gamma' ) } );
	assert.deepEqual( Missions.all( [ _a, _b ] ), [ { id: 'alpha', dir: _a }, { id: 'beta', dir: _b }, { id: 'gamma', dir: _b } ] );
} );

attack( S, 'all(): one id in two folders stops the start: which one a goal meant cannot be told apart', () => {
	const _a = folder( { alpha: mission( 'alpha' ) } );
	const _b = folder( { alpha: mission( 'alpha' ) } );
	assert.throws( () => Missions.all( [ _a, _b ] ), /mission alpha is in .* and in / );
} );

attack( S, 'all(): a folder that does not exist holds no missions and stops nothing', () => {
	assert.deepEqual( Missions.all( [ path.join( tempDir( 'gone' ), 'nothing-here' ) ] ), [] );
} );

attack( S, 'all(): a folder without mission.json is no mission', () => {
	const _dir = folder( { alpha: { 'moves.json': {} }, beta: mission( 'beta' ) } );
	assert.deepEqual( Missions.all( [ _dir ] ).map( item => item.id ), [ 'beta' ] );
} );

attacks( S, [ 'Alpha', 'UPPER', '.hidden', '-dash-first', '_under', 'a b', 'a.b', 'a/b', '__proto__', 'x'.repeat( 65 ), 'ümlaut-Gross', 'tab\tname' ]
	.filter( name => !name.includes( '/' ) ).map( name => ( { name: `all(): a folder named ${JSON.stringify( name ).slice( 0, 30 )} is no mission`, folderName: name } ) ), ( { folderName } ) => {
	const _dir = folder( { [ folderName ]: mission( 'x' ), ok: mission( 'ok' ) } );
	assert.deepEqual( Missions.all( [ _dir ] ).map( item => item.id ), [ 'ok' ] );
} );

attacks( S, [ 'a', 'abc-1', 'z_9', '0start', 'ümlaut', 'x'.repeat( 64 ) ].map( name => ( { name: `all(): ${name.slice( 0, 20 )} is a mission id`, id: name } ) ), ( { id } ) => {
	const _dir = folder( { [ id ]: mission( id ) } );
	assert.deepEqual( Missions.all( [ _dir ] ).map( item => item.id ), [ id ] );
} );

attack( S, 'home(): the folder that holds the mission, null for one no folder has', () => {
	const _dir = folder( { alpha: mission( 'alpha' ) } );
	assert.equal( Missions.home( 'alpha', [ _dir ] ), _dir );
	assert.equal( Missions.home( 'beta', [ _dir ] ), null );
} );

attacks( S, [ '__proto__', 'constructor', 'toString', '', '../alpha', 'alpha/../alpha', null, 42 ].map( id => ( { name: `home(): ${JSON.stringify( id )} finds nothing`, id } ) ),
	( { id } ) => {
		const _dir = folder( { alpha: mission( 'alpha' ) } );
		assert.equal( Missions.home( id, [ _dir ] ), null );
	} );

attack( S, 'files(): the JSON a mission brings, read and parsed, only from the missions that have it', () => {
	const _dir = folder( { alpha: { ...mission( 'alpha' ), 'master.json': { account: [ 'A1' ] } }, beta: mission( 'beta' ) } );
	assert.deepEqual( Missions.files( 'master.json', [ _dir ] ).map( item => [ item.id, item.value ] ), [ [ 'alpha', { account: [ 'A1' ] } ] ] );
} );

attack( S, 'files(): a byte order mark in front of the JSON is no part of it', () => {
	const _dir = folder( { alpha: { ...mission( 'alpha' ), 'master.json': '﻿{"account":["A1"]}' } } );
	assert.deepEqual( Missions.files( 'master.json', [ _dir ] )[ 0 ].value, { account: [ 'A1' ] } );
} );

attack( S, 'files(): a file that is not JSON stops with a SyntaxError, never half a table', () => {
	const _dir = folder( { alpha: { ...mission( 'alpha' ), 'actions.json': '{"refund": ' } } );
	assert.throws( () => Missions.files( 'actions.json', [ _dir ] ), SyntaxError );
} );

// The action table: a mission adds actions, never changes one.
const merged = ( actions, base = { payment: { criticality: 'money_or_law', carries: [ 'money' ] } } ) => {
	const _dir = folder( { alpha: { ...mission( 'alpha' ), 'actions.json': actions } } );
	return Actions.merged( base, Missions.files( 'actions.json', [ _dir ] ) );
};

attack( S, 'actions.json: a mission\'s action joins the table', () => {
	const _table = merged( { refund: { criticality: 'money_or_law', carries: [ 'money' ] } } );
	assert.deepEqual( Object.keys( _table ).sort(), [ 'payment', 'refund' ] );
} );

attack( S, 'actions.json: a mission cannot redefine an action of the catalog (payment as internal, say)', () => {
	assert.throws( () => merged( { payment: { criticality: 'internal' } } ), /the action payment is defined already/ );
} );

attack( S, 'actions.json: two missions cannot both define one action', () => {
	const _dir = folder( { alpha: { ...mission( 'alpha' ), 'actions.json': { refund: { criticality: 'outward' } } },
		beta: { ...mission( 'beta' ), 'actions.json': { refund: { criticality: 'internal' } } } } );
	assert.throws( () => Actions.merged( {}, Missions.files( 'actions.json', [ _dir ] ) ), /defined already/ );
} );

attacks( S, [ '__proto__', 'constructor', 'Refund', '1refund', 'refund money', '', 'x'.repeat( 65 ) ].map( name => ( {
	name: `actions.json: ${JSON.stringify( name ).slice( 0, 24 )} is no name for an action`, action: name,
} ) ), ( { action } ) => {
	const _value = `{${JSON.stringify( action )}: { "criticality": "internal" }}`;
	assert.throws( () => merged( _value ), /is no name for an action|defined already/ );
} );

attacks( S, [ [], 'refund', 42, null ].map( value => ( { name: `actions.json: ${JSON.stringify( value )} is no table`, value } ) ), ( { value } ) => {
	assert.throws( () => merged( JSON.stringify( value ) ), /actions.json is no object/ );
} );

attack( S, 'actions.json: the table core and gate load holds the catalog\'s actions whatever the missions add', () => {
	const _table = Actions.load().table;
	for ( const action of [ 'report', 'reply', 'invite', 'payment' ] ) { assert.ok( Object.hasOwn( _table, action ) ); }
} );

attack( S, 'criteria.json: a mission cannot redefine a criterion type of the catalog', async () => {
	const _dir = folder( { alpha: { ...mission( 'alpha' ), 'criteria.json': '{"min_group": "Core.Criteria.SumMax"}' } } );
	const _before = process.env.AGENCY_MISSIONS;
	process.env.AGENCY_MISSIONS = _dir;
	try {
		await assert.rejects( Registry.load(), /the criterion type min_group is defined already/ );
	} finally {
		if ( _before === undefined ) { delete process.env.AGENCY_MISSIONS; } else { process.env.AGENCY_MISSIONS = _before; }
	}
} );

attack( S, 'criteria.json: a mission adds a type under a class it names', async () => {
	const _dir = folder( { alpha: { ...mission( 'alpha' ), 'criteria.json': '{"group_of_ten": "Core.Criteria.MinGroup"}' } } );
	const _before = process.env.AGENCY_MISSIONS;
	process.env.AGENCY_MISSIONS = _dir;
	try {
		const _registry = await Registry.load();
		assert.ok( _registry.has( 'group_of_ten' ) && _registry.has( 'min_group' ) );
	} finally {
		if ( _before === undefined ) { delete process.env.AGENCY_MISSIONS; } else { process.env.AGENCY_MISSIONS = _before; }
	}
} );

attacks( S, [ 'Upper', '__proto__', '1x', 'a-b' ].map( type => ( { name: `criteria.json: ${type} is no type name`, type } ) ), async ( { type } ) => {
	const _dir = folder( { alpha: { ...mission( 'alpha' ), 'criteria.json': `{${JSON.stringify( type )}: "Core.Criteria.MinGroup"}` } } );
	const _before = process.env.AGENCY_MISSIONS;
	process.env.AGENCY_MISSIONS = _dir;
	try {
		await assert.rejects( Registry.load(), /criteria.json maps a type to a class name/ );
	} finally {
		if ( _before === undefined ) { delete process.env.AGENCY_MISSIONS; } else { process.env.AGENCY_MISSIONS = _before; }
	}
} );
