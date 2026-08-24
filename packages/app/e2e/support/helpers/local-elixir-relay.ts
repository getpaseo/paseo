import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";

export interface LocalElixirRelay {
  endpoint: string;
  port: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a relay port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 5_000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(force);
  }
}

async function waitUntilReady(
  port: number,
  child: ChildProcess,
  recentOutput: () => string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Elixir relay exited before becoming ready (exit ${child.exitCode}).\n${recentOutput()}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
      lastError = new Error(`Relay readiness returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Elixir relay did not become ready on port ${port}: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${recentOutput()}`,
  );
}

export async function startLocalElixirRelay(): Promise<LocalElixirRelay> {
  const relayRoot =
    process.env.PASEO_RELAY_CHECKOUT ?? path.resolve(__dirname, "../../../../../..", "paseo-relay");
  if (!existsSync(path.join(relayRoot, "mix.exs"))) {
    throw new Error(
      `Expected the Elixir relay checkout at ${relayRoot}. Set PASEO_RELAY_CHECKOUT to override it.`,
    );
  }

  const port = await availablePort();
  let child: ChildProcess | null = null;
  let output: string[] = [];

  const start = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      throw new Error("Elixir relay is already running");
    }
    output = [];
    child = spawn("asdf", ["exec", "mix", "run", "--no-halt"], {
      cwd: relayRoot,
      env: {
        ...process.env,
        MIX_ENV: "prod",
        PASEO_RELAY_HOST: "127.0.0.1",
        PASEO_RELAY_PORT: String(port),
        PASEO_RELAY_MIN_CLUSTER_SIZE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (chunk: Buffer) => {
      output.push(chunk.toString("utf8"));
      output = output.join("").split("\n").slice(-80);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    try {
      await waitUntilReady(port, child, () => output.join("\n"));
    } catch (error) {
      await stopProcess(child);
      throw error;
    }
  };

  const stop = async () => {
    if (!child) return;
    await stopProcess(child);
    child = null;
  };

  await start();
  return {
    endpoint: `127.0.0.1:${port}`,
    port,
    start,
    stop,
    close: stop,
  };
}
