// Checks a mission before it runs: node bin/check-mission.mjs <id> [<id> ...]. It loads the mission from the
// deployment's mission folders (AGENCY_MISSIONS), checks its moves against the action table, its goal with the
// contract check (G1), the references of its strategies, that a direct way exists for every outcome, that every tool
// and frame is on disk, that every placeholder in a target can be filled, that the stub answers every model role and the
// world only actions the gate knows; it prints the version of every frozen acceptance suite (the commit its test_green
// criterion must name) and the causes that reach a strategy class only through "*". Exits 1 on a problem.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { boot } from '../lib/node.mjs';

const app = boot();
const [ Mission, Catalog, Actions, Registry, Contract, ContractCheck, Executor, Diagnosis, StrategyGates, Db ] = await app.use( [ 'Core.Mission.Mission',
	'Core.Move.Catalog', 'Lib.Actions', 'Core.Criteria.Registry', 'Core.Contract.Contract', 'Core.Check.ContractCheck', 'Core.Move.Executor',
	'Core.Strategy.Diagnosis', 'Core.Gates.StrategyGates', 'Lib.Db' ] );
const registry = await Registry.load();

// The version acceptance.py gives a suite: its own bytes, the suite's name, its modules and its frozen cases.
function suiteVersion( frame, params ) {
	const _code = 'import hashlib, json, sys\nreq = json.load(sys.stdin)\nframe = open(req["frame"], "rb").read()\n'
		+ 'frozen = json.dumps([req["suite"], sorted(req.get("modules") or []), req["cases"]], separators=(",", ":"), ensure_ascii=False).encode("utf-8")\n'
		+ 'print(hashlib.sha256(frame + b"\\n" + frozen).hexdigest()[:16])';
	const _run = spawnSync( 'python3', [ '-I', '-c', _code ], { input: JSON.stringify( { frame, ...params } ), encoding: 'utf8' } );
	return _run.status === 0 ? _run.stdout.trim() : null;
}

// The goal: built from contract.json and checked as G1 checks a goal before a person confirms it.
function goal( mission, catalog, problems ) {
	try {
		const _contract = new Contract( mission.contractSpec(), registry );
		const _check = new ContractCheck().check( ContractCheck.channelled( _contract, catalog, registry ),
			{ now: Date.now(), mandatory: mission.invariants || [], strategies: mission.strategies, catalog } );
		problems.push( ...( _check.problems || [] ).map( text => `goal: ${text}` ) );
		return _contract;
	} catch ( error ) {
		problems.push( `goal: ${error.message}` );
		return null;
	}
}

// One step: its move, what it reads and waits for, its target, its files, and the version of a frozen suite.
function step( { mission, catalog, contract, named, roles, problems, notes }, item, where ) {
	const move = catalog.get( item.move );
	if ( !move ) {
		problems.push( `${where}: no such move` );
		return;
	}
	for ( const name of [].concat( item.from ?? [] ) ) {
		if ( !named.has( name ) ) { problems.push( `${where}: reads "${name}", which no earlier step makes` ); }
	}
	if ( item.for !== undefined && !named.has( item.for ) ) { problems.push( `${where}: waits for "${item.for}", which no earlier step makes` ); }
	if ( move.action && !item.target ) { problems.push( `${where}: the action ${move.action} has no target` ); }
	for ( const name of Object.keys( item.params || {} ).filter( key => !Object.hasOwn( move.params || {}, key ) ) ) {
		problems.push( `${where}: ${name} is no parameter of ${item.move} (G2 refuses the plan)` );
	}
	if ( move.executor === 'ai' ) { roles.add( move.role ); }
	for ( const file of [ move.tool, move.agentCode ].filter( Boolean ) ) {
		try {
			if ( !fs.existsSync( Executor.script( file, mission ) ) ) { problems.push( `${where}: ${file} does not exist` ); }
		} catch ( error ) {
			problems.push( `${where}: ${error.message}` );
		}
	}
	if ( move.tool === 'sandbox/tools/acceptance.py' && item.params?.suite ) {
		const _version = suiteVersion( Executor.script( move.tool, mission ), item.params );
		const _named = contract?.criteria.filter( criterion => criterion.type === 'test_green' && criterion.values.test === item.params.suite ) || [];
		notes.push( `suite ${item.params.suite}: version ${_version}` );
		if ( _named.length && _named.every( criterion => criterion.values.commit !== _version ) ) {
			problems.push( `${where}: the goal names commit ${_named[ 0 ].values.commit} for ${item.params.suite}, the suite is at ${_version}` );
		}
	}
	if ( item.as ) { named.add( item.as ); }
}

// Without a wall only direct strategies run (4.3): every outcome needs one.
function direct( mission, contract, problems ) {
	for ( const criterion of contract?.criteria.filter( item => item.constructor.KIND === 'outcome' ) || [] ) {
		const _direct = mission.strategies.some( item => item.serves === criterion.type && [].concat( item.class || 'direct' ).includes( 'direct' )
			&& ( !item.kind || item.kind === mission.kind ) );
		if ( !_direct ) { problems.push( `goal: no strategy of class "direct" serves ${criterion.type}; without a wall only direct strategies run` ); }
	}
}

// request.read is the reader of new messages (Core.Inbound.Cases): a model step with a concern schema, or none at all.
function reader( catalog, roles, problems ) {
	const _reader = catalog.get( 'request.read' );
	if ( _reader && ( _reader.executor !== 'ai' || !_reader.concern || typeof _reader.concern !== 'object' ) ) {
		problems.push( 'request.read is the reader of new messages: a model step (executor ai) with a concern schema' );
	}
	if ( _reader?.executor === 'ai' ) { roles.add( _reader.role ); }
}

