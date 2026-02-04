import { spawn, type ChildProcess, execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import { createRelayServer, type RelayServer } from '@paseo/relay/node';

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to acquire port')));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(port: number, timeout = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, 'localhost', () => {
          socket.end();
          resolve();
        });
        socket.on('error', reject);
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`Server did not start on port ${port} within ${timeout}ms`);
}

let daemonProcess: ChildProcess | null = null;
let metroProcess: ChildProcess | null = null;
let paseoHome: string | null = null;
let relayServer: RelayServer | null = null;

type OfferPayload = {
  sessionId: string;
  daemonPublicKeyB64: string;
  endpoints: string[];
};

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

function decodeOfferFromFragmentUrl(url: string): OfferPayload {
  const marker = '#offer=';
  const idx = url.indexOf(marker);
  if (idx === -1) {
    throw new Error(`missing ${marker} fragment: ${url}`);
  }
  const encoded = url.slice(idx + marker.length);
  const json = Buffer.from(encoded, 'base64url').toString('utf8');
  const offer = JSON.parse(json) as Partial<OfferPayload>;
  if (!offer.sessionId) throw new Error('offer.sessionId missing');
  if (!offer.daemonPublicKeyB64) throw new Error('offer.daemonPublicKeyB64 missing');
  if (!Array.isArray(offer.endpoints) || offer.endpoints.length === 0) {
    throw new Error('offer.endpoints missing');
  }
  return offer as OfferPayload;
}

export default async function globalSetup() {
  const port = await getAvailablePort();
  const relayPort = await getAvailablePort();
  const metroPort = await getAvailablePort();
  paseoHome = await mkdtemp(path.join(tmpdir(), 'paseo-e2e-home-'));

  relayServer = createRelayServer({ port: relayPort, host: '127.0.0.1' });
  await relayServer.start();

  // Start Metro bundler on dynamic port
  const appDir = path.resolve(__dirname, '..');
  metroProcess = spawn('npx', ['expo', 'start', '--web', '--port', String(metroPort)], {
    cwd: appDir,
    env: {
      ...process.env,
      BROWSER: 'none', // Don't auto-open browser
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  metroProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter((l) => l.trim());
    for (const line of lines) {
      console.log(`[metro] ${line}`);
    }
  });

  metroProcess.stderr?.on('data', (data: Buffer) => {
    console.error(`[metro] ${data.toString().trim()}`);
  });

  const serverDir = path.resolve(__dirname, '../../..', 'packages/server');
  const tsxBin = execSync('which tsx').toString().trim();

  let offerPayload: OfferPayload | null = null;
  let offerResolve: (() => void) | null = null;
  const offerPromise = new Promise<void>((resolve) => {
    offerResolve = resolve;
  });

  daemonProcess = spawn(tsxBin, ['src/server/index.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PASEO_HOME: paseoHome,
      PASEO_SERVER_ID: 'e2e-test-daemon',
      PASEO_LISTEN: `0.0.0.0:${port}`,
      PASEO_RELAY_ENDPOINT: `127.0.0.1:${relayPort}`,
      PASEO_CORS_ORIGINS: `http://localhost:${metroPort}`,
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let stdoutBuffer = '';
  daemonProcess.stdout?.on('data', (data: Buffer) => {
    stdoutBuffer += data.toString('utf8');
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!offerPayload) {
        const clean = stripAnsi(trimmed);
        try {
          const obj = JSON.parse(clean) as { msg?: string; url?: string };
          if (obj.msg === 'pairing_offer' && typeof obj.url === 'string') {
            offerPayload = decodeOfferFromFragmentUrl(obj.url);
            offerResolve?.();
          }
        } catch {
          const match = clean.match(/https?:\/\/[^\s"]+#offer=[A-Za-z0-9_-]+/);
          if (match && clean.includes('pairing_offer')) {
            try {
              offerPayload = decodeOfferFromFragmentUrl(match[0]);
              offerResolve?.();
            } catch {
              // ignore parsing failures
            }
          }
        }
      }
      console.log(`[daemon] ${trimmed}`);
    }
  });

  daemonProcess.stderr?.on('data', (data: Buffer) => {
    console.error(`[daemon] ${data.toString().trim()}`);
  });

  // Wait for both daemon and Metro to be ready
  await Promise.all([
    waitForServer(port),
    waitForServer(metroPort, 120000), // Metro can take longer to start
  ]);

  // Wait for daemon to emit a pairing offer (includes relay session ID).
  await Promise.race([
    offerPromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for pairing_offer log')), 15000)
    ),
  ]);
  if (!offerPayload) {
    throw new Error('pairing_offer was not parsed from daemon logs');
  }
  const offer = offerPayload as OfferPayload;

  process.env.E2E_DAEMON_PORT = String(port);
  process.env.E2E_RELAY_PORT = String(relayPort);
  process.env.E2E_RELAY_SESSION_ID = offer.sessionId;
  process.env.E2E_METRO_PORT = String(metroPort);
  console.log(`[e2e] Test daemon started on port ${port}, Metro on port ${metroPort}, home: ${paseoHome}`);

  return async () => {
    if (daemonProcess) {
      daemonProcess.kill('SIGTERM');
      daemonProcess = null;
    }
    if (metroProcess) {
      metroProcess.kill('SIGTERM');
      metroProcess = null;
    }
    if (relayServer) {
      await relayServer.stop();
      relayServer = null;
    }
    if (paseoHome) {
      await rm(paseoHome, { recursive: true, force: true });
      paseoHome = null;
    }
    console.log('[e2e] Test daemon stopped');
  };
}
