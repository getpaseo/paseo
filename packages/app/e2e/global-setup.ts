import { spawn, type ChildProcess, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import dotenv from 'dotenv';

type WaitForServerOptions = {
  host?: string;
  timeoutMs?: number;
  label: string;
  childProcess?: ChildProcess | null;
  getRecentOutput?: () => string;
};

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

function createLineBuffer(maxLines = 120): { add: (line: string) => void; dump: () => string } {
  const lines: string[] = [];
  return {
    add(line: string) {
      lines.push(line);
      if (lines.length > maxLines) {
        lines.shift();
      }
    },
    dump() {
      return lines.join('\n');
    },
  };
}

function formatRecentOutput(getRecentOutput?: () => string): string {
  if (!getRecentOutput) {
    return '';
  }
  const output = getRecentOutput().trim();
  if (!output) {
    return '';
  }
  return `\nRecent output:\n${output}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(port: number, options: WaitForServerOptions): Promise<void> {
  const {
    host = '127.0.0.1',
    timeoutMs = 15000,
    label,
    childProcess,
    getRecentOutput,
  } = options;
  const start = Date.now();
  let lastConnectionError: unknown = null;

  while (Date.now() - start < timeoutMs) {
    if (childProcess && childProcess.exitCode !== null) {
      const signal = childProcess.signalCode ? `, signal ${childProcess.signalCode}` : '';
      throw new Error(
        `${label} exited before listening on ${host}:${port} (exit code ${childProcess.exitCode}${signal}).${formatRecentOutput(getRecentOutput)}`
      );
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, host, () => {
          socket.end();
          resolve();
        });
        socket.setTimeout(1000, () => {
          socket.destroy();
          reject(new Error(`Connection timed out to ${host}:${port}`));
        });
        socket.on('error', reject);
      });
      return;
    } catch (error) {
      lastConnectionError = error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const reason =
    lastConnectionError instanceof Error ? ` Last connection error: ${lastConnectionError.message}` : '';
  throw new Error(
    `${label} did not start on ${host}:${port} within ${timeoutMs}ms.${reason}${formatRecentOutput(getRecentOutput)}`
  );
}

function parseRelayStartupFailure(line: string): string | null {
  const clean = stripAnsi(line);
  if (/Address already in use/i.test(clean)) {
    return clean;
  }
  if (/failed: ::bind\(/i.test(clean)) {
    return clean;
  }
  if (/Fatal uncaught/i.test(clean)) {
    return clean;
  }
  return null;
}

async function stopProcess(child: ChildProcess | null): Promise<void> {
  if (!child) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function summarizeOpenAiErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return 'empty response body';
  }
  if (trimmed.length <= 240) {
    return trimmed;
  }
  return `${trimmed.slice(0, 240)}…`;
}

async function isOpenAiApiKeyUsable(apiKey: string | undefined): Promise<boolean> {
  const key = apiKey?.trim();
  if (!key) {
    return false;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/models?limit=1', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
      },
    });
    if (response.ok) {
      return true;
    }
    const body = await response.text();
    console.warn(
      `[e2e] OPENAI_API_KEY probe failed (${response.status}): ${summarizeOpenAiErrorBody(body)}`
    );
    return false;
  } catch (error) {
    console.warn(
      `[e2e] OPENAI_API_KEY probe request failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}

let daemonProcess: ChildProcess | null = null;
let metroProcess: ChildProcess | null = null;
let paseoHome: string | null = null;
let relayProcess: ChildProcess | null = null;

type OfferPayload = {
  v: 2;
  serverId: string;
  daemonPublicKeyB64: string;
  relay: { endpoint: string };
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
  if (offer.v !== 2) throw new Error('offer.v missing/invalid');
  if (!offer.serverId) throw new Error('offer.serverId missing');
  if (!offer.daemonPublicKeyB64) throw new Error('offer.daemonPublicKeyB64 missing');
  if (!offer.relay?.endpoint) throw new Error('offer.relay.endpoint missing');
  return offer as OfferPayload;
}

export default async function globalSetup() {
  const repoRoot = path.resolve(__dirname, '../../..');
  const envTestPath = path.join(repoRoot, '.env.test');
  if (existsSync(envTestPath)) {
    dotenv.config({ path: envTestPath });
  }

  const port = await getAvailablePort();
  let relayPort = 0;
  const metroPort = await getAvailablePort();
  paseoHome = await mkdtemp(path.join(tmpdir(), 'paseo-e2e-home-'));
  let relayLineBuffer = createLineBuffer();
  const metroLineBuffer = createLineBuffer();
  const daemonLineBuffer = createLineBuffer();

  const cleanup = async () => {
    await Promise.all([stopProcess(daemonProcess), stopProcess(metroProcess), stopProcess(relayProcess)]);
    daemonProcess = null;
    metroProcess = null;
    relayProcess = null;
    if (paseoHome) {
      await rm(paseoHome, { recursive: true, force: true });
      paseoHome = null;
    }
  };

  const openAiUsable = await isOpenAiApiKeyUsable(process.env.OPENAI_API_KEY);
  const defaultLocalModelsDir = path.join(process.env.HOME ?? '', '.paseo', 'models', 'local-speech');
  const hasDefaultLocalModelsDir = defaultLocalModelsDir.trim().length > 0 && existsSync(defaultLocalModelsDir);
  const dictationProvider = openAiUsable ? 'openai' : 'local';

  if (dictationProvider === 'local' && !hasDefaultLocalModelsDir) {
    throw new Error(
      'OpenAI key is not usable and local speech models are unavailable at ~/.paseo/models/local-speech. ' +
        'Either provide a valid OPENAI_API_KEY or install local speech models before running app e2e tests.'
    );
  }

  const localModelsDir = dictationProvider === 'local' ? defaultLocalModelsDir : null;
  console.log(
    `[e2e] Dictation STT provider: ${dictationProvider}${openAiUsable ? '' : ' (OpenAI probe failed)'}`
  );

  try {
    const relayDir = path.resolve(__dirname, '..', '..', 'relay');
    const maxRelayStartupAttempts = 5;
    let relayStarted = false;
    let lastRelayStartupError: unknown = null;

    for (let attempt = 1; attempt <= maxRelayStartupAttempts; attempt += 1) {
      relayPort = await getAvailablePort();
      relayLineBuffer = createLineBuffer();
      let relayStartupFailureLine: string | null = null;
      let relayReadyForSelectedPort = false;

      relayProcess = spawn(
        'npx',
        ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(relayPort)],
        {
          cwd: relayDir,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        }
      );

      relayProcess.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter((line) => line.trim());
        for (const line of lines) {
          relayLineBuffer.add(`[stdout] ${line}`);
          const failure = parseRelayStartupFailure(line);
          if (failure) {
            relayStartupFailureLine = failure;
          }
          const clean = stripAnsi(line);
          const readyMatch = clean.match(/Ready on .*:(\d+)\b/i);
          if (readyMatch && Number(readyMatch[1]) === relayPort) {
            relayReadyForSelectedPort = true;
          }
          console.log(`[relay] ${line}`);
        }
      });
      relayProcess.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter((line) => line.trim());
        for (const line of lines) {
          relayLineBuffer.add(`[stderr] ${line}`);
          const failure = parseRelayStartupFailure(line);
          if (failure) {
            relayStartupFailureLine = failure;
          }
          const clean = stripAnsi(line);
          const readyMatch = clean.match(/Ready on .*:(\d+)\b/i);
          if (readyMatch && Number(readyMatch[1]) === relayPort) {
            relayReadyForSelectedPort = true;
          }
          console.error(`[relay] ${line}`);
        }
      });

      try {
        await waitForServer(relayPort, {
          label: 'Relay dev server',
          timeoutMs: 30000,
          childProcess: relayProcess,
          getRecentOutput: relayLineBuffer.dump,
        });

        const readyDeadline = Date.now() + 5000;
        while (
          !relayReadyForSelectedPort &&
          relayStartupFailureLine === null &&
          relayProcess?.exitCode === null &&
          relayProcess?.signalCode === null &&
          Date.now() < readyDeadline
        ) {
          await sleep(100);
        }

        if (relayStartupFailureLine) {
          throw new Error(`Relay startup failed: ${relayStartupFailureLine}`);
        }
        if (!relayReadyForSelectedPort) {
          throw new Error(
            `Relay process did not report ready for selected port ${relayPort}.${formatRecentOutput(
              relayLineBuffer.dump
            )}`
          );
        }
        if (relayProcess.exitCode !== null || relayProcess.signalCode !== null) {
          throw new Error(
            `Relay process exited before startup completed (exit code ${relayProcess.exitCode}, signal ${relayProcess.signalCode}).${formatRecentOutput(
              relayLineBuffer.dump
            )}`
          );
        }

        relayStarted = true;
        break;
      } catch (error) {
        lastRelayStartupError = error;
        await stopProcess(relayProcess);
        relayProcess = null;
      }
    }

    if (!relayStarted) {
      const message =
        lastRelayStartupError instanceof Error
          ? lastRelayStartupError.message
          : String(lastRelayStartupError);
      throw new Error(
        `Failed to start relay dev server after ${maxRelayStartupAttempts} attempts. ${message}`
      );
    }

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
      const lines = data.toString().split('\n').filter((line) => line.trim());
      for (const line of lines) {
        metroLineBuffer.add(`[stdout] ${line}`);
        console.log(`[metro] ${line}`);
      }
    });

    metroProcess.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter((line) => line.trim());
      for (const line of lines) {
        metroLineBuffer.add(`[stderr] ${line}`);
        console.error(`[metro] ${line}`);
      }
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
        PASEO_SERVER_ID: 'srv_e2e_test_daemon',
        PASEO_LISTEN: `0.0.0.0:${port}`,
        PASEO_RELAY_ENDPOINT: `127.0.0.1:${relayPort}`,
        PASEO_CORS_ORIGINS: `http://localhost:${metroPort}`,
        // Use OpenAI speech providers in e2e to avoid local model bootstrapping delays.
        PASEO_DICTATION_ENABLED: '1',
        PASEO_VOICE_MODE_ENABLED: '1',
        PASEO_DICTATION_STT_PROVIDER: dictationProvider,
        PASEO_VOICE_STT_PROVIDER: 'openai',
        PASEO_VOICE_TTS_PROVIDER: 'openai',
        ...(localModelsDir ? { PASEO_LOCAL_MODELS_DIR: localModelsDir } : {}),
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
        daemonLineBuffer.add(`[stdout] ${trimmed}`);
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
      const lines = data.toString().split('\n').filter((line) => line.trim());
      for (const line of lines) {
        daemonLineBuffer.add(`[stderr] ${line}`);
        console.error(`[daemon] ${line}`);
      }
    });

    // Wait for both daemon and Metro to be ready
    await Promise.all([
      waitForServer(port, {
        label: 'Paseo daemon',
        childProcess: daemonProcess,
        getRecentOutput: daemonLineBuffer.dump,
      }),
      waitForServer(metroPort, {
        label: 'Metro web server',
        timeoutMs: 120000, // Metro can take longer to start
        childProcess: metroProcess,
        getRecentOutput: metroLineBuffer.dump,
      }),
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
    process.env.E2E_SERVER_ID = offer.serverId;
    process.env.E2E_RELAY_DAEMON_PUBLIC_KEY = offer.daemonPublicKeyB64;
    process.env.E2E_METRO_PORT = String(metroPort);
    console.log(`[e2e] Test daemon started on port ${port}, Metro on port ${metroPort}, home: ${paseoHome}`);

    return async () => {
      await cleanup();
      console.log('[e2e] Test daemon stopped');
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
