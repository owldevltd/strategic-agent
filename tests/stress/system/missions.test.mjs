// The engine beyond the two demo missions, built only from data in tests/missions: an IT-operations goal whose
// dependencies become a chain of sub-goals (U2, R2, R5, R6), and a fan-out to many children (R1, P4). Every run
// ends with the invariants of invariants.mjs.
import assert from 'node:assert/strict';
import { attack, within } from '../hostile.mjs';
import { missionOffice } from './chaos.mjs';
import { check } from './invariants.mjs';

const SUBJECT = 'core/system.js';
const tree = node => [ node, ...node.children.flatMap( tree ) ];
const items = node => node.contract.criteria.find( item => item.type === 'items_resolved' ).values.items;
const run = async ( o ) => {
	try {
		return await within( o.run(), 20000, 'the goal' );
	} finally {
		o.stop();
	}
};
// A person who answers every ticket with its recommendation, but never lifts a gate and never retries an escalation.
const strict = ticket => ( ticket.kind === 'escalation' ? 'close as failed' : ticket.recommendation );
const clean = async o => assert.deepEqual( await check( o, { mission: o.mission, provider: o.provider } ), [] );
// Adds services below the database, each one a link of the chain: its move, its strategy and its gate.
const longer = ( names, { cycle = false } = {} ) => ( mission ) => {
	const _chain = [ 'database', ...names ];
	_chain.slice( 1 ).forEach( ( name ) => {
		mission.moves[ `restart.${name}` ] = { ...mission.moves[ 'restart.database' ], describe: `restarts ${name}` };
		const _base = mission.strategies.find( item => item.id === 'restart-database' );
		mission.strategies.push( JSON.parse( JSON.stringify( _base ).replaceAll( 'database', name ) ) );
	} );
	_chain.slice( 0, -1 ).forEach( ( name, i ) => mission.gates.push( {
		rule: 'precondition', move: `restart.${name}`,
		criterion: { type: 'items_resolved', values: { collection: 'services', items: [ _chain[ i + 1 ] ], outcomes: [ 'restarted', 'escalated' ] } },
	} ) );
	if ( cycle ) {
		mission.gates.push( { rule: 'precondition', move: `restart.${_chain.at( -1 )}`,
			criterion: { type: 'items_resolved', values: { collection: 'services', items: [ 'checkout' ], outcomes: [ 'restarted', 'escalated' ] } } } );
	}
};

attack( SUBJECT, 'ops chain: each dependency becomes a sub-goal, three levels deep, and the restarts happen in dependency order', async () => {
	const o = await missionOffice( 'ops-chain' );
	const _root = await run( o );
	assert.equal( _root.result.status, 'fulfilled', JSON.stringify( _root.result ) );
	const _nodes = tree( _root );
	assert.deepEqual( _nodes.map( node => [ node.depth, items( node )[ 0 ] ] ), [ [ 0, 'checkout' ], [ 1, 'payments' ], [ 2, 'ledger' ], [ 3, 'database' ] ] );
	assert.deepEqual( o.outbox.messages( 'ops' ).map( message => message.params.service ), [ 'database', 'ledger', 'payments', 'checkout' ] );
	for ( const node of _nodes.slice( 1 ) ) {
		const _named = node.parent.walls.find( wall => wall.precondition?.id === node.contract.serves.precondition ).precondition;
		assert.deepEqual( node.contract.criteria[ 0 ].values, _named.values, 'the child\'s goal is exactly the precondition its parent named (R6)' );
		assert.ok( node.contract.criteria.some( item => item.type === 'exactly_once' ), 'every child carries the invariants of its ancestors' );
	}
	await clean( o );
} );

attack( SUBJECT, 'ops chain: every restart left only with a person\'s one-time token for exactly that action', async () => {
	const o = await missionOffice( 'ops-chain' );
	await run( o );
	const _tokens = o.gateDb.all( 'SELECT a.status, a.decidedBy, a.actionHash, d.actionHash AS hash, d.params FROM approvals a JOIN deliveries d ON d.id = a.delivery' );
	assert.equal( _tokens.length, 4 );
	assert.ok( _tokens.every( row => row.status === 'consumed' && row.decidedBy === 'test-person' && row.actionHash === row.hash ) );
	await clean( o );
} );

attack( SUBJECT, 'ops chain: a person refuses the ledger restart; nothing above it is restarted and the goal fails cleanly', async () => {
	const o = await missionOffice( 'ops-chain', { approve: approval => approval.summary.params.service !== 'ledger', person: strict } );
	const _root = await run( o );
	assert.equal( _root.result.status, 'failed' );
	assert.deepEqual( o.outbox.messages( 'ops' ).map( message => message.params.service ), [ 'database' ] );
	const _ledger = tree( _root ).find( node => items( node )[ 0 ] === 'ledger' );
	assert.ok( _ledger.walls.some( wall => wall.cause === 'rejected_by_person' ), JSON.stringify( _ledger.walls.map( wall => wall.cause ) ) );
	await clean( o );
} );

