import { spawn, execFileSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { withDisabledE2ESpeechEnv } from "./speech-env";
import { killProcessTree, spawnTsx } from "./spawn-node";

export interface IsolatedHostDaemon {
  serverId: string;
  port: number;
  paseoHome: string;
  getPid(): number | undefined;
  restart(): Promise<void>;
  close(): Promise<void>;
}

export interface IsolatedHostDaemonOptions {
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

async function waitForServer(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Isolated host daemon exited before listening (code ${String(child.exitCode)}, signal ${String(child.signalCode)})`,
      );
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.end();
          resolve();
        });
        socket.setTimeout(1_000, () => {
          socket.destroy();
          reject(new Error(`Connection timed out to isolated daemon port ${port}`));
        });
        socket.on("error", reject);
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(
    `Isolated host daemon did not listen on ${port}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function startIsolatedHostDaemon(
  serverId: string,
  options: IsolatedHostDaemonOptions = {},
): Promise<IsolatedHostDaemon> {
  const primaryPort = Number(process.env.E2E_DAEMON_PORT ?? 0);
  let port = await getAvailablePort();
  while (port === 6767 || port === primaryPort) port = await getAvailablePort();

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
  if (options.mutableRelay) {
    const endpoint =
      options.mutableRelay.endpoint ??
      (process.env.E2E_RELAY_PORT ? `127.0.0.1:${process.env.E2E_RELAY_PORT}` : "127.0.0.1:9");
    await writeFile(
      path.join(paseoHome, "config.json"),
      `${JSON.stringify({
        version: 1,
        daemon: {
          relay: {
            enabled: options.mutableRelay.enabled,
            endpoint,
            publicEndpoint: endpoint,
            useTls: false,
            publicUseTls: false,
          },
        },
      })}\n`,
    );
  }
  const serverDir = publishedPackageRoot
    ? path.join(publishedPackageRoot, "node_modules", "@getpaseo", "server")
    : path.resolve(__dirname, "../../../../server");
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
    const child = publishedPackageRoot
      ? spawn(process.execPath, ["dist/scripts/supervisor-entrypoint.js"], spawnOptions)
      : spawnTsx("scripts/supervisor-entrypoint.ts", ["--dev"], spawnOptions);

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      stderr = stderr.split("\n").slice(-40).join("\n");
    });

    try {
      await waitForServer(port, child);
      return child;
    } catch (error) {
      await killProcessTree(child);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nDaemon stderr:\n${stderr}`,
        { cause: error },
      );
    }
  };

  let child: ChildProcess;
  try {
    child = await spawnDaemon();
  } catch (error) {
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
    getPid: () => child.pid,
    restart: async () => {
      if (closed) throw new Error(`Cannot restart closed isolated daemon ${serverId}`);
      await killProcessTree(child);
      child = await spawnDaemon();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await killProcessTree(child);
      if (!options.preserveHome) {
        await rm(paseoHome, { recursive: true, force: true });
      }
      if (publishedPackageRoot) {
        await rm(publishedPackageRoot, { recursive: true, force: true });
      }
    },
  };
}
