import { describe, expect, it } from "vitest";
import {
  WorkspaceScriptRuntimeStore,
  type ScriptRuntimeEntry,
} from "./workspace-script-runtime-store.js";

function createEntry(overrides: Partial<ScriptRuntimeEntry> = {}): ScriptRuntimeEntry {
  return {
    workspaceId: "workspace-101",
    scriptName: "web",
    type: "service",
    lifecycle: "running",
    terminalId: "terminal-1",
    exitCode: null,
    ...overrides,
  };
}

describe("WorkspaceScriptRuntimeStore", () => {
  it("stores and returns entries by workspace and script name", () => {
    const store = new WorkspaceScriptRuntimeStore();
    const entry = createEntry();

    store.set(entry);

    expect(store.get({ workspaceId: "workspace-101", scriptName: "web" })).toEqual(entry);
    expect(store.listForWorkspace("workspace-101")).toEqual([entry]);
  });

  it("preserves whether the runtime entry is a plain script or service", () => {
    const store = new WorkspaceScriptRuntimeStore();
    const entry = createEntry({
      scriptName: "typecheck",
      type: "script",
    });

    store.set(entry);

    expect(store.get({ workspaceId: "workspace-101", scriptName: "typecheck" })).toEqual(entry);
  });

  it("reports whether a script is currently running", () => {
    const store = new WorkspaceScriptRuntimeStore();
    store.set(createEntry());
    store.set(
      createEntry({
        workspaceId: "workspace-101",
        scriptName: "typecheck",
        lifecycle: "stopped",
        terminalId: "terminal-2",
        exitCode: 0,
      }),
    );

    expect(store.isRunning({ workspaceId: "workspace-101", scriptName: "web" })).toBe(true);
    expect(store.isRunning({ workspaceId: "workspace-101", scriptName: "typecheck" })).toBe(false);
    expect(store.isRunning({ workspaceId: "workspace-101", scriptName: "missing" })).toBe(false);
  });

  it("removes individual entries", () => {
    const store = new WorkspaceScriptRuntimeStore();
    store.set(createEntry());

    store.remove({ workspaceId: "workspace-101", scriptName: "web" });

    expect(store.get({ workspaceId: "workspace-101", scriptName: "web" })).toBeNull();
    expect(store.listForWorkspace("workspace-101")).toEqual([]);
  });

  it("removes all entries for a workspace without touching others", () => {
    const store = new WorkspaceScriptRuntimeStore();
    store.set(createEntry());
    store.set(
      createEntry({
        workspaceId: "workspace-101",
        scriptName: "api",
        terminalId: "terminal-2",
      }),
    );
    store.set(
      createEntry({
        workspaceId: "workspace-202",
        scriptName: "docs",
        terminalId: "terminal-3",
      }),
    );

    store.removeForWorkspace("workspace-101");

    expect(store.listForWorkspace("workspace-101")).toEqual([]);
    expect(store.listForWorkspace("workspace-202")).toEqual([
      createEntry({
        workspaceId: "workspace-202",
        scriptName: "docs",
        terminalId: "terminal-3",
      }),
    ]);
  });
});
