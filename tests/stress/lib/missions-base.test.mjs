// lib/missions.js: where the user's base setup lives (AGENCY_BASE, else catalog/base.json): read as one JSON object,
// none when the file is missing, and a file that is no object stops the start.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attack, attacks } from '../hostile.mjs';
import { agency, tempDir, withEnv, ROOT } from './tools.mjs';

const [ Missions ] = await agency.use( [ 'Lib.Missions' ] );
const S = 'lib/missions.js';
const file = ( text, name = 'base.json' ) => {
	const _file = path.join( tempDir( 'base' ), name );
	fs.writeFileSync( _file, text );
	return _file;
};

attack( S, 'base: without AGENCY_BASE the catalog\'s base setup is read', async () => {
	const _base = await withEnv( { AGENCY_BASE: undefined }, () => Missions.base() );
	assert.deepEqual( _base, JSON.parse( fs.readFileSync( path.join( ROOT, 'catalog/base.json' ), 'utf8' ) ) );
} );

attack( S, 'base: AGENCY_BASE names another file, absolute', async () => {
	const _file = file( '{ "address": "informal" }' );
	assert.deepEqual( await withEnv( { AGENCY_BASE: _file }, () => Missions.base() ), { address: 'informal' } );
} );

attack( S, 'base: AGENCY_BASE relative to the root', () => {
	assert.deepEqual( Missions.base( 'catalog/base.json' ), Missions.base( path.join( ROOT, 'catalog/base.json' ) ) );
} );

attack( S, 'base: a file with a byte-order mark is read', () => {
	assert.deepEqual( Missions.base( file( '﻿{ "dayStartsHour": 9 }' ) ), { dayStartsHour: 9 } );
} );

attack( S, 'base: a missing file is no base setup: every default holds', () => {
	assert.deepEqual( Missions.base( 'catalog/no-such-base.json' ), {} );
} );

attacks( S, [
	{ name: 'base: a list is no base setup', text: '[ 1, 2 ]' },
	{ name: 'base: null is no base setup', text: 'null' },
	{ name: 'base: a text is no base setup', text: '"formal"' },
], ( { text } ) => {
	assert.throws( () => Missions.base( file( text ) ), /the base setup is no JSON object/ );
} );

attack( S, 'base: broken JSON stops the start instead of being read as empty', () => {
	assert.throws( () => Missions.base( file( '{ "address": ' ) ), SyntaxError );
} );
