import { promisify } from "node:util";
import {
  spawn,
  execFile,
  execFileSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { withDisabledE2ESpeechEnv } from "./speech-env";
import { killProcessTree, spawnTsx } from "./spawn-node";

const execFileAsync = promisify(execFile);

export interface IsolatedHostDaemon {
  serverId: string;
  port: number;
  paseoHome: string;
  getPid(): number | undefined;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export interface IsolatedHostDaemonOptions {
  /** Written to the daemon's config.json; `mutableRelay` adds `daemon.relay` to it. */
  config?: { daemon?: Record<string, unknown>; [key: string]: unknown };
  environment?: NodeJS.ProcessEnv;
  mutableRelay?: {
    enabled: boolean;
    endpoint?: string;
  };
  paseoHome?: string;
  preserveHome?: boolean;
  publishedVersion?: string;
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire an isolated daemon port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

export async function getAvailableHostDaemonPort(): Promise<number> {
  const primaryPort = Number(process.env.E2E_DAEMON_PORT ?? 0);
  let port = await getAvailablePort();
  while (port === 6767 || port === 6768 || port === primaryPort) port = await getAvailablePort();
  return port;
}

/**
 * Resolves once this daemon answers on its port. An open TCP port is not
 * enough: the port is released before the daemon binds it, and whatever takes
 * it in between also accepts connections while the daemon exits with
 * EADDRINUSE. Only the daemon's own status reports its server id.
 */
async function waitForServer(
  port: number,
  child: ChildProcess,
  identity: { serverId: string; paseoHome: string },
): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Isolated host daemon exited before listening (code ${String(child.exitCode)}, signal ${String(child.signalCode)})`,
      );
    }
    try {
      const serverId = await readServerId(port, identity.paseoHome);
      if (serverId === identity.serverId) return;
      lastError = new Error(`Port ${port} is served by ${serverId}, not ${identity.serverId}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Isolated host daemon did not listen on ${port}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * Reads the server id from the daemon's status route. The route needs a bearer
 * on a password-protected daemon; the daemon accepts the local credential it
 * writes into its home before listening, as the CLI does for local status.
 */
async function readServerId(port: number, paseoHome: string): Promise<string> {
  const localCredential = await readFile(path.join(paseoHome, "local-credential"), "utf8").then(
    (token) => token.trim(),
    () => null,
  );
  const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
    headers: localCredential ? { authorization: `Bearer ${localCredential}` } : {},
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error(`Status request to port ${port} returned ${response.status}`);
  const status = (await response.json()) as { serverId?: unknown };
  return String(status.serverId);
}

function withMutableRelay(
  config: NonNullable<IsolatedHostDaemonOptions["config"]>,
  relay: NonNullable<IsolatedHostDaemonOptions["mutableRelay"]>,
): NonNullable<IsolatedHostDaemonOptions["config"]> {
  const endpoint =
    relay.endpoint ??
    (process.env.E2E_RELAY_PORT ? `127.0.0.1:${process.env.E2E_RELAY_PORT}` : "127.0.0.1:9");
  return {
    ...config,
    daemon: {
      ...config.daemon,
      relay: {
        enabled: relay.enabled,
        endpoint,
        publicEndpoint: endpoint,
        useTls: false,
        publicUseTls: false,
      },
    },
  };
}

export async function startIsolatedHostDaemon(
  serverId: string,
  options: IsolatedHostDaemonOptions = {},
): Promise<IsolatedHostDaemon> {
  let port = await getAvailableHostDaemonPort();

  const metroPort = process.env.E2E_METRO_PORT;
  if (!metroPort) throw new Error("E2E_METRO_PORT is required to start an isolated host daemon");

  const paseoHome =
    options.paseoHome ?? (await mkdtemp(path.join(tmpdir(), "paseo-e2e-secondary-host-")));
  let publishedPackageRoot: string | null = null;
  if (options.publishedVersion) {
    publishedPackageRoot = await mkdtemp(path.join(tmpdir(), "paseo-e2e-published-server-"));
    await writeFile(
      path.join(publishedPackageRoot, "package.json"),
      `${JSON.stringify({ private: true })}\n`,
    );
    try {
      const npmCli = process.env.npm_execpath;
      if (!npmCli || path.basename(npmCli).toLowerCase() !== "npm-cli.js") {
        throw new Error(
          "Published-version E2E requires npm_execpath from npm. Start it through `npm run test:e2e`.",
        );
      }
      execFileSync(
        process.execPath,
        [
          npmCli,
          "install",
          "--no-audit",
          "--no-fund",
          "--no-package-lock",
          `@getpaseo/server@${options.publishedVersion}`,
        ],
        { cwd: publishedPackageRoot, stdio: "ignore" },
      );
    } catch (error) {
      if (!options.preserveHome) {
        await rm(paseoHome, { recursive: true, force: true });
      }
      await rm(publishedPackageRoot, { recursive: true, force: true });
      throw error;
    }
  }
  const config = options.mutableRelay
    ? withMutableRelay(options.config ?? {}, options.mutableRelay)
    : options.config;
  if (config) {
    await writeFile(
      path.join(paseoHome, "config.json"),
      `${JSON.stringify({ version: 1, ...config })}\n`,
    );
  }
  const serverDir = publishedPackageRoot
    ? path.join(publishedPackageRoot, "node_modules", "@getpaseo", "server")
    : path.resolve(__dirname, "../../../../server");
  let child: ChildProcess | null = null;
  const stopDaemon = async (): Promise<void> => {
    // The CLI owns graceful shutdown, forced cleanup and detached terminal
    // reaping. Keep its ESM graph out of Playwright's transforming loader.
    await execFileAsync(
      process.execPath,
      [
        path.resolve(__dirname, "../../../../cli/dist/index.js"),
        "daemon",
        "stop",
        "--home",
        paseoHome,
        "--force",
      ],
      { timeout: 30_000 },
    );
    await killProcessTree(child);
  };
  const spawnDaemon = async (): Promise<ChildProcess> => {
    const spawnOptions: SpawnOptions = {
      cwd: serverDir,
      env: withDisabledE2ESpeechEnv({
        ...process.env,
        ...options.environment,
        PASEO_HOME: paseoHome,
        PASEO_SERVER_ID: serverId,
        PASEO_LISTEN: `127.0.0.1:${port}`,
        PASEO_CORS_ORIGINS: `http://localhost:${metroPort}`,
        PASEO_RELAY_ENABLED: options.mutableRelay ? undefined : "0",
        PASEO_NODE_ENV: "development",
        NODE_ENV: "development",
      }),
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    };
    const builtSupervisor = path.join(serverDir, "dist/scripts/supervisor-entrypoint.js");
    const useBuiltSupervisor = Boolean(
      publishedPackageRoot || (process.env.CI && existsSync(builtSupervisor)),
    );
    const spawned = useBuiltSupervisor
      ? spawn(process.execPath, ["dist/scripts/supervisor-entrypoint.js"], spawnOptions)
      : spawnTsx("scripts/supervisor-entrypoint.ts", ["--dev"], spawnOptions);

    child = spawned;
    let stderr = "";
    spawned.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      stderr = stderr.split("\n").slice(-40).join("\n");
    });

    try {
      await waitForServer(port, spawned, { serverId, paseoHome });
      return spawned;
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nDaemon stderr:\n${stderr}`,
        { cause: error },
      );
    }
  };

  // The reserved port is released before the daemon binds it, so another
  // process can take it in between. Only the first start picks a new port:
  // restart() keeps the endpoint the app already knows.
  const startOnFreePort = async (): Promise<void> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await spawnDaemon();
        return;
      } catch (error) {
        const lostPort = error instanceof Error && error.message.includes("EADDRINUSE");
        if (!lostPort || attempt === 3) throw error;
        await stopDaemon();
        port = await getAvailableHostDaemonPort();
      }
    }
  };

  try {
    await startOnFreePort();
  } catch (error) {
    await stopDaemon();
    if (!options.preserveHome) {
      await rm(paseoHome, { recursive: true, force: true });
    }
    if (publishedPackageRoot) {
      await rm(publishedPackageRoot, { recursive: true, force: true });
    }
    throw error;
  }
  let closed = false;

  return {
    serverId,
    port,
    paseoHome,
    getPid: () => child?.pid,
    restart: async () => {
      if (closed) throw new Error(`Cannot restart closed isolated daemon ${serverId}`);
      await stopDaemon();
      await spawnDaemon();
    },
    close: async () => {
      if (closed) return;
      await stopDaemon();
      if (!options.preserveHome) {
        await rm(paseoHome, { recursive: true, force: true });
      }
      if (publishedPackageRoot) {
        await rm(publishedPackageRoot, { recursive: true, force: true });
      }
      closed = true;
    },
  };
}
