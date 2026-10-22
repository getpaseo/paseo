import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { execCommand } from "../utils/spawn.js";
import { agentBrowserEnv } from "./agent-browser-env.js";
export { agentBrowserEnv } from "./agent-browser-env.js";

export type AgentBrowserErrorCode = "tool_missing" | "version_incompatible" | "start_failed";
export class AgentBrowserError extends Error {
  readonly code: AgentBrowserErrorCode;
  constructor(code: AgentBrowserErrorCode) {
    super(code);
    this.code = code;
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new AgentBrowserError("start_failed");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }),
  );
  return address.port;
}

async function ready(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/sessions`, {
      signal: AbortSignal.timeout(500),
      headers: { Origin: url },
    });
    return response.ok && Array.isArray(await response.json());
  } catch {
    return false;
  }
}

export class AgentBrowserDashboards {
  private readonly pending = new Map<string, Promise<string>>();
  private readonly paseoHome: string;
  constructor(paseoHome: string) {
    this.paseoHome = paseoHome;
  }

  async open(workspaceId: string): Promise<string> {
    const existing = this.pending.get(workspaceId);
    if (existing) {
      const url = await existing;
      if (await ready(url)) return url;
      if (this.pending.get(workspaceId) === existing) this.pending.delete(workspaceId);
      return this.open(workspaceId);
    }
    const opening = this.start(workspaceId);
    this.pending.set(workspaceId, opening);
    try {
      return await opening;
    } catch (error) {
      if (this.pending.get(workspaceId) === opening) this.pending.delete(workspaceId);
      throw error;
    }
  }

  private async start(workspaceId: string): Promise<string> {
    const env = agentBrowserEnv(workspaceId, { kind: "agent", id: "dashboard" }, this.paseoHome);
    const executable = await findExecutable("agent-browser");
    if (!executable) throw new AgentBrowserError("tool_missing");
    const run = (args: string[]) =>
      execCommand(executable, args, {
        envOverlay: { ...env, AGENT_BROWSER_DASHBOARD_ALLOWED_ORIGINS: undefined },
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
    let version: string;
    try {
      version = (await run(["--version"])).stdout;
    } catch (error) {
      throw new AgentBrowserError(
        (error as NodeJS.ErrnoException).code === "ENOENT" ? "tool_missing" : "start_failed",
      );
    }
    // 0.37.1 is the first version verified with namespaced dashboard discovery and local-origin checks.
    const match = /agent-browser (\d+)\.(\d+)\.(\d+)/.exec(version);
    if (
      !match ||
      (Number(match[1]) === 0 &&
        (Number(match[2]) < 37 || (Number(match[2]) === 37 && Number(match[3]) < 1)))
    ) {
      throw new AgentBrowserError("version_incompatible");
    }
    const directory = join(
      env.AGENT_BROWSER_SOCKET_DIR!,
      "namespaces",
      env.AGENT_BROWSER_NAMESPACE!,
      "run",
    );
    let port: number | undefined;
    try {
      const pid = Number(await readFile(join(directory, "dashboard.pid"), "utf8"));
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, 0);
        const config = JSON.parse(await readFile(join(directory, "dashboard.config"), "utf8"));
        if (Number.isInteger(config.port) && config.port > 0 && config.port <= 65535)
          port = config.port;
      }
    } catch {
      // A stopped dashboard's sidecars are cleaned up by agent-browser itself.
    }
    port ??= await availablePort();
    try {
      await run(["dashboard", "start", "--port", String(port), "--json"]);
      const url = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (await ready(url)) return url;
        await delay(150);
      }
    } catch {
      throw new AgentBrowserError("start_failed");
    }
    throw new AgentBrowserError("start_failed");
  }
}

const services = new Map<string, AgentBrowserDashboards>();
export function agentBrowserDashboardsForHome(home: string): AgentBrowserDashboards {
  const key = resolvePath(home);
  let service = services.get(key);
  if (!service) {
    service = new AgentBrowserDashboards(key);
    services.set(key, service);
  }
  return service;
}
