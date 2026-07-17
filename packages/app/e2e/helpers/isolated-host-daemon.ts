import { once } from "node:events";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { withDisabledE2ESpeechEnv } from "./speech-env";

export interface IsolatedHostDaemon {
  serverId: string;
  port: number;
  close(): Promise<void>;
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
  const deadline = Date.now() + 20_000;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Isolated host daemon exited before listening (exit ${child.exitCode})`);
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

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timeout = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 5_000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(timeout);
  }
}

export async function startIsolatedHostDaemon(serverId: string): Promise<IsolatedHostDaemon> {
  const primaryPort = Number(process.env.E2E_DAEMON_PORT ?? 0);
  let port = await getAvailablePort();
  while (port === 6767 || port === primaryPort) port = await getAvailablePort();

  const metroPort = process.env.E2E_METRO_PORT;
  if (!metroPort) throw new Error("E2E_METRO_PORT is required to start an isolated host daemon");

  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-e2e-secondary-host-"));
  const serverDir = path.resolve(__dirname, "../../../server");
  const tsxBin = execSync("which tsx").toString().trim();
  const child = spawn(tsxBin, ["scripts/supervisor-entrypoint.ts", "--dev"], {
    cwd: serverDir,
    env: withDisabledE2ESpeechEnv({
      ...process.env,
      PASEO_HOME: paseoHome,
      PASEO_SERVER_ID: serverId,
      PASEO_LISTEN: `127.0.0.1:${port}`,
      PASEO_CORS_ORIGINS: `http://localhost:${metroPort}`,
      PASEO_RELAY_ENABLED: "0",
      PASEO_NODE_ENV: "development",
      NODE_ENV: "development",
    }),
    stdio: ["ignore", "ignore", "pipe"],
    detached: false,
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    stderr = stderr.split("\n").slice(-40).join("\n");
  });

  try {
    await waitForServer(port, child);
  } catch (error) {
    await stopProcess(child);
    await rm(paseoHome, { recursive: true, force: true });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nDaemon stderr:\n${stderr}`,
      { cause: error },
    );
  }

  return {
    serverId,
    port,
    close: async () => {
      await stopProcess(child);
      await rm(paseoHome, { recursive: true, force: true });
    },
  };
}
