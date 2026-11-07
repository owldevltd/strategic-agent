// Shared fixtures of the stress tests for contracts, strategies, plans and the catalog's meta processes: the classes
// under attack, small goal and node builders, a synthetic strategy, a spying stub model and throw-away mission folders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { use } from '../../helper.mjs';
import { within } from '../hostile.mjs';
import { registry, Contract, Mission, app } from '../../office.mjs';

export { registry, Contract, Mission, app };

export const [
	Node, Chooser, Diagnosis, TargetCurve, Drafter, StubProvider, Planner, Plan, StrategyGates, Proposals, Catalog, Db,
	ContractCheck, Memory, Hash,
] = await use( 'Core.Node.Node', 'Core.Strategy.Chooser', 'Core.Strategy.Diagnosis', 'Core.Strategy.TargetCurve', 'Core.Contract.Drafter',
	'Core.Ai.StubProvider', 'Core.Plan.Planner', 'Core.Loop.Plan', 'Core.Gates.StrategyGates', 'Core.Meta.Proposals', 'Core.Move.Catalog',
	'Lib.Db', 'Core.Check.ContractCheck', 'Core.Memory.Memory', 'Lib.Hash' );

export const survey = Mission.load( 'survey' );
export const invoices = Mission.load( 'invoices' );

export const inHours = ( hours, from = Date.now() ) => new Date( from + hours * 3600000 ).toISOString();

// The survey goal of the paper's example: one outcome for HR, the two catalog invariants.
export const SURVEY_CRITERIA = [
	{ id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'design team morale' } },
	{ id: 'k2', type: 'min_group', values: { k: 5 }, immutable: true },
	{ id: 'k3', type: 'no_difference', values: { k: 5 }, immutable: true },
];

// One deadline for every goal of a test file, so two goals built a millisecond apart are the same goal.
export const DEADLINE = inHours( 48 );

export function goalSpec( extra = {} ) {
	return {
		id: 'survey-goal', goal: 'Find out why the design team is unhappy', deadline: DEADLINE, budget: 30, value: 40,
		kind: 'hr-survey', criteria: structuredClone( SURVEY_CRITERIA ), ...extra,
	};
}

export const goal = ( extra = {} ) => new Contract( goalSpec( extra ), registry );

// A node with only the report outcome (k1), budget 50, the survey kind.
export function nodeOf( extra = {}, criteria = [ structuredClone( SURVEY_CRITERIA[ 0 ] ) ] ) {
	return new Node( { contract: new Contract( goalSpec( { budget: 50, value: undefined, criteria, ...extra } ), registry ) } );
}

// A synthetic strategy whose chance is exactly p0 (τ tiny, hours large).
export function strategy( id, extra = {} ) {
	return { id, serves: 'report_delivered', class: 'direct', price: 1, startCurve: { p0: 0.8, tauH: 0.001 }, steps: [], ...extra };
}

export const memoryDb = () => new Db( ':memory:' );
export const catalogOf = mission => Catalog.load( mission );

// A stub model that records what it was asked; answers like the StubProvider (and its step-contract check).
export class Spy extends StubProvider {

	constructor( answers ) {
		super( { answers } );
		this.seen = [];
	}

	async _complete( request ) {
		this.seen.push( request );
		return super._complete( request );
	}

}

// A stub model whose answers come from a function of the request and the call number.
export class Scripted extends StubProvider {

	constructor( fn ) {
		super( {} );
		this.fn = fn;
		this.seen = [];
	}

	async _complete( request ) {
		this.seen.push( request );
		return this.fn( request, this.seen.length );
	}

}

// A throw-away folder for missions of the tests; remove() deletes it.
export function scratch( prefix = 'agency-stress-' ) {
	const _dir = fs.mkdtempSync( path.join( os.tmpdir(), prefix ) );
	return {
		dir: _dir,
		write( file, content ) {
			const _file = path.join( _dir, file );
			fs.mkdirSync( path.dirname( _file ), { recursive: true } );
			fs.writeFileSync( _file, typeof content === 'string' ? content : JSON.stringify( content ) );
			return _file;
		},
		remove: () => fs.rmSync( _dir, { recursive: true, force: true } ),
	};
}

// A minimal valid mission folder in dir/id; files overrides the content of single files (null leaves a file out).
export function writeMission( box, id, { meta = {}, files = {} } = {} ) {
	const _meta = typeof meta === 'string' ? meta
		: JSON.stringify( { id, title: id, contract: 'contract.json', strategies: 'strategies.json', kind: `${id}-kind`, ...meta } );
	const _files = {
		'contract.json': { id: `${id}-goal`, goal: 'A report reaches HR', deadline: '{{in:24h}}', budget: 10, value: 10,
			criteria: [ { id: 'k1', type: 'report_delivered', values: { to: 'hr', topic: 'x' } } ] },
		'strategies.json': [ strategy( `${id}-direct` ) ],
		...files,
	};
	box.write( `${id}/mission.json`, _meta );
	for ( const [ name, content ] of Object.entries( _files ) ) {
		if ( content !== null ) { box.write( `${id}/${name}`, content ); }
	}
	return path.join( box.dir, id );
}

// One draft with the mission's stub answer changed by change (a list: answers in turn); never hangs; a refusal by
// exception becomes { ok: false, thrown }. seen: what the model was asked.
export async function draft( mission, change = {}, { task = mission.task, now = undefined, log = null } = {} ) {
	const _provider = new Spy( { contract: Array.isArray( change ) ? change : { ...mission.stub.contract, ...change } } );
	const _drafting = new Drafter( { provider: _provider, registry, log } ).draft( mission, task, now === undefined ? {} : { now } );
	const _result = await within( _drafting.catch( error => ( { ok: false, thrown: error } ) ), 3000, 'the draft' );
	return { ..._result, seen: _provider.seen };
}
