import { config } from './config.js';
import { createApp } from './app.js';

const app = createApp();

await app.ready();

const server = app.listen(config.port, () => {
  console.log(`Workshop listening on http://localhost:${config.port}`);
});

// Keep the listener strongly referenced for runtimes that collect idle handles.
globalThis.workshopServer = server;
globalThis.workshopKeepAlive = setInterval(() => {}, 2_147_483_647);
