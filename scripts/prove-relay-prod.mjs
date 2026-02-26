#!/usr/bin/env node
import { chromium } from 'playwright';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const part = argv[i];
    if (!part.startsWith('--')) continue;
    const key = part.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

const args = parseArgs(process.argv);

const serverId = args['server-id'] ?? process.env.JUNCTION_SERVER_ID;
const daemonPublicKeyB64 = args['daemon-public-key-b64'] ?? process.env.JUNCTION_DAEMON_PUBLIC_KEY_B64;
const relayEndpoint = args['relay-endpoint'] ?? process.env.JUNCTION_RELAY_ENDPOINT ?? 'relay.junction.sh:443';
const baseUrl = args['base-url'] ?? process.env.JUNCTION_APP_URL ?? 'https://app.junction.sh';
const timeoutMs = Number(args['timeout-ms'] ?? process.env.JUNCTION_PROVE_TIMEOUT_MS ?? 60_000);
const stabilityMs = Number(args['stability-ms'] ?? process.env.JUNCTION_PROVE_STABILITY_MS ?? 30_000);

if (!serverId || typeof serverId !== 'string') {
  console.error('Missing server ID. Provide --server-id or JUNCTION_SERVER_ID.');
  process.exit(2);
}
if (!daemonPublicKeyB64 || typeof daemonPublicKeyB64 !== 'string') {
  console.error('Missing daemon public key. Provide --daemon-public-key-b64 or JUNCTION_DAEMON_PUBLIC_KEY_B64.');
  process.exit(2);
}

const nowIso = new Date().toISOString();
const daemon = {
  serverId,
  label: 'relay-daemon',
  connections: [{ id: `relay:${relayEndpoint}`, type: 'relay', relayEndpoint, daemonPublicKeyB64 }],
  preferredConnectionId: `relay:${relayEndpoint}`,
  createdAt: nowIso,
  updatedAt: nowIso,
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

page.on('console', (m) => console.log(`[browser:${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.error(`[browser:pageerror] ${e.message}`));

await page.addInitScript((seed) => {
  localStorage.setItem('@junction:daemon-registry', JSON.stringify([seed.daemon]));
  localStorage.removeItem('@junction:settings');
}, { daemon });

await page.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

const card = page.getByTestId(`daemon-card-${serverId}`);
await card.waitFor({ timeout: timeoutMs });
await card.getByText('Online', { exact: true }).waitFor({ timeout: timeoutMs });
await card.getByText('Relay', { exact: true }).waitFor({ timeout: timeoutMs });

// Stability window: ensure it doesn't flap.
await page.waitForTimeout(stabilityMs);
await card.getByText('Online', { exact: true }).waitFor({ timeout: 5_000 });

console.log(
  JSON.stringify(
    {
      ok: true,
      serverId,
      relayEndpoint,
      baseUrl,
      stabilityMs,
    },
    null,
    2
  )
);

await browser.close();
