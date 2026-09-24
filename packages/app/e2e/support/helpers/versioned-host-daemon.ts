import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { getAvailableHostDaemonPort } from "./isolated-host-daemon";
import { killProcessTree, spawnTsx } from "./spawn-node";

const VERSIONED_DAEMON_ENTRYPOINT = path.resolve(
  __dirname,
  "../../../../server/src/server/test-utils/versioned-daemon.ts",
);

const READY_TIMEOUT_MS = 30_000;

// A host daemon that can be replaced by a daemon reporting another version under the same
// endpoint and serverId, the way an upgraded host comes back.
export interface RestartableHostDaemon {
  serverId: string;
  port: number;
  restartWithVersion(version: string): Promise<void>;
  dispose(): Promise<void>;
}

export async function startRestartableHostDaemon(version: string): Promise<RestartableHostDaemon> {
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-e2e-restartable-host-"));
  const port = await getAvailableHostDaemonPort();
  let current: VersionedHostDaemon | null = null;
  const dispose = async (): Promise<void> => {
    await current?.stop();
    current = null;
    await rm(paseoHomeRoot, { recursive: true, force: true });
  };
  try {
    current = await startVersionedHostDaemon({ version, port, paseoHomeRoot });
  } catch (error) {
    await dispose();
    throw error;
  }
  const { serverId } = current;

  return {
    serverId,
    port,
    async restartWithVersion(nextVersion) {
      await current?.stop();
      current = null;
      await waitForPortReleased(port);
      current = await startVersionedHostDaemon({ version: nextVersion, port, paseoHomeRoot });
      if (current.serverId !== serverId) {
        throw new Error(
          `Restarted host daemon reported serverId ${current.serverId}, expected ${serverId}`,
        );
      }
    },
    dispose,
  };
}

interface VersionedHostDaemon {
  serverId: string;
  port: number;
  version: string;
  stop(): Promise<void>;
}

interface VersionedHostDaemonOptions {
  version: string;
  port: number;
  paseoHomeRoot: string;
}

// Starts the versioned test daemon on an explicit port with a caller-owned PASEO_HOME. The caller
// removes the home root.
async function startVersionedHostDaemon(
  options: VersionedHostDaemonOptions,
): Promise<VersionedHostDaemon> {
  const child = spawnTsx(
    VERSIONED_DAEMON_ENTRYPOINT,
    [options.version, String(options.port), options.paseoHomeRoot],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const ready = Promise.withResolvers<{ port: number; serverId: string }>();
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.once("error", ready.reject);
  child.once("exit", () => {
    ready.reject(
      new Error(`Versioned daemon ${options.version} exited before reporting ready:\n${output}`),
    );
  });
  child.once("message", (message) => {
    if (!isReadyMessage(message)) {
      ready.reject(new Error("Invalid versioned daemon startup message"));
      return;
    }
    ready.resolve(message);
  });
  const timeout = setTimeout(
    () =>
      ready.reject(
        new Error(
          `Versioned daemon ${options.version} did not report ready within ${READY_TIMEOUT_MS}ms:\n${output}`,
        ),
      ),
    READY_TIMEOUT_MS,
  );

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await killProcessTree(child);
  };

  try {
    const readyMessage = await ready.promise;
    if (readyMessage.port !== options.port) {
      throw new Error(
        `Versioned daemon ${options.version} bound port ${readyMessage.port}, expected ${options.port}`,
      );
    }
    return {
      serverId: readyMessage.serverId,
      port: readyMessage.port,
      version: options.version,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// A replacement daemon can only bind the port the stopped daemon just released.
async function waitForPortReleased(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortAvailable(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Port ${port} was not released within ${timeoutMs}ms`);
}

function isReadyMessage(message: unknown): message is { port: number; serverId: string } {
  return (
    typeof message === "object" &&
    message !== null &&
    "port" in message &&
    typeof message.port === "number" &&
    "serverId" in message &&
    typeof message.serverId === "string"
  );
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}
