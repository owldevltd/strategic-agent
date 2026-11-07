// The invariants every run must keep, whatever happened during it (crashes, aborts, deadlines, budgets, messages):
//   token       no outside action without a person's token where the action table or the goal requires one (A6, F2)
//   deadline    nothing sent after its expiry, the root deadline plus Δ (G-1b, A7)
//   withdrawn   no attempt begins after its operation was withdrawn (O9)
//   closed      every node closed, with a result (Z3, Z5)
//   journal     every attempt in the journal ended (L2, G6)
//   once        no item got the same action twice, no message without its operation (O2, exactly once)
//   replay      the log alone rebuilds the same nodes: state, result, facts, walls, costs, children (18, Z4)
// check() returns the list of broken invariants; an empty list is a clean run.
import { use } from '../../helper.mjs';

const [ Actions, Restore ] = await use( 'Lib.Actions', 'Core.Loop.Restore' );
const ACTIONS = Actions.load();

const deliveriesWithAttempts = gateDb => gateDb.all( 'SELECT DISTINCT delivery FROM attempts' ).map( row => row.delivery );

export function tokens( o ) {
	const _problems = [];
	for ( const id of deliveriesWithAttempts( o.gateDb ) ) {
		const _delivery = o.egress.store.delivery( id );
		const _contract = o.egress.store.contract( _delivery.contract );
		const _byGoal = _contract.rules.gate.some( rule => rule.rule === 'human_approval' && ACTIONS.applies( rule.actions, _delivery.action ) );
		if ( !ACTIONS.needsPerson( _delivery.action ) && !_byGoal ) { continue; }
		const _token = o.gateDb.get( 'SELECT * FROM approvals WHERE delivery = :id AND status = \'consumed\'', { id } );
		if ( !_token || !_token.decidedBy || _token.actionHash !== _delivery.actionHash ) {
			_problems.push( `token: ${_delivery.action} ${id} went out without a person's token` );
		}
	}
	return _problems;
}

export function deadlines( o ) {
	const _problems = [];
	for ( const attempt of o.gateDb.all( 'SELECT * FROM attempts' ) ) {
		const _delivery = o.egress.store.delivery( attempt.delivery );
		const _root = o.egress.store.contract( _delivery.root );
		const _limit = Date.parse( _root.spec.deadline ) + o.egress.bufferMinutes * 60000;
		if ( Date.parse( attempt.begunAt ) > Date.parse( _delivery.expiresAt ) || Date.parse( attempt.begunAt ) > _limit ) {
			_problems.push( `deadline: ${attempt.delivery} began at ${attempt.begunAt}, after ${_delivery.expiresAt}` );
		}
	}
	for ( const message of o.gateDb.all( 'SELECT * FROM outbox' ) ) {
		const _delivery = o.egress.store.delivery( message.idempotencyKey );
		if ( _delivery && Date.parse( message.time ) > Date.parse( _delivery.expiresAt ) ) {
			_problems.push( `deadline: message ${message.id} left at ${message.time}, after ${_delivery.expiresAt}` );
		}
	}
	return _problems;
}

export function withdrawals( o ) {
	const _events = o.gateDb.all( 'SELECT id, kind, data FROM events WHERE source = \'gate\' ORDER BY id' ).map( row => ( { ...row, data: JSON.parse( row.data ) } ) );
	const _withdrawn = new Map( _events.filter( event => event.kind === 'withdrawn' ).map( event => [ event.data.delivery, event.id ] ) );
	const _late = event => event.kind === 'attempt_begun' && _withdrawn.has( event.data.delivery ) && event.id > _withdrawn.get( event.data.delivery );
	return _events.filter( _late ).map( event => `withdrawn: ${event.data.delivery} began an attempt after it was withdrawn` );
}

export function closed( nodes ) {
	const _results = [ 'fulfilled', 'failed', 'aborted', 'refused', 'expired' ];
	return nodes.filter( node => node.state !== 'closed' || !_results.includes( node.result?.status ) )
		.map( node => `closed: ${node.id} (depth ${node.depth}) is ${node.state} with result ${JSON.stringify( node.result )}` );
}

