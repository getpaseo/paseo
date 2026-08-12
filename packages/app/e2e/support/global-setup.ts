import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import dotenv from "dotenv";

export interface WaitForServerOptions {
  host?: string;
  timeoutMs?: number;
  label: string;
  childProcess?: ChildProcess | null;
  getRecentOutput?: () => string;
}

type ServerProbe = (host: string, port: number) => Promise<void>;

const RESERVED_LOCAL_PORTS = new Set([
  6767, // Developer daemon.
  61680, // OpenCode's default local server.
]);

function createLineBuffer(maxLines = 120): { add: (line: string) => void; dump: () => string } {
  const lines: string[] = [];
  return {
    add(line) {
      lines.push(line);
      if (lines.length > maxLines) lines.shift();
    },
    dump: () => lines.join("\n"),
  };
}

function formatRecentOutput(getRecentOutput?: () => string): string {
  const output = getRecentOutput?.().trim();
  return output ? `\nRecent output:\n${output}` : "";
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function getAvailableE2EPort(): Promise<number> {
  for (;;) {
    const port = await getAvailablePort();
    if (!RESERVED_LOCAL_PORTS.has(port)) return port;
  }
}

async function connectToServer(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, host, () => {
      socket.end();
      resolve();
    });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      reject(new Error(`Connection timed out to ${host}:${port}`));
    });
    socket.on("error", reject);
  });
}

async function waitForServer(
  port: number,
  options: WaitForServerOptions,
  probe: ServerProbe = connectToServer,
): Promise<void> {
  const { host = "127.0.0.1", timeoutMs = 15_000, label, childProcess, getRecentOutput } = options;
  const deadline = Date.now() + timeoutMs;
  let lastConnectionError: unknown = null;

  while (Date.now() < deadline) {
    if (childProcess?.exitCode !== null && childProcess?.exitCode !== undefined) {
      const signal = childProcess.signalCode ? `, signal ${childProcess.signalCode}` : "";
      throw new Error(
        `${label} exited before listening on ${host}:${port} (exit code ${childProcess.exitCode}${signal}).${formatRecentOutput(getRecentOutput)}`,
      );
    }
    try {
      await probe(host, port);
      return;
    } catch (error) {
      lastConnectionError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const reason =
    lastConnectionError instanceof Error
      ? ` Last connection error: ${lastConnectionError.message}`
      : "";
  throw new Error(
    `${label} did not start on ${host}:${port} within ${timeoutMs}ms.${reason}${formatRecentOutput(getRecentOutput)}`,
  );
}

async function probeMetro(host: string, port: number): Promise<void> {
  const response = await fetch(`http://${host}:${port}/status`, {
    signal: AbortSignal.timeout(1_000),
  });
  const body = (await response.text()).trim();
  if (response.status !== 200 || body !== "packager-status:running") {
    throw new Error(
      `Expected Metro status on ${host}:${port}, received HTTP ${response.status}: ${JSON.stringify(body.slice(0, 200))}`,
    );
  }
}

export async function waitForMetro(port: number, options: WaitForServerOptions): Promise<void> {
  await waitForServer(port, options, probeMetro);
}

export async function warmMetro(port: number): Promise<void> {
  const origin = `http://127.0.0.1:${port}`;
  const documentResponse = await fetch(origin, { signal: AbortSignal.timeout(120_000) });
  if (!documentResponse.ok) {
    throw new Error(`Metro document warmup failed with HTTP ${documentResponse.status}`);
  }
  const document = await documentResponse.text();
  const scriptSources = [...document.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  if (scriptSources.length === 0) {
    throw new Error("Metro document warmup found no scripts to compile");
  }
  for (const source of scriptSources) {
    const scriptUrl = new URL(source, origin);
    if (scriptUrl.origin !== origin) continue;
    const response = await fetch(scriptUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      throw new Error(
        `Metro bundle warmup failed for ${scriptUrl.pathname}: HTTP ${response.status}`,
      );
    }
    await response.arrayBuffer();
  }
}

async function stopProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      once(child, "exit"),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          resolve();
        }, 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function startMetro(port: number, buffer: ReturnType<typeof createLineBuffer>): ChildProcess {
  const appDir = path.resolve(__dirname, "../..");
  const child = spawn("npx", ["expo", "start", "--web", "--port", String(port)], {
    cwd: appDir,
    env: {
      ...process.env,
      BROWSER: "none",
      ...(process.env.E2E_DESKTOP_RUNTIME === "1"
        ? {
            PASEO_WEB_PLATFORM: "electron",
            // Metro inlines EXPO_PUBLIC_* at bundle time, so this never reaches a production
            // build — it exists because the shipped 2-minute stall threshold is otherwise
            // unreachable in a spec. Scoped to the desktop-runtime bundle so the default
            // Chrome run keeps the real threshold and cannot pick up spurious stall labels.
            EXPO_PUBLIC_PASEO_STALL_THRESHOLD_MS: "2000",
          }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  const log = (chunk: Buffer, stream: "stdout" | "stderr") => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      buffer.add(`[${stream}] ${line}`);
      console[stream === "stdout" ? "log" : "error"](`[metro] ${line}`);
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => log(chunk, "stdout"));
  child.stderr?.on("data", (chunk: Buffer) => log(chunk, "stderr"));
  return child;
}

async function loadHarnessEnvironment(repoRoot: string): Promise<void> {
  const envTestPath = path.join(repoRoot, ".env.test");
  if (existsSync(envTestPath)) dotenv.config({ path: envTestPath });
}

export default async function globalSetup() {
  const repoRoot = path.resolve(__dirname, "../../../..");
  await loadHarnessEnvironment(repoRoot);

  const metroPort = await getAvailableE2EPort();
  const metroOutput = createLineBuffer();
  let metroProcess: ChildProcess | null = null;

  try {
    metroProcess = startMetro(metroPort, metroOutput);
    await waitForMetro(metroPort, {
      label: "Metro web server",
      timeoutMs: 120_000,
      childProcess: metroProcess,
      getRecentOutput: metroOutput.dump,
    });
    await warmMetro(metroPort);
    process.env.E2E_METRO_PORT = String(metroPort);
    console.log(`[e2e] Metro warmed on port ${metroPort}`);

    return async () => {
      await stopProcess(metroProcess);
      console.log("[e2e] Metro stopped");
    };
  } catch (error) {
    await stopProcess(metroProcess);
    throw error;
  }
}
