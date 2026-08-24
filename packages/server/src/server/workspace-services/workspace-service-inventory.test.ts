import { expect, test } from "vitest";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import { WorkspaceServiceInventory } from "./workspace-service-inventory.js";
import type { WorkspaceServiceRuntime } from "./workspace-service-runtime.js";

const configured: WorkspaceScriptPayload[] = [
  {
    scriptName: "dev",
    type: "service",
    hostname: "dev.workspace.localhost",
    port: 5173,
    localProxyUrl: "http://dev.workspace.localhost:4545",
    publicProxyUrl: null,
    proxyUrl: null,
    lifecycle: "running",
    health: "healthy",
    exitCode: null,
    terminalId: "configured-terminal",
  },
  {
    scriptName: "docs",
    type: "service",
    hostname: "docs.workspace.localhost",
    port: 3000,
    localProxyUrl: null,
    publicProxyUrl: null,
    proxyUrl: null,
    lifecycle: "stopped",
    health: null,
    exitCode: 1,
    terminalId: null,
  },
];

test("merges sources by authority and ranks healthy services first", async () => {
  const runtime = {
    listTerminalCandidates: () => [
      {
        id: "terminal-duplicate",
        workspaceId: "workspace-1",
        source: "terminal" as const,
        label: "localhost:5173",
        lifecycle: "healthy" as const,
        terminalId: "terminal-1",
        port: 5173,
        localUrl: "http://localhost:5173",
        publicUrl: null,
        observedAt: "2026-08-24T10:00:00.000Z",
      },
      {
        id: "terminal-unique",
        workspaceId: "workspace-1",
        source: "terminal" as const,
        label: "localhost:4321",
        lifecycle: "unhealthy" as const,
        terminalId: "terminal-2",
        port: 4321,
        localUrl: "http://localhost:4321",
        publicUrl: null,
        observedAt: "2026-08-24T10:00:00.000Z",
      },
    ],
  } as WorkspaceServiceRuntime;
  const inventory = new WorkspaceServiceInventory({
    workspaceScripts: { list: async () => configured },
    runtime,
    resolveWorkspaceCwd: async () => "/workspace",
    listPackageSuggestions: async () => [
      { scriptName: "dev", command: "npm run dev" },
      { scriptName: "preview", command: "npm run preview" },
    ],
    listConfiguredOptions: () => new Map([["dev", { autoStart: true, openWhenHealthy: true }]]),
    now: () => new Date("2026-08-24T12:00:00.000Z"),
  });

  const services = await inventory.list("workspace-1");
  expect(services.map(({ source, label, lifecycle }) => ({ source, label, lifecycle }))).toEqual([
    { source: "configured", label: "dev", lifecycle: "healthy" },
    { source: "package", label: "preview", lifecycle: "available" },
    { source: "terminal", label: "localhost:4321", lifecycle: "unhealthy" },
    { source: "configured", label: "docs", lifecycle: "exited" },
  ]);
  expect(services.find((service) => service.source === "package")?.command).toBe("npm run preview");
  expect(services.find((service) => service.label === "dev")?.openWhenHealthy).toBe(true);
  expect(services.some((service) => service.id === "terminal-duplicate")).toBe(false);
});