export function journal( o ) {
	return o.db.all( 'SELECT id, node, strategy FROM attempts WHERE endedAt IS NULL' ).map( row => `journal: attempt ${row.id} of ${row.strategy} never ended` );
}

export function once( o ) {
	const _problems = [];
	const _messages = o.gateDb.all( 'SELECT * FROM outbox' );
	for ( const message of _messages ) {
		const _delivery = o.egress.store.delivery( message.idempotencyKey );
		if ( !_delivery || _delivery.status !== 'executed' ) { _problems.push( `once: message ${message.id} has no executed operation` ); }
	}
	for ( const root of o.gateDb.all( 'SELECT DISTINCT root FROM deliveries' ) ) {
		const _contract = o.egress.store.contract( root.root );
		for ( const rule of ( _contract?.rules.gate || [] ).filter( item => item.rule === 'exactly_once' ) ) {
			const _done = o.egress.store.treeDeliveries( root.root ).filter( item => ACTIONS.applies( rule.actions, item.action )
				&& [ 'executed', 'open', 'unclear' ].includes( item.status ) );
			const _keys = _done.map( item => item.params[ rule.key ] );
			const _twice = _keys.filter( ( key, i ) => _keys.indexOf( key ) !== i );
			_problems.push( ..._twice.map( key => `once: ${rule.key} ${key} got ${rule.actions.join( ',' )} twice` ) );
		}
	}
	return _problems;
}

// The nodes as the log alone tells them, next to the nodes that ran.
export async function replay( o, runner, { mission, provider } ) {
	const _fresh = await o.system.assemble( mission, { vault: runner.vault.dir, run: runner.id, provider, pollMs: 5 } );
	new Restore( _fresh ).rebuild();
	const _problems = [];
	const _shape = node => ( {
		state: node.state, result: node.result?.status || null, facts: node.facts.map( fact => fact.id ).sort(),
		walls: node.walls.map( wall => wall.cause ), spent: Math.round( node.spent * 1000 ),
		children: node.children.map( child => child.id ),
	} );
	for ( const [ id, node ] of runner.nodes ) {
		const _rebuilt = _fresh.nodes.get( id );
		if ( !_rebuilt ) {
			_problems.push( `replay: ${id} is not in the log` );
			continue;
		}
		const [ _live, _again ] = [ _shape( node ), _shape( _rebuilt ) ];
		for ( const key of Object.keys( _live ) ) {
			if ( JSON.stringify( _live[ key ] ) !== JSON.stringify( _again[ key ] ) ) {
				_problems.push( `replay: ${id} ${key} ran as ${JSON.stringify( _live[ key ] )}, the log gives ${JSON.stringify( _again[ key ] )}` );
			}
		}
	}
	for ( const id of _fresh.nodes.keys() ) {
		if ( !runner.nodes.has( id ) ) { _problems.push( `replay: the log has a node ${id} that did not run` ); }
	}
	_fresh.world?.stop();
	return _problems;
}

// Every invariant at once. runners: the runners whose nodes count (after a restart: the resumed ones).
export async function check( o, { runners = o.system.runners, mission, provider, skip = [] } = {} ) {
	const _nodes = runners.flatMap( runner => [ ...runner.nodes.values() ] );
	const _all = {
		token: () => tokens( o ), deadline: () => deadlines( o ), withdrawn: () => withdrawals( o ), closed: () => closed( _nodes ),
		journal: () => journal( o ), once: () => once( o ),
	};
	const _problems = Object.entries( _all ).filter( ( [ name ] ) => !skip.includes( name ) ).flatMap( ( [ , fn ] ) => fn() );
	if ( !skip.includes( 'replay' ) ) {
		for ( const runner of [ ...runners ] ) {
			_problems.push( ...await replay( o, runner, { mission, provider } ) );
		}
	}
	return _problems;
}
