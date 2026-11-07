import { boot } from '../lib/node.mjs';

// Starts the core process. It needs a running gate (bin/gate.mjs); `npm run dev` starts both.

const app = boot();
const [ Main ] = await app.use( [ 'Core.Main' ] );
const main = new Main();
const port = await main.start();
console.log( `core listening on http://${main.config.core.host}:${port}/ui/` );
