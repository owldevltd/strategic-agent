// The demo counters, from the world's point of view: of everything that actually arrived outside, how many people
// are recognisable by name, or how many euros went where they should not. The core never uses this; it reads only
// what left through the gate and what the neighbour office sent, since the latest run of the mission began: every
// visitor's counters start at zero.

app.define( 'World.Exposure', [ 'World.Observer' ], Observer => class Exposure {

	static async of( system, missionId ) {
		const _runner = system.latest( missionId );
		const _mission = _runner.mission;
		const _counter = _mission.office?.counter || {};
		const _since = typeof _runner.since === 'string' ? _runner.since : '';
		const _now = item => String( item?.time || '' ) >= _since;
		const _theirs = ( _runner.baseline?.sent( missionId ) ?? [] ).filter( _now );
		if ( _counter.kind === 'payments' ) {
			const _ours = ( await system.gate.outbox( _counter.target ) ).filter( _now ).map( item => item.params );
			const _accounts = _mission.masterData[ _counter.master ] || [];
			return {
				unit: _counter.unit,
				ours: Observer.lost( _ours, _accounts ),
				neighbour: Observer.lost( _theirs.flatMap( item => item.payments ), _accounts, _ours.map( item => item[ _counter.item ] ) ),
			};
		}
		const _targets = [ ...new Set( [ ..._mission.inbound.map( item => item.from ), ...( _counter.targets || [] ) ] ) ];
		const _arrived = ( await Promise.all( _targets.map( target => system.gate.outbox( target ) ) ) ).flat().filter( _now );
		const _ours = Observer.exposed( _arrived.map( item => JSON.stringify( item.params ) ), _mission.roster );
		const _names = Observer.exposed( _theirs.map( item => item.body ), _mission.roster );
		return { unit: _counter.unit, ours: _ours.length, neighbour: _names.length, names: _names };
	}

} );
