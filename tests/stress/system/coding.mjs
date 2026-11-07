// Shared tools of the coding tests: the coding mission (tests/missions/coding), its trusted acceptance frame run
// directly in the development sandbox, and a provider that records every request a model role was given.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { use, ROOT } from '../../helper.mjs';
import { office, Mission } from '../../office.mjs';

const [ ProcessRuntime, StubProvider ] = await use( 'Core.Sandbox.ProcessRuntime', 'Core.Ai.StubProvider' );

export const MISSIONS = path.join( ROOT, 'tests/missions' );
export const FRAME_FILE = path.join( ROOT, 'tests/missions/coding/tools/acceptance.py' );
export const FRAME = fs.readFileSync( FRAME_FILE, 'utf8' );
export const coding = () => Mission.load( 'coding', MISSIONS );
export const CASES = coding().strategies.find( item => item.id === 'write-and-test' ).steps[ 1 ].params.cases;
export const HONEST = coding().stub.coder.code;
export const COMMIT = coding().contract.criteria.find( item => item.id === 'k1' ).values.commit;
export const HIDDEN = CASES.slice( 3 );

// Python source from lines (no tabs, so the agent's code keeps its own indentation).
export const py = ( ...lines ) => `${lines.join( '\n' )}\n`;

// The way out of the restricted built-ins that every Python sandbox of this kind has: the built-in importer, reached
// through the subclasses of object, hands out posix (OS) and the full built-ins (OS["__builtins__"]). Three lines.
export const ESCAPE = [
	'BI = [c for c in ().__class__.__base__.__subclasses__() if c.__name__ == "BuiltinImporter"][0]',
	'OS = dict(BI.load_module("posix").__dict__)',
	'OS["__builtins__"] = BI.load_module("builtins").__dict__',
].join( '\n' );

// The version of the suite exactly as the frame computes it: the frame's bytes and its frozen cases.
export function version( cases = CASES, source = fs.readFileSync( FRAME_FILE ) ) {
	const _frozen = Buffer.from( JSON.stringify( cases ), 'utf8' );
	return crypto.createHash( 'sha256' ).update( Buffer.concat( [ source, Buffer.from( '\n' ), _frozen ] ) ).digest( 'hex' ).slice( 0, 16 );
}

// Runs the frame once with the given code, as the executor would. → { out, run }: the parsed line and the raw run.
export async function frame( code, { cases = CASES, seconds = 2, timeoutSeconds = 10, log = null } = {} ) {
	const _input = { ...( cases === null ? {} : { cases } ), ...( seconds === null ? {} : { seconds } ), inputs: [ { code } ] };
	const _run = await new ProcessRuntime( { timeoutSeconds, log } ).run( { script: FRAME, input: _input } );
	let _out;
	try {
		_out = JSON.parse( _run.stdout );
	} catch {
		_out = null;
	}
	return { out: _out, run: _run };
}

// Records what each model role was given and lets a test answer per role.
export class Recording extends StubProvider {

	constructor( options ) {
		super( options );
		this.requests = [];
	}

	async _complete( request ) {
		const { role, instructions, input, repair = null } = request;
		this.requests.push( { role, instructions, input, repair } );
		return super._complete( request );
	}

	of( role ) {
		return this.requests.filter( item => item.role === role );
	}

}

// One office for the coding mission. answers: per role, like StubProvider; edit( mission ) changes the mission first.
export async function codingOffice( { answers = {}, edit = null, person, approve } = {} ) {
	const _mission = coding();
	edit?.( _mission );
	const _provider = new Recording( { answers: { ..._mission.stub, ...answers } } );
	const _office = await office( { mission: _mission, provider: _provider, person, approve } );
	_provider.log = _office.log;
	// A 4 s lease window instead of the harness's 200 ms, so a stalled event loop in a full parallel run ends no move.
	_office.runner.supervisor.beatMs = 1000;
	return { ..._office, provider: _provider };
}

// Every string a model was given, in one text: instructions and input of every request.
export const seen = provider => provider.requests.map( item => `${item.instructions}\n${JSON.stringify( item.input )}` ).join( '\n' );
