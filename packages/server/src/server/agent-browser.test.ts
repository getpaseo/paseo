import { findExecutable } from "../executable-resolution/executable-resolution.js";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { agentBrowserEnv, AgentBrowserDashboards } from "./agent-browser.js";
import { execCommand } from "../utils/spawn.js";

// Replace only the installed CLI boundary; readiness still exercises a real HTTP server.
vi.mock("../utils/spawn.js", () => ({ execCommand: vi.fn() }));
vi.mock("../executable-resolution/executable-resolution.js", () => ({ findExecutable: vi.fn() }));
beforeEach(() => {
  vi.mocked(findExecutable).mockResolvedValue("agent-browser");
});
const servers: Server[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("agent-browser workspace association", () => {
  it("is stable, separates installations and workspaces, and gives each owner a default session", () => {
    const owner = { kind: "agent" as const, id: "one" };
    const first = agentBrowserEnv("workspace-a", owner, "/installation-a");
    expect(agentBrowserEnv("workspace-a", owner, "/installation-a")).toEqual(first);
    expect(
      agentBrowserEnv("workspace-b", owner, "/installation-a").AGENT_BROWSER_NAMESPACE,
    ).not.toBe(first.AGENT_BROWSER_NAMESPACE);
    expect(
      agentBrowserEnv("workspace-a", owner, "/installation-b").AGENT_BROWSER_NAMESPACE,
    ).not.toBe(first.AGENT_BROWSER_NAMESPACE);
    const sibling = agentBrowserEnv("workspace-a", { kind: "agent", id: "two" }, "/installation-a");
    expect(sibling.AGENT_BROWSER_NAMESPACE).toBe(first.AGENT_BROWSER_NAMESPACE);
    expect(sibling.AGENT_BROWSER_SESSION).not.toBe(first.AGENT_BROWSER_SESSION);
    expect(
      agentBrowserEnv("workspace-a", { kind: "terminal", id: "one" }, "/installation-a")
        .AGENT_BROWSER_SESSION,
    ).not.toBe(first.AGENT_BROWSER_SESSION);
  });
});

function emptyDashboard() {
  return createServer((request, response) => {
    response.writeHead(request.headers.origin === `http://${request.headers.host}` ? 200 : 403, {
      "Content-Type": "application/json",
    });
    response.end("[]");
  });
}

describe("agent-browser dashboard", () => {
  it("groups concurrent launches, reuses a ready dashboard, and isolates workspace ports", async () => {
    const launches: { namespace: string; args: string[] }[] = [];
    vi.mocked(execCommand).mockImplementation(async (_command, args, options) => {
      if (args[0] === "--version") return { stdout: "agent-browser 0.37.1", stderr: "" };
      launches.push({ namespace: options!.envOverlay!.AGENT_BROWSER_NAMESPACE!, args });
      const server = emptyDashboard();
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(Number(args[3]), "127.0.0.1", resolve));
      return { stdout: "", stderr: "" };
    });
    const service = new AgentBrowserDashboards("/test-dashboard-home");
    const [one, same, other] = await Promise.all([
      service.open("first"),
      service.open("first"),
      service.open("second"),
    ]);
    expect(one).toBe(same);
    expect(other).not.toBe(one);
    expect(await service.open("first")).toBe(one);
    expect(launches).toHaveLength(2);
    expect(launches[0]!.namespace).not.toBe(launches[1]!.namespace);
    expect(launches[0]!.args).toEqual([
      "dashboard",
      "start",
      "--port",
      expect.any(String),
      "--json",
    ]);
  });

  it("reports an absent tool and permits retry", async () => {
    vi.mocked(findExecutable).mockResolvedValueOnce(null);
    const service = new AgentBrowserDashboards("/test-dashboard-home");
    await expect(service.open("one")).rejects.toMatchObject({ code: "tool_missing" });
    vi.mocked(execCommand).mockResolvedValue({ stdout: "agent-browser 0.36.0", stderr: "" });
    await expect(service.open("one")).rejects.toMatchObject({ code: "version_incompatible" });
  });

  it("reports a failed dashboard startup", async () => {
    vi.mocked(execCommand)
      .mockResolvedValueOnce({ stdout: "agent-browser 0.37.1", stderr: "" })
      .mockRejectedValueOnce(new Error("port unavailable"));
    await expect(
      new AgentBrowserDashboards("/test-dashboard-home").open("one"),
    ).rejects.toMatchObject({ code: "start_failed" });
  });
});
