import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { selectWorkspaceScriptSummary } from "./script-summary";

type Script = SidebarWorkspaceEntry["scripts"][number];

function script(overrides: Partial<Script>): Script {
  return {
    scriptName: "dev",
    type: "service",
    hostname: "localhost",
    port: null,
    proxyUrl: null,
    lifecycle: "running",
    health: null,
    exitCode: null,
    terminalId: null,
    ...overrides,
  } as Script;
}

describe("selectWorkspaceScriptSummary", () => {
  it("returns nothing when no script is running", () => {
    expect(selectWorkspaceScriptSummary([])).toBeNull();
    expect(selectWorkspaceScriptSummary([script({ lifecycle: "stopped", port: 3000 })])).toBeNull();
  });

  it("reports a running service with its port", () => {
    expect(selectWorkspaceScriptSummary([script({ port: 3000 })])).toEqual({
      kind: "service",
      port: 3000,
    });
  });

  it("reports a service that has not bound a port yet", () => {
    expect(selectWorkspaceScriptSummary([script({ port: null })])).toEqual({
      kind: "service",
      port: null,
    });
  });

  it("falls back to a running command when no service runs", () => {
    expect(selectWorkspaceScriptSummary([script({ type: "script", port: null })])).toEqual({
      kind: "command",
      port: null,
    });
  });

  it("prefers a running service over a running command regardless of order", () => {
    expect(
      selectWorkspaceScriptSummary([
        script({ scriptName: "test", type: "script" }),
        script({ scriptName: "dev", type: "service", port: 8080 }),
      ]),
    ).toEqual({ kind: "service", port: 8080 });
  });

  it("ignores stopped services when a command is running", () => {
    expect(
      selectWorkspaceScriptSummary([
        script({ scriptName: "dev", type: "service", port: 3000, lifecycle: "stopped" }),
        script({ scriptName: "test", type: "script" }),
      ]),
    ).toEqual({ kind: "command", port: null });
  });
});