// A target's placeholders ({{name}}, {{name|subject}}): a name nothing fills resolves to nothing, and the action then
// has no recipient. What fills one: a mission parameter, a value of a criterion, the item, a slot of the strategy.
function targets( mission, problems ) {
	const _known = new Set( [ ...Object.keys( mission.params || {} ), 'item', 'byPerson', 'byPersonQuestion',
		...Object.values( registry.types ).flatMap( Type => Object.keys( Type.PARAMS || {} ) ) ] );
	// A new case's strategies also read what was extracted from the message (its scope), which no file names.
	for ( const strategy of mission.strategies.filter( item => item.kind !== 'request' ) ) {
		( strategy.steps || [] ).forEach( ( item, i ) => {
			for ( const [ , name ] of String( item.target ?? '' ).matchAll( /\{\{(\w+)(?:\|\w+)?\}\}/g ) ) {
				if ( !_known.has( name ) && !Object.hasOwn( strategy.slots || {}, name ) ) {
					problems.push( `strategy ${strategy.id}, step ${i + 1}: the target names {{${name}}}, which no parameter, criterion value, item or slot fills` );
				}
			}
		} );
	}
}

// 5.6: a cause whose hypotheses end in "*" (the base diagnosis does that for most causes) may be answered by a strategy
// of any class. A strategy that presumes something happened (a reminder went out, a payment was booked) must not answer
// such a wall: the mission maps that cause itself (diagnosis.json).
function wildcards( mission, notes ) {
	const _diagnosis = Diagnosis.load( mission );
	const _base = new Set( Mission.base().map( item => item.id ) );
	const _answers = mission.strategies.some( item => !_base.has( item.id ) && item.kind !== 'request'
		&& [].concat( item.class || 'direct' ).some( name => name !== 'direct' ) );
	const _open = Object.keys( _diagnosis.causes ).filter( cause => ( _diagnosis.of( cause ) || [] ).some( item => item.class === '*' ) );
	if ( _answers && _open.length ) {
		notes.push( `any strategy class may answer ${_open.join( ', ' )} ("*"); map a cause in diagnosis.json where a strategy must not answer it` );
	}
}

// gates.json, seeded as the system seeds it at start (7.3, 21): every rule must be a template the gate store takes, about
// moves of the catalog, and never one no strategy can satisfy (an order no strategy keeps, a precondition only the
// blocked move brings about). Two rules on the same move and criterion type replace each other: only the stricter holds.
function gates( mission, catalog, problems, notes ) {
	if ( !( mission.gates || [] ).length ) { return; }
	const _store = new StrategyGates( new Db( ':memory:' ) );
	const _seed = { scope: mission.kind, by: 'agent', registry, catalog, strategies: mission.strategies };
	let _taken = 0;
	mission.gates.forEach( ( gate, i ) => {
		const _result = _store.propose( gate, _seed );
		if ( _result.ok ) { _taken++; } else { problems.push( `gates.json, rule ${i + 1}: ${_result.problems.join( '; ' )}` ); }
	} );
	const _held = _store.active( mission.kind ).length;
	if ( _held < _taken ) { notes.push( `gates.json: ${_held} of ${_taken} rules hold; rules on the same move and criterion type replace each other` ); }
}

function check( id ) {
	const problems = [];
	const notes = [];
	let mission;
	try {
		mission = Mission.load( id );
	} catch ( error ) {
		return { problems: [ `cannot load: ${error.message}` ], notes };
	}
	const actions = Actions.load();
	const catalog = Catalog.load( mission );
	problems.push( ...catalog.validate( actions ) );
	const contract = goal( mission, catalog, problems );
	const roles = new Set();
	for ( const strategy of mission.strategies.filter( item => !item.kind || item.kind === mission.kind || item.kind === 'request' ) ) {
		const named = new Set( strategy.kind === 'request' ? [ 'message' ] : [] );
		( strategy.steps || [] ).forEach( ( item, i ) => step( { mission, catalog, contract, named, roles, problems, notes }, item,
			`strategy ${strategy.id}, step ${i + 1} (${item.move})` ) );
	}
	direct( mission, contract, problems );
	reader( catalog, roles, problems );
	targets( mission, problems );
	wildcards( mission, notes );
	gates( mission, catalog, problems, notes );
	for ( const role of roles ) {
		if ( !Object.hasOwn( mission.stub || {}, role ) ) { notes.push( `stub.json has no answer for the role ${role} (the stub then answers a plain template)` ); }
	}
	for ( const responder of mission.world?.responders || [] ) {
		if ( responder.on?.action && !actions.entry( responder.on.action ) ) { problems.push( `world: a responder answers ${responder.on.action}, an action the gate does not know` ); }
	}
	return { problems, notes };
}

let failed = false;
for ( const id of process.argv.slice( 2 ) ) {
	const { problems, notes } = check( id );
	console.log( `${problems.length ? '✖' : '✔'} ${id}` );
	notes.forEach( text => console.log( `  · ${text}` ) );
	problems.forEach( text => console.log( `  ✖ ${text}` ) );
	failed = failed || problems.length > 0;
}
if ( !process.argv[ 2 ] ) {
	console.log( 'usage: node bin/check-mission.mjs <mission id> [...]   (missions from AGENCY_MISSIONS, default "missions")' );
	process.exit( 2 );
}
process.exit( failed ? 1 : 0 );
