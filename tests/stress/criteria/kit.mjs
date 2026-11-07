// Shared tools of the criterion stress tests: the registry exactly as production loads it, builders for facts and
// gate receipts at fixed times, and the gate's own rule evaluation over the rules a contract of criteria derives.
import assert from 'node:assert/strict';
import { use } from '../../helper.mjs';
import { attack, attacks, hostile, random, within } from '../hostile.mjs';

export const [ Registry, Criterion, Composite, ConfirmedBy, Contract, ContractCheck, Rules, Hash, Actions, Execution ] = await use(
	'Core.Criteria.Registry', 'Core.Criteria.Criterion', 'Core.Criteria.Composite', 'Core.Criteria.ConfirmedBy',
	'Core.Contract.Contract', 'Core.Check.ContractCheck', 'Gate.Rules', 'Lib.Hash', 'Lib.Actions', 'Core.Loop.Execution',
);
export const registry = await Registry.load();
export { assert, attack, attacks, hostile, random, within };

// Fixed times: every fact is stamped AT unless a test says otherwise; validity is judged against the wall clock.
export const AT = '2026-11-05T10:00:00.000Z';
export const DEADLINE = '2026-11-06T12:00:00.000Z';
export const EXPIRED = '2001-01-01T00:00:00.000Z';
export const VALID = '2999-01-01T00:00:00.000Z';
export const WINDOW = [ '2026-11-09T08:00:00.000Z', '2026-11-13T17:00:00.000Z' ];
export const ms = text => Date.parse( text );
export const iso = value => new Date( value ).toISOString();
export const shift = ( text, delta ) => iso( Date.parse( text ) + delta );

let count = 0;

export function fact( kind, data, evidenceClass = 'observation', extra = {} ) {
	count += 1;
	return { id: `f${count}`, kind, evidenceClass, origin: 'system', source: 'system', data, time: AT, ...extra };
}

// A gate receipt as the execution writes it after an executed delivery.
export function receipt( action, data = {}, extra = {} ) {
	const _data = { action, to: 'hr', approval: 'ap-1', cohort: null, params: {}, ...data };
	return fact( 'delivered', _data, 'observation', { source: 'gate', origin: 'gate', ...extra } );
}

export const payment = ( amount, extra = {}, params = {} ) => receipt( 'payment', { to: 'supplier', params: { amount, invoiceId: 'r-1', ...params } }, extra );
export const release = ( cohort, extra = {} ) => receipt( 'report', { cohort }, extra );

export function make( type, values, extra = {} ) {
	return registry.create( { id: 'k1', type, values, ...extra } );
}

export const problems = ( type, values, extra ) => make( type, values, extra ).validate();
export const ids = list => list.map( item => item.id );
export const relabel = ( list, change ) => list.map( item => ( { ...item, ...change } ) );

// A person's yes as the channel of a criterion (K4, 3.4).
export const yes = ( criterion = 'k1', extra = {}, data = {} ) =>
	fact( 'confirmation', { criterion, choice: 'yes', role: 'client', ...data }, 'confirmation', extra );

// The gate's verdict on one request under the rules derived from these criterion specs (fail closed, own ledger).
// recipients: the recipients in the gate's master data; null lists every one (a release is not what these tests are about).
export function gate( criteria, request, options = {} ) {
	const { released = [], deliveries = [], master = [], recipients = null, now = ms( AT ), actions } = options;
	const _contract = new Contract( { id: 'c', goal: 'g', deadline: DEADLINE, budget: 1, criteria }, registry );
	const _seen = [];
	const _store = {
		// No goal above this one: its master data are those for every goal.
		contract: () => null,
		releasedCohorts: () => released,
		treeDeliveries: () => deliveries,
		// One goal at this gate: every goal's ledger is this goal's.
		allReleasedCohorts: () => released,
		allDeliveries: () => deliveries,
		isMaster: ( kind, value ) => {
			if ( kind === 'recipient' ) { return recipients ? recipients.includes( value ) : true; }
			_seen.push( kind );
			return master.includes( value );
		},
	};
	const _rules = new Rules( _store, { now: () => now, ...( actions ? { actions } : {} ) } );
	const _result = _rules.evaluate( { root: 'c', rules: _contract.rules() }, { id: 'r1', labels: {}, params: {}, ...request } );
	return { ..._result, kinds: _seen, rules: _result.refusals.map( item => item.rule ) };
}

// The receipt facts the execution itself writes for an operation it followed after its move ended (O8, R3): the
// real code path, fed with the gate's delivery row.
export function followed( row ) {
	const _execution = new Execution( { catalog: { moves: {} } } );
	const _row = { id: 'd-1', target: 'hr', receipt: 'rc-1', params: {}, cohort: null, approval: 'ap-1', status: 'executed', ...row };
	return _execution.receipted( _row, { deliveryAttempt: {} } ).map( item => ( { ...item, id: `${_row.id}-fact`, time: AT } ) );
}

// Does the gate implement every rule name this criterion derives? An unknown rule refuses every action.
export function implemented( rule ) {
	return rule === 'human_approval' || typeof Rules.prototype[ Rules.method( rule ) ] === 'function';
}

// The hostile corpus with labels that tell every number apart (JSON prints NaN, Infinity and -Infinity as null).
export function corpus( ...groups ) {
	const _number = value => ( Object.is( value, -0 ) ? '-0' : String( value ) );
	return hostile( ...groups ).map( item => ( typeof item.value === 'number' ? { ...item, label: `number ${_number( item.value )}` } : item ) );
}

// A long list of facts nobody asked for, to bury the relevant ones in.
export function noise( size, seed = 7 ) {
	const _random = random( seed );
	const _kinds = [ 'calendar_entry', 'timeout', 'message', 'conflict', 'precondition_met', 'cancelled' ];
	return Array.from( { length: size }, () => fact( _random.pick( _kinds ), { about: _random.string( 6 ) }, _random.pick( [ 'observation', 'claim' ] ) ) );
}

// Runs fn with the process in another time zone; Node re-reads TZ on change.
export function inZone( zone, fn ) {
	const _before = process.env.TZ;
	process.env.TZ = zone;
	try {
		return fn();
	} finally {
		if ( _before === undefined ) {
			delete process.env.TZ;
		} else {
			process.env.TZ = _before;
		}
	}
}
