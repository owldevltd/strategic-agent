// lib/config.js: the settings of the security and demo switches: the origins that may call the gate from a page, the
// demo's extras, the retention of run copies and the sandbox image. Every test works on its own folder without a .env.
import assert from 'node:assert/strict';
import { attack, attacks } from '../hostile.mjs';
import { agency, tempDir, withEnv } from './tools.mjs';

const [ Config ] = await agency.use( [ 'Lib.Config' ] );
const S = 'lib/config.js';
const KEYS = [ 'GATE_UI_ORIGIN', 'CORE_PORT', 'AGENCY_DEMO', 'VAULT_RETENTION_DAYS', 'SANDBOX_IMAGE', 'AGENCY_PROPOSALS' ];
const load = env => withEnv( { ...Object.fromEntries( KEYS.map( key => [ key, undefined ] ) ), ...env }, () => Config.load( tempDir( 'settings' ) ) );

attack( S, 'origins: by default only the core\'s own page, by address and by name', async () => {
	assert.deepEqual( ( await load( {} ) ).gate.origins, [ 'http://127.0.0.1:8090', 'http://localhost:8090' ] );
} );

attack( S, 'origins: follow the core\'s port', async () => {
	assert.deepEqual( ( await load( { CORE_PORT: '9000' } ) ).gate.origins, [ 'http://127.0.0.1:9000', 'http://localhost:9000' ] );
} );

attacks( S, [
	{ name: 'origins: one named origin', value: 'https://office.example.com', want: [ 'https://office.example.com' ] },
	{ name: 'origins: two, separated by a comma', value: 'https://a.example, http://b.example:8080', want: [ 'https://a.example', 'http://b.example:8080' ] },
], async ( { value, want } ) => {
	assert.deepEqual( ( await load( { GATE_UI_ORIGIN: value } ) ).gate.origins, want );
} );

attacks( S, [
	{ name: 'origins: a path is no origin', value: 'https://office.example.com/ui' },
	{ name: 'origins: "*" is no origin', value: '*' },
	{ name: 'origins: an origin without its scheme is refused', value: 'office.example.com' },
	{ name: 'origins: another scheme is refused', value: 'file://office' },
], async ( { value } ) => {
	await assert.rejects( load( { GATE_UI_ORIGIN: value } ) );
} );

attacks( S, [
	{ name: 'demo: unset is off', value: undefined, want: false },
	{ name: 'demo: "0" is off', value: '0', want: false },
	{ name: 'demo: "1" is on', value: '1', want: true },
], async ( { value, want } ) => {
	assert.equal( ( await load( { AGENCY_DEMO: value } ) ).demo, want );
} );

attacks( S, [
	{ name: 'demo: "yes" is refused, not read as on', value: 'yes' },
	{ name: 'demo: "true" is refused', value: 'true' },
], async ( { value } ) => {
	await assert.rejects( load( { AGENCY_DEMO: value } ), /AGENCY_DEMO must be one of 0, 1/ );
} );

attacks( S, [
	{ name: 'retention: unset is 30 days', value: undefined, want: 30 },
	{ name: 'retention: 7 days', value: '7', want: 7 },
], async ( { value, want } ) => {
	assert.equal( ( await load( { VAULT_RETENTION_DAYS: value } ) ).vaultRetentionDays, want );
} );

attacks( S, [
	{ name: 'retention: 0 days is refused', value: '0' },
	{ name: 'retention: a fraction is refused', value: '1.5' },
	{ name: 'retention: a negative number is refused', value: '-3' },
], async ( { value } ) => {
	await assert.rejects( load( { VAULT_RETENTION_DAYS: value } ), /VAULT_RETENTION_DAYS/ );
} );

attacks( S, [
	{ name: 'proposals: unset is off', value: undefined, want: false },
	{ name: 'proposals: "0" is off', value: '0', want: false },
	{ name: 'proposals: "1" is on', value: '1', want: true },
], async ( { value, want } ) => {
	assert.equal( ( await load( { AGENCY_PROPOSALS: value } ) ).proposals, want );
} );

attack( S, 'proposals: "on" is refused, not read as on', async () => {
	await assert.rejects( load( { AGENCY_PROPOSALS: 'on' } ), /AGENCY_PROPOSALS must be one of 0, 1/ );
} );

attack( S, 'sandbox: the image is python:3.12-slim unless one is named', async () => {
	assert.equal( ( await load( {} ) ).sandbox.image, 'python:3.12-slim' );
} );
