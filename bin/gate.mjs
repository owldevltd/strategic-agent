import { boot } from '../lib/node.mjs';

// Starts the gate process: the only way out, with its own database and the keys for the channels.

const app = boot();
const [ Main ] = await app.use( [ 'Gate.Main' ] );
const main = new Main();
const port = await main.start();
console.log( `gate listening on ${main.config.gate.host}:${port}` );
