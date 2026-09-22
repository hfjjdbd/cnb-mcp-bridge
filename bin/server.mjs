#!/usr/bin/env node
import { GATEWAY_USAGE, loadGatewayConfig } from '../src/gateway-config.mjs';
import { createGateway } from '../src/gateway.mjs';

let config;
try {
  config = loadGatewayConfig(process.env, process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
if (config.help) {
  console.log(GATEWAY_USAGE);
  process.exit(0);
}

const gateway = createGateway(config);
let stopping;
async function shutdown() {
  stopping ||= gateway.stop();
  await stopping;
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });

try {
  await gateway.start();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}