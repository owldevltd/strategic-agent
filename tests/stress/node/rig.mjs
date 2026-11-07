// A crash rig for the restart tests (chapter 18): a whole office like tests/office.mjs, whose core dies right after
// a chosen event of its log. From that moment its database takes no more writes and its gate calls hang, exactly as if
// the process were gone; the gate and the world live on. A second core then resumes on the same databases and the same
// gate. People still answer what reached them before the crash: their replies go to the second core.
import { app, registry, Contract, Mission } from '../../office.mjs';

const [ Db, EventLog, Egress, Outbox, Local, System, StubProvider, ProcessRuntime ] = await app.use( [
	'Lib.Db', 'Lib.EventLog', 'Gate.Egress', 'Gate.Channel.Outbox', 'Gate.Local', 'Core.System', 'Core.Ai.StubProvider',
	'Core.Sandbox.ProcessRuntime',
] );

// Both cores sign with the same key, as a deployment does across a restart (Memory.key).
process.env.MEMORY_KEY = process.env.MEMORY_KEY || 'stress-node-restart-key';

const tick = ms => new Promise( resolve => setTimeout( resolve, ms ) );

// The survey with short waits: answers are expected within a second, and waiting longer is short as well.
export function survey( mission ) {
	mission.moves[ 'followup.invite' ].creates.expectation.minutes = 0.01;
	for ( const strategy of mission.strategies.filter( item => item.id === 'wait-longer' ) ) {
		strategy.steps.filter( step => step.move === 'followup.wait' ).forEach( ( step ) => {
			step.params = { ...( step.params || {} ), minutes: 0.01 };
		} );
	}
}

// Crash points by meaning: the first event of a kind at a depth, or the nth such event, or one that matches.
export function after( kind, { depth = null, nth = 1, where = () => true } = {} ) {
	let _seen = 0;
	return ( event, { nodes } ) => {
		if ( event.kind !== kind || ( depth !== null && nodes.get( event.node )?.depth !== depth ) || !where( event ) ) { return false; }
		_seen += 1;
		return _seen === nth;
	};
}

// Δ (closing) is bounded by the buffer; a short one lets a closing that waits for nothing end in time.
function config( bufferMinutes ) {
	return { gate: { bufferMinutes }, maxDepth: 5, llm: {}, sandbox: { runtime: 'process', timeoutSeconds: 10 }, worldSpeed: 100, beatMs: 50 };
}

// A database whose writes stop when the core dies; what was written before stays.
function mortal( db ) {
	const _state = { dead: false };
	const _proxy = new Proxy( db, {
		get( target, name ) {
			if ( name === 'run' ) { return ( ...args ) => ( _state.dead ? { changes: 0, lastInsertRowid: 0 } : target.run( ...args ) ); }
			if ( name === 'exec' ) { return ( ...args ) => ( _state.dead ? undefined : target.exec( ...args ) ); }
			if ( name === 'transaction' ) { return fn => ( _state.dead ? fn() : target.transaction( fn ) ); }
			return typeof target[ name ] === 'function' ? target[ name ].bind( target ) : target[ name ];
		},
	} );
	return { db: _proxy, state: _state };
}

// The gate as one core sees it: once that core is dead every call hangs.
function gateOf( egress, state ) {
	return new Proxy( new Local( egress ), {
		get: ( target, name ) => ( typeof target[ name ] === 'function'
			? ( ...args ) => ( state.hung ? new Promise( () => {} ) : target[ name ]( ...args ) ) : target[ name ] ),
	} );
}

// The person: confirms goals, approves what approve() allows, answers tickets (the recommendation, else the first option).
function person( { gateDb, egress, board, approve } ) {
	const _timer = setInterval( () => {
		try {
			gateDb.all( 'SELECT hash FROM contracts WHERE status = \'proposed\'' ).forEach( row => egress.confirm( row.hash, 'test-person' ) );
			for ( const approval of egress.pendingApprovals().filter( item => approve( item ) ) ) {
				egress.decide( approval.id, 'approve', 'test-person', { reason: 'checked', explicit: true } ).catch( () => {} );
			}
		} catch ( error ) {
			if ( process.env.RIG_DEBUG ) { console.error( 'person/gate', error ); }
		}
		for ( const ticket of board.list() ) {
			const _choice = ticket.options.includes( ticket.recommendation ) ? ticket.recommendation : ticket.options[ 0 ];
			try {
				board.answer( ticket.id, { choice: _choice, by: 'test-person' } );
			} catch ( error ) {
				if ( process.env.RIG_DEBUG ) { console.error( 'person/ticket', error ); }
			}
		}
	}, 5 );
	_timer.unref();
	return _timer;
}

function core( { db, log, egress, state, bufferMinutes } ) {
	const _system = new System( { config: config( bufferMinutes ), db, log } );
	Object.assign( _system, { registry, runtime: new ProcessRuntime( { log } ), gate: gateOf( egress, state ) } );
	return _system;
}

function gate( mission ) {
	const gateDb = new Db( ':memory:' );
	const outbox = new Outbox( gateDb );
	const egress = new Egress( { db: gateDb, log: new EventLog( gateDb, 'gate' ), channels: { default: outbox } } );
	for ( const [ kind, values ] of Object.entries( mission.masterData || {} ) ) { egress.store.addMaster( kind, values ); }
	return { gateDb, outbox, egress };
}

