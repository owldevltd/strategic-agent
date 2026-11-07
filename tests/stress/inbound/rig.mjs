// Shared rig of the inbound stress tests: fake nodes and a bare runner around the real Intake, Expectations, Board,
// Vault, Index and Memory, temporary folders under the system's temp dir, and hostile model providers. Nothing here
// talks to the network, a live model or the real .env.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { use } from '../../helper.mjs';

export const [ Db, EventLog, Hash, Expectations, Intake, Cases, Board, Capacity, Vault, Index, Memory, StubProvider, ReadCheck ] =
	await use(
		'Lib.Db', 'Lib.EventLog', 'Lib.Hash', 'Core.Inbound.Expectations', 'Core.Inbound.Intake', 'Core.Inbound.Cases', 'Core.Ticket.Board',
		'Core.Budget.Capacity', 'Core.Vault.Vault', 'Core.Knowledge.Index', 'Core.Memory.Memory', 'Core.Ai.StubProvider', 'Core.Check.ReadCheck',
	);

export const HOUR = 3600000;
export const T0 = Date.parse( '2026-11-04T10:00:00Z' );

const _cleanup = [];
after( () => _cleanup.splice( 0 ).forEach( fn => fn() ) );

// A folder someone else made for the test (an office's vault copy), removed when the test file ends.
export function forget( dir ) {
	if ( dir && dir.startsWith( os.tmpdir() + path.sep ) ) {
		_cleanup.push( () => fs.rmSync( dir, { recursive: true, force: true } ) );
	}
}

// A fresh folder below the system's temp dir, removed when the test file ends.
export function tmp( prefix = 'inbound-' ) {
	const _dir = fs.mkdtempSync( path.join( os.tmpdir(), `stress-${prefix}` ) );
	_cleanup.push( () => fs.rmSync( _dir, { recursive: true, force: true } ) );
	return _dir;
}

export function memoryDb() {
	return new Db( ':memory:' );
}

// Runs fn and says what came of it, so a test can accept either a refusal or a safe result.
export function tryIt( fn ) {
	try {
		return { value: fn() };
	} catch ( error ) {
		return { error };
	}
}

export function sleep( ms ) {
	return new Promise( resolve => setTimeout( resolve, ms ) );
}

// A node as the inbound side sees it: an id, a state, a contract with deadline and hash, and an event list.
export function fakeNode( id = 'node-a', options = {} ) {
	const { deadline = new Date( Date.now() + 24 * HOUR ).toISOString(), hash = `hash-${id}`, state = 'waiting' } = options;
	const _events = [];
	return {
		id, state, contract: { deadline, hash }, events: _events,
		emit: ( kind, data ) => _events.push( { kind, data } ),
		of: kind => _events.filter( event => event.kind === kind ).map( event => event.data ),
	};
}

// A board whose sweep never runs by itself; tests call expire() when they need it.
export function quietBoard( log = new EventLog( memoryDb(), 'core' ), options = {} ) {
	const _board = new Board( log, { sweepMs: 2 ** 30, ...options } );
	clearInterval( _board._sweep );
	return _board;
}

// A person who answers every ticket the board shows with choose( ticket ) (null: not yet).
export function person( board, choose ) {
	const _timer = setInterval( () => {
		for ( const ticket of board.list() ) {
			const _choice = choose( ticket );
			if ( _choice !== null && ticket.options.includes( _choice ) ) { board.answer( ticket.id, { choice: _choice, by: 'lead' } ); }
		}
	}, 1 );
	_cleanup.push( () => clearInterval( _timer ) );
	return () => clearInterval( _timer );
}

// A provider object as Intake uses it: one function per role; a role without one fails like a broken model.
export function provider( roles = {} ) {
	const _calls = [];
	return {
		calls: _calls,
		async complete( request ) {
			_calls.push( request );
			const _fn = roles[ request.role ];
			if ( !_fn ) { throw new Error( `no answer for ${request.role}` ); }
			return typeof _fn === 'function' ? _fn( request ) : _fn;
		},
	};
}