attack( SUBJECT, 'ops chain: a lifted dependency gate is a person\'s decision; the restart after it still needs its own token', async () => {
	// The person refuses the ledger's restart, then decides to restart payments without it: the ticket offers the lift
	// but no longer advises it (the precondition was tried and is not met), so the person chooses it themselves.
	const _lift = ticket => ( ticket.options.includes( 'lift these gates and try once more' ) ? 'lift these gates and try once more' : ticket.recommendation ?? ticket.options[ 0 ] );
	const o = await missionOffice( 'ops-chain', { approve: approval => approval.summary.params.service !== 'ledger', person: _lift } );
	const _root = await run( o );
	const _lifted = o.log.since( 0, 1e9 ).filter( event => event.kind === 'strategy_gate_lifted' );
	assert.ok( _lifted.length >= 1 && _lifted.every( event => event.data.by === 'test-person' ), 'only a person lifts a gate (21)' );
	const _checkout = o.outbox.messages( 'ops' ).filter( message => message.params.service === 'checkout' );
	assert.equal( _checkout.length, 1, 'after the person lifted the gate, checkout was restarted once' );
	const _token = o.gateDb.get( 'SELECT status, decidedBy FROM approvals WHERE delivery = :id', { id: _checkout[ 0 ].idempotencyKey } );
	assert.deepEqual( [ _token.status, _token.decidedBy ], [ 'consumed', 'test-person' ] );
	assert.equal( _root.result.status, 'fulfilled' );
	assert.ok( !o.outbox.messages( 'ops' ).some( message => message.params.service === 'ledger' ), 'the refused restart never left' );
	await clean( o );
} );

attack( SUBJECT, 'ops chain: a service one branch restarted is not restarted again by another branch (exactly once in the tree)', async () => {
	const _early = ( mission ) => {
		const _steps = mission.strategies.find( item => item.id === 'restart-checkout' ).steps;
		_steps.splice( 1, 0, { move: 'restart.database', params: { service: 'database' }, target: 'ops' } );
	};
	const o = await missionOffice( 'ops-chain', { edit: _early, person: strict } );
	const _root = await run( o );
	const _restarts = o.outbox.messages( 'ops' ).filter( message => message.params.service === 'database' );
	assert.equal( _restarts.length, 1 );
	const _refused = o.egress.store.treeDeliveries( _root.contract.hash ).filter( item => item.status === 'refused' );
	assert.ok( _refused.some( item => item.reasons.some( reason => reason.rule === 'exactly_once' ) ) );
	await clean( o );
} );

attack( SUBJECT, 'ops chain: a chain deeper than the maximum depth is cut at R2; nothing is restarted, every node closes', async () => {
	// A large budget, so that the depth and not the budget ends the chain (each child gets half of what is left).
	const _deep = ( mission ) => {
		longer( [ 'storage', 'network', 'power' ] )( mission );
		Object.assign( mission.contract, { budget: 2000, value: 2000 } );
	};
	const o = await missionOffice( 'ops-chain', { edit: _deep, person: strict } );
	const _root = await run( o );
	assert.equal( _root.result.status, 'failed' );
	const _deepest = tree( _root ).at( -1 );
	assert.equal( _deepest.depth, 6 );
	assert.equal( _deepest.result.status, 'refused' );
	assert.ok( _deepest.result.problems.some( text => /depth 6 exceeds the maximum 5 \(R2\)/.test( text ) ) );
	assert.deepEqual( o.outbox.messages( 'ops' ), [], 'every restart waited for a dependency that never came' );
	await clean( o );
} );

attack( SUBJECT, 'ops chain: each level gets half of what is left; a long chain ends when a child cannot reserve its budget (P4)', async () => {
	const o = await missionOffice( 'ops-chain', { edit: longer( [ 'storage', 'network', 'power' ] ), person: strict } );
	const _root = await run( o );
	assert.equal( _root.result.status, 'failed' );
	const _nodes = tree( _root );
	const _budgets = _nodes.map( node => node.contract.budget );
	assert.ok( _budgets.every( ( budget, i ) => !i || budget <= Math.max( 1, _budgets[ i - 1 ] / 2 ) ), JSON.stringify( _budgets ) );
	assert.match( _nodes.at( -1 ).result.reason, /cannot reserve its budget \(P4\)/ );
	assert.deepEqual( o.outbox.messages( 'ops' ), [] );
	await clean( o );
} );

attack( SUBJECT, 'ops chain: a dependency cycle back to the goal\'s own service is refused (R5) instead of recursing', async () => {
	const o = await missionOffice( 'ops-chain', { edit: longer( [], { cycle: true } ), person: strict } );
	const _root = await run( o );
	assert.equal( _root.result.status, 'failed' );
	const _nodes = tree( _root );
	assert.ok( _nodes.length <= 6, `${_nodes.length} nodes` );
	assert.deepEqual( o.outbox.messages( 'ops' ), [] );
	// R5: the repeated goal never runs. The judgment makes no child of a precondition that is an outcome of a goal above
	// it; a child that restates one anyway is refused at G1.
	const _outcomes = node => JSON.stringify( node.contract.outcomes().map( item => [ item.type, item.values ] ) );
	const _running = _nodes.filter( node => node.result.status !== 'refused' );
	assert.equal( new Set( _running.map( _outcomes ) ).size, _running.length, 'no goal runs twice in one chain' );
	await clean( o );
} );

