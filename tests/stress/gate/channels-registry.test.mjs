// The channel registry (AGENCY_CHANNELS): a deployment's own channels, each a class from the overrides that delivers
// the actions it lists. Attacks: files and entries that are no registry, classes that cannot send, actions the table does
// not know or two channels claim, a registry that tries to take the gate's own names; and the way out: an action goes
// through its registered channel, with that channel's own guarantee, everything else into the outbox.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { attack, attacks } from '../hostile.mjs';
import { app, Db, Channels, Actions, gate, reply, people, startGate, quiet } from './fixture.mjs';

const S = 'gate/channels.js';
const MAIN = 'gate/main.js';
const DIR = fs.mkdtempSync( path.join( os.tmpdir(), 'channels-' ) );
after( () => fs.rmSync( DIR, { recursive: true, force: true } ) );

// Channels of a deployment, defined the way an overrides file defines them.
const made = [];
app.define( 'Test.Channel.Mail', [], () => class Mail {
	static IDEMPOTENT = false;
	constructor( { db, options, log } ) {
		Object.assign( this, { db, options, log, sent: [] } );
		made.push( this );
	}

	async send( delivery ) {
		this.sent.push( delivery );
		return { ok: true, receipt: { id: `mail-${this.sent.length}` } };
	}
} );
app.define( 'Test.Channel.Bank', [], () => class Bank {
	static IDEMPOTENT = true;
	async send() { return { ok: true, receipt: { id: 'bank-1' } }; }
} );
app.define( 'Test.Channel.Mute', [], () => class Mute {} );

let counter = 0;
const file = ( registry ) => {
	counter += 1;
	const _file = path.join( DIR, `channels-${counter}.json` );
	fs.writeFileSync( _file, typeof registry === 'string' ? registry : JSON.stringify( registry ) );
	return _file;
};
const actions = Actions.load();
const load = async ( registry, log = null ) => {
	const _db = new Db( ':memory:' );
	const _channels = Channels.create( _db );
	const _added = await Channels.load( _channels, { file: file( registry ), db: _db, actions, log } );
	return { channels: _channels, added: _added, db: _db };
};

attack( S, 'load: a registered channel delivers exactly the actions it lists; the rest stays with the outbox', async () => {
	const { channels } = await load( { mail: { class: 'Test.Channel.Mail', actions: [ 'reply' ] } } );
	assert.equal( Channels.pick( channels, 'reply' ).constructor.name, 'Mail' );
	assert.equal( Channels.pick( channels, 'report' ), channels.outbox );
} );

attack( S, 'load: "*" makes a channel the one of every action without its own', async () => {
	const { channels } = await load( { mail: { class: 'Test.Channel.Mail', actions: [ '*' ] }, bank: { class: 'Test.Channel.Bank', actions: [ 'payment' ] } } );
	assert.equal( Channels.pick( channels, 'report' ).constructor.name, 'Mail' );
	assert.equal( Channels.pick( channels, 'payment' ).constructor.name, 'Bank' );
} );

attack( S, 'load: one channel object serves all its actions, made once with its options and the gate\'s database', async () => {
	const _before = made.length;
	const { channels, db } = await load( { mail: { class: 'Test.Channel.Mail', actions: [ 'reply', 'report' ], options: { from: 'ap@acme.example' } } } );
	assert.equal( made.length, _before + 1 );
	assert.equal( channels.reply, channels.report );
	assert.deepEqual( channels.reply.options, { from: 'ap@acme.example' } );
	assert.equal( channels.reply.db, db );
} );

attack( S, 'load: the gate logs what it registered and whether each keeps the key, never the options', async () => {
	const _logged = [];
	await load( { mail: { class: 'Test.Channel.Mail', actions: [ 'reply' ], options: { from: 'x@y.example' } }, bank: { class: 'Test.Channel.Bank', actions: [ 'payment' ] } },
		{ append: ( kind, data ) => _logged.push( { kind, data } ) } );
	assert.deepEqual( _logged.map( item => item.kind ), [ 'channels_loaded' ] );
	assert.deepEqual( _logged[ 0 ].data.channels.map( item => [ item.name, item.idempotent ] ), [ [ 'mail', false ], [ 'bank', true ] ] );
	assert.ok( !JSON.stringify( _logged ).includes( 'x@y.example' ) );
} );

attack( S, 'load: without a registry file nothing changes', async () => {
	const _db = new Db( ':memory:' );
	const _channels = Channels.create( _db );
	assert.deepEqual( await Channels.load( _channels, { file: null, db: _db, actions } ), [] );
	assert.deepEqual( Object.keys( _channels ), [ 'default', 'outbox' ] );
} );

