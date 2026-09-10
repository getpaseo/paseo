import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { selectWorkspaceServiceSummary, workspaceServiceLabelKey } from "./service-summary";

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

describe("selectWorkspaceServiceSummary", () => {
  it("returns nothing when no service is running", () => {
    expect(selectWorkspaceServiceSummary([])).toBeNull();
    expect(selectWorkspaceServiceSummary([script({ lifecycle: "stopped" })])).toBeNull();
  });

  it("reports a running service by name", () => {
    expect(selectWorkspaceServiceSummary([script({ scriptName: "web" })])).toEqual({
      name: "web",
      health: null,
      type: "service",
      otherScripts: [],
    });
  });

  it("includes running plain commands", () => {
    expect(selectWorkspaceServiceSummary([script({ scriptName: "test", type: "script" })])).toEqual(
      { name: "test", health: null, type: "script", otherScripts: [] },
    );
  });

  it("keeps regular scripts visible alongside a service and qualifies nested package names", () => {
    expect(
      selectWorkspaceServiceSummary([
        script({ scriptName: "web", type: "service" }),
        script({ scriptName: "build", type: "script" }),
        script({
          scriptName: "package-id",
          type: "script",
          packageJson: { path: "packages/api/package.json", script: "build" },
        }),
        script({ scriptName: "finished", type: "script", lifecycle: "stopped" }),
      ]),
    ).toEqual({
      name: "web",
      health: null,
      type: "service",
      otherScripts: ["build", "packages/api/build"],
    });
  });

  it("prefers an unhealthy service over a healthy one regardless of order", () => {
    expect(
      selectWorkspaceServiceSummary([
        script({ scriptName: "web", health: "healthy" }),
        script({ scriptName: "api", health: "unhealthy" }),
      ]),
    ).toEqual({ name: "api", health: "unhealthy", type: "service", otherScripts: [] });
  });

  it("takes the first running service when none is failing", () => {
    expect(
      selectWorkspaceServiceSummary([
        script({ scriptName: "web", health: "healthy" }),
        script({ scriptName: "api", health: null }),
      ]),
    ).toEqual({ name: "web", health: "healthy", type: "service", otherScripts: [] });
  });

  it("skips a stopped service to reach a running one", () => {
    expect(
      selectWorkspaceServiceSummary([
        script({ scriptName: "web", lifecycle: "stopped" }),
        script({ scriptName: "api" }),
      ]),
    ).toEqual({ name: "api", health: null, type: "service", otherScripts: [] });
  });
});

describe("workspaceServiceLabelKey", () => {
  it("names an unhealthy service differently from a running one", () => {
    expect(
      workspaceServiceLabelKey({
        name: "web",
        health: "unhealthy",
        type: "service",
        otherScripts: [],
      }),
    ).toBe("sidebar.workspace.status.serviceUnhealthy");
  });

  it.each([["healthy"], [null]] as const)("treats %s as simply running", (health) => {
    expect(
      workspaceServiceLabelKey({ name: "web", health, type: "service", otherScripts: [] }),
    ).toBe("sidebar.workspace.status.serviceRunning");
  });
});
