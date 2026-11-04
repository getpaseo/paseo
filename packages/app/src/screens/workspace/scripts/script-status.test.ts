import { describe, expect, it } from "vitest";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import { scriptStatus, summarizeScripts } from "./script-status";

function service(
  scriptName: string,
  state: Pick<WorkspaceScriptPayload, "lifecycle" | "health">,
): WorkspaceScriptPayload {
  return { ...script(scriptName, state.lifecycle), type: "service", health: state.health };
}

function script(
  scriptName: string,
  lifecycle: WorkspaceScriptPayload["lifecycle"],
): WorkspaceScriptPayload {
  return {
    scriptName,
    type: "script",
    hostname: scriptName,
    port: null,
    proxyUrl: null,
    lifecycle,
    health: null,
    exitCode: null,
    terminalId: null,
  };
}

describe("scriptStatus", () => {
  it("colours services by their health and plain scripts by whether they run", () => {
    expect(scriptStatus(script("lint", "stopped"))).toBe("idle");
    expect(scriptStatus(script("lint", "running"))).toBe("running");
    expect(scriptStatus(service("web", { lifecycle: "stopped", health: "unhealthy" }))).toBe(
      "idle",
    );
    expect(scriptStatus(service("web", { lifecycle: "running", health: null }))).toBe("running");
    expect(scriptStatus(service("web", { lifecycle: "running", health: "healthy" }))).toBe(
      "healthy",
    );
    expect(scriptStatus(service("web", { lifecycle: "running", health: "unhealthy" }))).toBe(
      "unhealthy",
    );
  });
});

describe("summarizeScripts", () => {
  it("is idle with nothing running when nothing runs", () => {
    expect(summarizeScripts([])).toEqual({ tone: "idle", running: [] });
    expect(summarizeScripts([script("lint", "stopped")])).toEqual({ tone: "idle", running: [] });
  });

  it("lists the running scripts by name", () => {
    expect(
      summarizeScripts([
        script("lint", "stopped"),
        service("web", { lifecycle: "running", health: null }),
      ]),
    ).toEqual({ tone: "running", running: ["web"] });
  });

  it("is unhealthy when any running service is", () => {
    expect(
      summarizeScripts([
        service("web", { lifecycle: "running", health: "healthy" }),
        service("api", { lifecycle: "running", health: "unhealthy" }),
      ]),
    ).toEqual({ tone: "unhealthy", running: ["web", "api"] });
  });

  it("is healthy only when every running service reports healthy", () => {
    expect(
      summarizeScripts([
        script("lint", "running"),
        service("web", { lifecycle: "running", health: "healthy" }),
        service("api", { lifecycle: "stopped", health: "unhealthy" }),
      ]),
    ).toEqual({ tone: "healthy", running: ["lint", "web"] });
    expect(
      summarizeScripts([
        service("web", { lifecycle: "running", health: "healthy" }),
        service("api", { lifecycle: "running", health: null }),
      ]),
    ).toEqual({ tone: "running", running: ["web", "api"] });
    expect(summarizeScripts([script("lint", "running")])).toEqual({
      tone: "running",
      running: ["lint"],
    });
  });
});