// The real Intake and Expectations on a bare runner: nodes it knows, what it delivered, which attempts got a signal.
export function inbound( setup = {} ) {
	const { model = null, board = null, vault = null, directory = null, now = undefined, db = memoryDb(), seen = null } = setup;
	const _log = new EventLog( db, 'core' );
	const _expectations = new Expectations( db, now ? { now } : {} );
	const _delivered = [];
	const _signals = [];
	const _runner = {
		mission: { id: 'survey' }, nodes: new Map(),
		deliver: ( node, fact ) => {
			_delivered.push( { node: node.id, fact } );
			return node.state !== 'closed';
		},
		journal: { signal: ( attempt ) => {
			_signals.push( attempt );
			return { attempt, signal: true };
		} },
	};
	const _intake = new Intake( { expectations: _expectations, provider: model, board, vault, runner: _runner, log: _log, directory } );
	if ( seen ) { _intake._seen = seen; }
	const _rig = {
		db, log: _log, expectations: _expectations, intake: _intake, runner: _runner, delivered: _delivered, signals: _signals,
		events: kind => _log.since( 0, 100000 ).filter( event => event.kind === kind ).map( event => event.data ),
		node( id, options ) {
			const _node = fakeNode( id, options );
			_runner.nodes.set( _node.id, _node );
			return _node;
		},
		// An open expectation of the node, as the executor leaves it once the gate executed the action.
		expect( node, spec = {} ) {
			const _key = `FU-${Hash.id( 'k' ).slice( 2 ).toUpperCase()}`;
			const _made = _expectations.create( node, { from: 'design', fact: 'survey_response', keys: [ _key ], ...spec } );
			_expectations.activate( _made.id );
			return _expectations.get( _made.id );
		},
		handle: given => _intake.handle( given ),
	};
	return _rig;
}

let _counter = 0;
export function message( over = {} ) {
	_counter += 1;
	return { id: `in-${_counter}-${Hash.id( 'm' )}`, from: 'Mira', subject: 'Re: follow-up', text: 'Workload 2, mostly tools.', ...over };
}

// The extraction of the survey follow-up (missions/survey/moves.json), the schema the real mission uses.
export const SURVEY_EXTRACT = {
	workload: { type: 'integer', min: 1, max: 5, describe: 'workload score from 1 to 5', critical: true },
	manager: { type: 'integer', min: 1, max: 5, describe: 'manager score from 1 to 5', fixed: false },
	theme: { type: 'enum', values: [ 'workload', 'manager', 'tools', 'pay', 'other' ], describe: 'the main reason' },
};
export const SURVEY_PARSER = { workload: 'workload\\D{0,12}([1-5])\\b' };

// A vault with the roster, the answers and the directory of the survey, in a temp folder.
export function surveyVault() {
	const _dir = tmp( 'vault-' );
	fs.writeFileSync( path.join( _dir, 'roster.csv' ), 'name,respondent,team\nMira,r-001,design\nJakob,r-002,design\n' );
	fs.writeFileSync( path.join( _dir, 'answers.csv' ), 'respondent,team,workload,manager,theme,comment\nr-001,design,3,3,tools,\n' );
	fs.writeFileSync( path.join( _dir, 'directory.csv' ), 'name,team\nMira,design\nJakob,design\nLena,product\n' );
	return new Vault( _dir );
}

export const SURVEY_STORE = {
	identity: { file: 'roster.csv', by: 'name', id: 'respondent', prefix: 'r' },
	rows: [
		{ file: 'roster.csv', key: 'name', row: { name: '{{from}}', respondent: '{{id}}', team: '{{team}}' } },
		{ file: 'answers.csv', key: 'respondent', row: {
			respondent: '{{id}}', team: '{{team}}', workload: '{{workload}}', manager: '{{manager}}', theme: '{{theme}}', comment: '',
		} },
	],
};

// Memory with a signing key, and an Index signed by it, over one database.
export function knowledge( { key = 'test-key', db = memoryDb(), log = null } = {} ) {
	const _memory = new Memory( memoryDb(), { key } );
	const _log = log || new EventLog( db, 'core' );
	const _signing = { sign: value => _memory.sign( value ), verify: ( text, sig ) => _memory.verify( text, sig ), log: _log };
	const _index = new Index( db, _signing );
	const _events = kind => _log.since( 0 ).filter( event => event.kind === kind ).map( event => event.data );
	return { index: _index, memory: _memory, db, log: _log, events: _events };
}
