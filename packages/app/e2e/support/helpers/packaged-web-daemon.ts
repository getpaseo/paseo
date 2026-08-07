import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PackagedWebDaemon {
  home: string;
  origin: string;
  port: number;
  serverId: string;
  pairingOfferUrl(): Promise<string>;
  close(): Promise<void>;
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a daemon port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForWebUi(origin: string, home: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1_000) });
      const body = await response.text();
      if (response.ok && body.includes("<html")) return;
      lastError = new Error(`Daemon web UI returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const log = await readFile(path.join(home, "daemon.log"), "utf8").catch(() => "");
  throw new Error(
    `Daemon web UI did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${log.split("\n").slice(-80).join("\n")}`,
  );
}

export async function startPackagedWebDaemon(input: {
  relayEndpoint: string;
}): Promise<PackagedWebDaemon> {
  const port = await availablePort();
  const home = await mkdtemp(path.join(tmpdir(), "paseo-relay-deployment-e2e-"));
  const serverId = `relay-deployment-${Date.now().toString(36)}`;
  const paseo = path.resolve(__dirname, "../../../../../node_modules/.bin/paseo");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "true",
    NODE_ENV: "development",
    PASEO_NODE_ENV: "development",
    PASEO_SERVER_ID: serverId,
    PASEO_RELAY_ENDPOINT: input.relayEndpoint,
    PASEO_RELAY_PUBLIC_ENDPOINT: input.relayEndpoint,
    PASEO_RELAY_USE_TLS: "false",
    PASEO_RELAY_PUBLIC_USE_TLS: "false",
  };

  try {
    await execFileAsync(
      paseo,
      ["daemon", "start", "--home", home, "--port", String(port), "--relay", "--web-ui"],
      { env },
    );
    const origin = `http://127.0.0.1:${port}`;
    await waitForWebUi(origin, home);

    return {
      home,
      origin,
      port,
      serverId,
      pairingOfferUrl: async () => {
        const { stdout } = await execFileAsync(
          paseo,
          ["daemon", "pair", "--home", home, "--relay", "--json"],
          { env },
        );
        const result = JSON.parse(stdout) as { url?: unknown };
        if (typeof result.url !== "string") {
          throw new Error(`Pairing command returned no URL: ${stdout}`);
        }
        return result.url;
      },
      close: async () => {
        await execFileAsync(paseo, ["daemon", "stop", "--home", home], { env }).catch(
          () => undefined,
        );
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await execFileAsync(paseo, ["daemon", "stop", "--home", home], { env }).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}
