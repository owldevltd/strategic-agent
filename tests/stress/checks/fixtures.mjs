// Shared builders for the stress tests of the checks G1–G6, the soft rules, the label flow, the move catalog and the
// cause codes. Everything runs in memory: no network, no model, no Config.load(), no .env.
import { use } from '../../helper.mjs';

export const [
	Registry, Contract, ContractCheck, PlanCheck, FactCheck, WriteCheck, ReadCheck, CloseCheck, SoftCheck, Flow, Catalog, Causes,
	Mission, Node, Actions, Memory, Journal, Db, WaitGraph, Diagnosis,
] = await use(
	'Core.Criteria.Registry', 'Core.Contract.Contract', 'Core.Check.ContractCheck', 'Core.Check.PlanCheck', 'Core.Check.FactCheck',
	'Core.Check.WriteCheck', 'Core.Check.ReadCheck', 'Core.Check.CloseCheck', 'Core.Check.SoftCheck', 'Core.Label.Flow', 'Core.Move.Catalog',
	'Core.Move.Causes', 'Core.Mission.Mission', 'Core.Node.Node', 'Lib.Actions', 'Core.Memory.Memory', 'Core.Learn.Journal', 'Lib.Db',
	'Core.Loop.WaitGraph', 'Core.Strategy.Diagnosis',
);

export const registry = await Registry.load();
export const actions = Actions.load();

export const inHours = hours => new Date( Date.now() + hours * 3600000 ).toISOString();

// The outcome every test contract has unless it says otherwise: a report for HR, from the client.
export const REPORT = { id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'morale' }, origin: 'client' };

export function contract( extra = {}, criteria = [ REPORT ] ) {
	return new Contract( { id: 'goal', goal: 'Report the morale of the design team to HR', deadline: inHours( 48 ), budget: 20, criteria, ...extra }, registry );
}

// G1 with its problems only.
export function problems( given, options = {} ) {
	return new ContractCheck().check( given, options ).problems;
}

export function survey( extra = {} ) {
	return contract( { id: 'survey', ...extra }, [
		REPORT,
		{ id: 'k2', type: 'min_group', values: { k: 5 }, immutable: true, origin: 'catalog' },
		{ id: 'k3', type: 'no_difference', values: { k: 5 }, immutable: true, origin: 'catalog' },
	] );
}

export function invoices( extra = {}, rules = [ 'k2', 'k3', 'k4', 'k5' ] ) {
	const _all = [
		{ id: 'k1', type: 'items_resolved', values: { collection: 'invoices', items: [ 'R-1186', 'R-1187' ], outcomes: [ 'paid', 'escalated' ] } },
		{ id: 'k2', type: 'exactly_once', values: { key: 'invoiceId', action: 'payment' }, immutable: true },
		{ id: 'k3', type: 'account_from_master', values: { param: 'iban' }, immutable: true },
		{ id: 'k4', type: 'sum_max', values: { max: 48000 }, immutable: true },
		{ id: 'k5', type: 'human_approval', values: { actions: [ 'payment' ] }, immutable: true },
	];
	return contract( { id: 'invoices', goal: 'Prepare this week\'s supplier payments', ...extra }, _all.filter( item => item.id === 'k1' || rules.includes( item.id ) ) );
}

// A move with every field of 6.2, so a test only names what it attacks.
export function move( extra = {} ) {
	return {
		executor: 'code', evidence: [], criticality: 'read', params: {}, price: 0.1, tSignalH: null, horizonH: null, leaseMaxMin: 2, reversible: false,
		...extra,
	};
}

export const catalogs = {
	survey: () => Catalog.load( Mission.load( 'survey' ) ),
	invoices: () => Catalog.load( Mission.load( 'invoices' ) ),
};

// A small catalog of hand-made moves for data-flow attacks: what reads foreign text, what is confidential, what is a
// group, what inherits, and outgoing actions with one parameter (report) or several (payment).
export function flowCatalog( extra = {} ) {
	return new Catalog( {
		'mail.read': move( { labels: [ 'foreign' ] } ),
		'rows.read': move( { labels: [ 'confidential' ] } ),
		'stats.read': move( { labels: [ 'confidential' ], group: true } ),
		'master.read': move( { labels: [ 'own' ] } ),
		'text.write': move( { executor: 'ai', inherit: true, labels: [] } ),
		'text.clean': move( { labels: [] } ),
		'prep.own': move( { labels: [], fieldLabels: { iban: [ 'own' ], amount: [ 'foreign' ] } } ),
		'prep.foreign': move( { labels: [], fieldLabels: { iban: [ 'foreign' ] } } ),
		'report.send': move( { action: 'report', param: 'body' } ),
		// It settles an invoice by paying it (resolves): that is the commitment an items_resolved goal with "paid" admits.
		'pay.send': move( {
			action: 'payment', resolves: { item: 'invoiceId', outcome: 'paid' },
			params: { iban: { type: 'string', optional: true }, amount: { type: 'number', optional: true } },
		} ),
		...extra,
	} );
}

// A plan bound to the contract it is checked against.
export function plan( given, steps ) {
	return { contract: given.hash, steps };
}

export function g2( given, steps, options = {} ) {
	return new PlanCheck().check( plan( given, steps ), { catalog: flowCatalog(), contract: given, ...options } );
}

// A journal and a memory over one in-memory database, with two attempts of a node "n1".
export function store() {
	const _db = new Db( ':memory:' );
	const _journal = new Journal( _db );
	const _memory = new Memory( _db );
	const _node = { id: 'n1', depth: 0, contract: { hash: 'h1' } };
	const _wall = _journal.start( _node, { id: 'mail' }, {}, { criterion: 'k1' } );
	_journal.end( _wall, { outcome: 'wall', cause: 'no_reaction' } );
	const _done = _journal.start( _node, { id: 'call' }, {}, { criterion: 'k1' } );
	_journal.end( _done, { outcome: 'done' } );
	return { db: _db, journal: _journal, memory: _memory, node: _node, wall: _wall, done: _done };
}

// A lesson in the schema of 20.1 for an attempt of the store above.
export function lesson( attempt, extra = {} ) {
	return {
		attempt, strategy: 'mail', situation: { task: 'meeting', contact: 'supplier:4711', weekday: 'mon', month: 11, wall: null, depth: 0 },
		result: 'wall', provisional: null, signalAfterH: null, observationEnds: null, cause: 'no_reaction', contribution: [], contractSuccess: true,
		evidence: { node: 'n1', run: 'r1' }, ...extra,
	};
}

export const STRATEGIES = [ { id: 'mail' }, { id: 'call' } ];
export const causes = Causes.load();
export const diagnosis = Diagnosis.load();