attacks( S, [
	{ name: 'refused: a registry that is a list', registry: '[]', want: /no JSON object/ },
	{ name: 'refused: a registry that is null', registry: 'null', want: /no JSON object/ },
	{ name: 'refused: broken JSON', registry: '{ "mail": ', want: SyntaxError },
	{ name: 'refused: an entry that is no object', registry: { mail: 'Test.Channel.Mail' }, want: /no object/ },
	{ name: 'refused: a channel named default (the gate\'s own)', registry: { default: { class: 'Test.Channel.Mail', actions: [ 'reply' ] } }, want: /no channel's name/ },
	{ name: 'refused: a channel named outbox (the gate\'s own)', registry: { outbox: { class: 'Test.Channel.Mail', actions: [ 'reply' ] } }, want: /no channel's name/ },
	{ name: 'refused: a channel named __proto__', registry: '{ "__proto__": { "class": "Test.Channel.Mail", "actions": [ "reply" ] } }', want: /no channel's name/ },
	{ name: 'refused: a name with capitals or blanks', registry: { 'My Mail': { class: 'Test.Channel.Mail', actions: [ 'reply' ] } }, want: /no channel's name/ },
	{ name: 'refused: a class that is no class name', registry: { mail: { class: '../mail.js', actions: [ 'reply' ] } }, want: /class must name a class/ },
	{ name: 'refused: a class the overrides do not bring', registry: { mail: { class: 'Acme.Channel.Nowhere', actions: [ 'reply' ] } }, want: /./ },
	{ name: 'refused: a class without send()', registry: { mail: { class: 'Test.Channel.Mute', actions: [ 'reply' ] } }, want: /has no send\(\)/ },
	{ name: 'refused: no actions', registry: { mail: { class: 'Test.Channel.Mail', actions: [] } }, want: /actions must be a list/ },
	{ name: 'refused: actions as one text', registry: { mail: { class: 'Test.Channel.Mail', actions: 'reply' } }, want: /actions must be a list/ },
	{ name: 'refused: an action the table does not know', registry: { mail: { class: 'Test.Channel.Mail', actions: [ 'teleport' ] } }, want: /no action of the table/ },
	{ name: 'refused: an action two channels claim', registry: { a: { class: 'Test.Channel.Mail', actions: [ 'reply' ] }, b: { class: 'Test.Channel.Bank', actions: [ 'reply' ] } },
		want: /delivered by a already/ },
	{ name: 'refused: two channels for every action', registry: { a: { class: 'Test.Channel.Mail', actions: [ '*' ] }, b: { class: 'Test.Channel.Bank', actions: [ '*' ] } },
		want: /delivered by a already/ },
	{ name: 'refused: options that are a list', registry: { mail: { class: 'Test.Channel.Mail', actions: [ 'reply' ], options: [ 1 ] } }, want: /options must be an object/ },
], async ( { registry, want } ) => {
	await assert.rejects( load( registry ), want );
} );

attack( S, 'file: AGENCY_CHANNELS is read relative to the root or as an absolute path; unset is none', () => {
	assert.equal( Channels.file( '' ), null );
	assert.equal( Channels.file( undefined ), null );
	assert.equal( Channels.file( 'deploy/channels.json' ), path.join( app.root, 'deploy/channels.json' ) );
	assert.equal( Channels.file( '/etc/agency/channels.json' ), '/etc/agency/channels.json' );
} );

attack( S, 'way out: an approved reply goes out through the registered mail channel, nothing into the outbox', async () => {
	const { channels } = await load( { mail: { class: 'Test.Channel.Mail', actions: [ 'reply' ] } } );
	const g = gate( { channels } );
	const _result = await g.send( reply( people( 12 ) ) );
	assert.equal( _result.status, 'executed' );
	assert.deepEqual( _result.receipt, { id: 'mail-1' } );
	assert.equal( channels.reply.sent.length, 1 );
	assert.equal( g.outbox().length, 0 );
} );

attack( S, 'way out: a channel that does not keep the key gets one attempt, then the action is unclear for a person', async () => {
	app.define( 'Test.Channel.Flaky', [], () => class Flaky {
		static IDEMPOTENT = false;
		constructor() { this.sent = 0; }
		async send() {
			this.sent += 1;
			return { ok: false, error: 'smtp 451' };
		}
	} );
	const { channels } = await load( { mail: { class: 'Test.Channel.Flaky', actions: [ 'reply' ] } } );
	const g = gate( { channels } );
	const _result = await g.send( reply( people( 12 ) ) );
	assert.equal( _result.status, 'unclear' );
	assert.equal( channels.reply.sent, 1 );
} );

// The gate process loads the registry at its start, before it recovers or sends anything.
attack( MAIN, 'start: the gate registers the channels AGENCY_CHANNELS names', async () => {
	const _silence = quiet();
	const _before = process.env.AGENCY_CHANNELS;
	process.env.AGENCY_CHANNELS = file( { mail: { class: 'Test.Channel.Mail', actions: [ 'reply', 'report' ] } } );
	const _gate = await startGate().finally( () => {
		if ( _before === undefined ) { delete process.env.AGENCY_CHANNELS; } else { process.env.AGENCY_CHANNELS = _before; }
	} );
	try {
		assert.equal( Channels.pick( _gate.main.channels, 'reply' ).constructor.name, 'Mail' );
		assert.equal( Channels.pick( _gate.main.egress.channels, 'report' ).constructor.name, 'Mail', 'the egress sends through the same map' );
		assert.ok( _gate.main.log.since( 0 ).some( item => item.kind === 'channels_loaded' ) );
	} finally {
		await _gate.stop();
		_silence.restore();
	}
} );

attack( MAIN, 'start: a broken registry stops the gate before it listens', async () => {
	const _silence = quiet();
	const _before = process.env.AGENCY_CHANNELS;
	process.env.AGENCY_CHANNELS = file( { mail: { class: 'Test.Channel.Mail', actions: [ 'teleport' ] } } );
	try {
		await assert.rejects( startGate(), /no action of the table/ );
	} finally {
		if ( _before === undefined ) { delete process.env.AGENCY_CHANNELS; } else { process.env.AGENCY_CHANNELS = _before; }
		_silence.restore();
	}
} );
