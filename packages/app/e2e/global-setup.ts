import { spawn, type ChildProcess, execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

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
let paseoHome: string | null = null;

export default async function globalSetup() {
  const port = await getAvailablePort();
  paseoHome = await mkdtemp(path.join(tmpdir(), 'paseo-e2e-home-'));

  const serverDir = path.resolve(__dirname, '../../..', 'packages/server');
  const tsxBin = execSync('which tsx').toString().trim();

  daemonProcess = spawn(tsxBin, ['src/server/index.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PASEO_HOME: paseoHome,
      PASEO_LISTEN: `0.0.0.0:${port}`,
      PASEO_CORS_ORIGINS: 'http://localhost:8081',
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  daemonProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`[daemon] ${data.toString().trim()}`);
  });

  daemonProcess.stderr?.on('data', (data: Buffer) => {
    console.error(`[daemon] ${data.toString().trim()}`);
  });

  await waitForServer(port);

  process.env.E2E_DAEMON_PORT = String(port);
  console.log(`[e2e] Test daemon started on port ${port}, home: ${paseoHome}`);

  return async () => {
    if (daemonProcess) {
      daemonProcess.kill('SIGTERM');
      daemonProcess = null;
    }
    if (paseoHome) {
      await rm(paseoHome, { recursive: true, force: true });
      paseoHome = null;
    }
    console.log('[e2e] Test daemon stopped');
  };
}