// The first core: runs the survey until the crash point (an event id, or a predicate over event and nodes).
async function first( n, { mission, stores, approve, gateLag, bufferMinutes, contract } ) {
	const { db, egress, gateDb } = stores;
	const _mortal = mortal( db );
	const state = { hung: false, crashed: false, count: 0, relay: null };
	const _log = new EventLog( _mortal.db, 'core' );
	const system = core( { db: _mortal.db, log: _log, egress, state, bufferMinutes } );
	const runner = await system.assemble( mission, { provider: new StubProvider( { answers: mission.stub, log: _log } ), pollMs: 5 } );
	const _person = person( { gateDb, egress, board: await system.board(), approve } );
	// The dead core's loops end: its gate calls hang and its nodes count as closed in its own memory only.
	const _halt = () => {
		state.hung = true;
		runner.nodes.forEach( ( item ) => {
			item.state = 'closed';
		} );
	};
	_log.subscribe( ( event ) => {
		state.count = Math.max( state.count, event.id );
		const _due = typeof n === 'function' ? n( event, { db, nodes: runner.nodes } ) : event.id === n;
		if ( !_due || state.crashed ) { return; }
		Object.assign( state, { crashed: true, at: event } );
		_mortal.state.dead = true;
		clearInterval( _person );
		runner.nodes.forEach( ( item ) => {
			item.log = null;
		} );
		if ( gateLag ) { setTimeout( _halt, gateLag ).unref(); } else { _halt(); }
	} );
	// The world lives on: replies to what reached people before the crash go to the second core.
	const _own = system._receive.bind( system );
	system._receive = async ( runnerOf, message ) => {
		if ( !state.crashed ) { return _own( runnerOf, message ); }
		for ( let i = 0; i < 1000 && !state.relay?.runners.length; i++ ) { await tick( 5 ); }
		return state.relay?._receive( state.relay.runners.at( -1 ), message );
	};
	runner.root = await runner.start( new Contract( contract( mission.contractSpec() ), registry ) );
	const _run = runner.run( runner.root ).catch( error => error );
	for ( let i = 0; i < 2000 && !state.crashed && runner.root.state !== 'closed'; i++ ) {
		await Promise.race( [ _run, tick( 5 ) ] );
	}
	clearInterval( _person );
	return { system, runner, state };
}

// The core dies after the event n chooses (see after()). gateLag: the gate stays reachable a few ms longer, so a call
// the dying core already made still lands there while its own record of it is lost. pauseMs: how long the core is down.
// resumes > 1: the new core is told to resume more than once (a double start of the service).
export async function crashAt( n, options = {} ) {
	const { edit = survey, approve = () => true, gateLag = 0, bufferMinutes = 0.03, waitMs = 15000, resumes = 1 } = options;
	const { pauseMs = 0, contract = item => item } = options;
	const mission = Mission.load( 'survey' );
	edit( mission );
	const stores = { ...gate( mission ), db: new Db( ':memory:' ) };
	const { gateDb, outbox, egress, db } = stores;
	const _first = await first( n, { mission, stores, approve, gateLag, bufferMinutes, contract } );
	if ( !_first.state.crashed ) {
		_first.runner.world?.stop();
		return { crashed: false, events: _first.state.count, outbox, egress, gateDb, db, root: _first.runner.root, stop: () => {} };
	}
	await tick( gateLag + 5 + pauseMs );
	const log = new EventLog( db, 'core' );
	const second = core( { db, log, egress, state: { hung: false }, bufferMinutes } );
	const _provider = new StubProvider( { answers: mission.stub, log } );
	// The board first: System.board() is created lazily and two callers at once would get two boards.
	const _person = person( { gateDb, egress, board: await second.board(), approve } );
	const _all = Array.from( { length: resumes }, () => second.resume( { load: () => mission, provider: _provider, pollMs: 5 } ) );
	_first.state.relay = second;
	let _timer;
	const _late = new Promise( ( resolve ) => {
		_timer = setTimeout( () => resolve( 'timeout' ), waitMs );
	} );
	const _roots = await Promise.race( [ Promise.all( _all ).then( lists => lists.flat() ), _late ] );
	clearTimeout( _timer );
	const stop = () => {
		_first.runner.world?.stop();
		clearInterval( _person );
		second.runners.forEach( ( runner ) => {
			runner.world?.stop();
			runner.nodes.forEach( ( item ) => {
				item.state = 'closed';
			} );
		} );
	};
	return {
		crashed: true, roots: _roots === 'timeout' ? null : _roots, second, outbox, egress, gateDb, db, log, stop, mission, at: _first.state.at,
		nodes: () => second.runners.flatMap( runner => [ ...runner.nodes.values() ] ),
	};
}

// What a resumed office left behind, for the assertions of the restart tests.
export function outcome( r ) {
	const _nodes = r.crashed ? r.nodes() : [];
	const _root = _nodes.find( item => !item.parent && item.contract.id.startsWith( 'survey-design' ) );
	return {
		resumed: Boolean( r.roots ),
		root: _root?.result?.status || null,
		reason: _root?.result?.reason || ( _root?.result?.problems || [] ).join( '; ' ) || null,
		open: _nodes.filter( item => item.state !== 'closed' ).map( item => `${item.depth}:${item.state}` ),
		reports: r.outbox.messages( 'hr' ).length,
		attemptsOpen: r.db.all( 'SELECT id, strategy FROM attempts WHERE endedAt IS NULL' ).map( row => row.strategy ),
		deliveriesOpen: r.gateDb.all( 'SELECT id FROM deliveries WHERE status IN ( \'open\', \'awaiting_approval\', \'approved\' )' ).map( row => row.id ),
		events: r.db.all( 'SELECT * FROM events ORDER BY id' ).map( row => ( { ...row, data: JSON.parse( row.data ) } ) ),
		nodes: _nodes,
	};
}