attack( SUBJECT, 'ops chain: a service the inventory does not know stops at the trusted check; nothing is restarted', async () => {
	const _unknown = ( mission ) => {
		mission.contract.criteria[ 0 ].values.items = [ 'database' ];
		mission.strategies.find( item => item.id === 'restart-database' ).steps[ 0 ].params.service = 'databse';
	};
	const o = await missionOffice( 'ops-chain', { edit: _unknown, person: strict } );
	const _root = await run( o );
	assert.equal( _root.result.status, 'failed' );
	assert.ok( _root.walls.some( wall => wall.cause === 'move_failed' ) );
	assert.deepEqual( o.outbox.messages( 'ops' ), [] );
	await clean( o );
} );

attack( SUBJECT, 'fan-out: eight children, each supplier notified exactly once at its own address, each notice approved', async () => {
	const o = await missionOffice( 'fanout' );
	const _root = await run( o );
	assert.equal( _root.result.status, 'fulfilled', JSON.stringify( _root.result ) );
	assert.equal( _root.children.length, 8 );
	for ( const child of _root.children ) {
		const _sent = o.outbox.messages( items( child )[ 0 ] );
		assert.equal( _sent.length, 1, items( child )[ 0 ] );
		assert.equal( _sent[ 0 ].params.supplier, items( child )[ 0 ] );
	}
	assert.equal( o.gateDb.get( 'SELECT COUNT(*) AS n FROM approvals WHERE status = \'consumed\'' ).n, 8 );
	await clean( o );
} );

attack( SUBJECT, 'fan-out: two refused notices go to a person; the goal closes with six notified and two escalated', async () => {
	const _refuse = [ 'S-03', 'S-07' ];
	const o = await missionOffice( 'fanout', { approve: approval => !_refuse.includes( approval.summary.params.supplier ) } );
	const _root = await run( o );
	assert.equal( _root.result.status, 'fulfilled', JSON.stringify( _root.result ) );
	const _outcomes = Object.fromEntries( _root.children.map( child => [ items( child )[ 0 ],
		child.facts.find( fact => fact.kind === 'item_resolved' )?.data.outcome ] ) );
	assert.deepEqual( _refuse.map( id => _outcomes[ id ] ), [ 'escalated', 'escalated' ] );
	assert.equal( Object.values( _outcomes ).filter( outcome => outcome === 'notified' ).length, 6 );
	assert.deepEqual( _refuse.map( id => o.outbox.messages( id ).length ), [ 0, 0 ] );
	await clean( o );
} );

attack( SUBJECT, 'fan-out: twelve children are more than the start account allows (R1); the goal fails cleanly, nothing twice', async () => {
	const _twelve = ( mission ) => {
		mission.contract.criteria[ 0 ].values.items = Array.from( { length: 12 }, ( _x, i ) => `S-${String( i + 1 ).padStart( 2, '0' )}` );
	};
	const o = await missionOffice( 'fanout', { edit: _twelve } );
	const _root = await run( o );
	assert.equal( _root.result.status, 'failed' );
	const _refused = _root.children.filter( child => child.result.status === 'refused' );
	assert.ok( _refused.length >= 1 && _refused.every( child => /R1/.test( child.result.reason ) ), JSON.stringify( _refused.map( child => child.result ) ) );
	assert.equal( o.system.account.left( o.runner.id ), 0 );
	const _starts = o.log.since( 0, 1e9 ).filter( event => [ 'plan_accepted', 'child_started' ].includes( event.kind ) ).length;
	assert.equal( _starts, 20, 'exactly the twenty starts of the account' );
	await clean( o );
} );

attack( SUBJECT, 'fan-out: a writer that breaks its step contract is stopped by a person; the supplier is handed over, not skipped', async () => {
	// Five suppliers: each needs two starts of a strategy and its own start, within the start account of 20 (R1).
	const _five = mission => mission.contract.criteria[ 0 ].values.items.splice( 5 );
	const o = await missionOffice( 'fanout', { answers: { noticer: { text: 'Hello', tone: 'friendly' } }, edit: _five } );
	const _root = await run( o );
	assert.equal( _root.result.status, 'fulfilled', JSON.stringify( _root.result ) );
	assert.ok( _root.children.every( child => child.facts.some( fact => fact.kind === 'item_resolved' && fact.data.outcome === 'escalated' ) ) );
	assert.equal( o.gateDb.get( 'SELECT COUNT(*) AS n FROM outbox' ).n, 0, 'no notice without a valid text' );
	await clean( o );
} );
