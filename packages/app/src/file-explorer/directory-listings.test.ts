import { describe, expect, it } from "vitest";
import type { AgentFileExplorerState, ExplorerDirectory } from "@/stores/session-store";
import { invalidateExplorerDirectoryListings, loadExplorerDirectory } from "./directory-listings";

function directory(path: string, names: string[]): ExplorerDirectory {
  return {
    path,
    entries: names.map((name) => ({
      path: `${path}/${name}`,
      name,
      kind: "file",
      size: 0,
      modifiedAt: "2026-01-01T00:00:00.000Z",
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function explorer() {
  let state: AgentFileExplorerState = {
    listingGeneration: 0,
    directories: new Map([[".", directory(".", ["docs"])]]),
    isLoading: false,
    lastError: null,
    pendingRequest: null,
    currentPath: ".",
    history: ["."],
    lastVisitedPath: ".",
    selectedEntryPath: null,
  };
  const updateState = (update: (state: AgentFileExplorerState) => AgentFileExplorerState) => {
    state = update(state);
    return state;
  };
  return {
    state: () => state,
    load: (path: string, result: Promise<ExplorerDirectory>) =>
      loadExplorerDirectory({
        path,
        updateState,
        listDirectory: () => result,
        fallbackError: "Directory listing failed",
        options: { recordHistory: false, setCurrentPath: false },
      }),
    refresh: (retained: string[]) => invalidateExplorerDirectoryListings(updateState, retained),
  };
}

describe("directory listings across Refresh", () => {
  it("ignores an earlier reply for a collapsed folder while the fresh root is loading", async () => {
    const model = explorer();
    const old = deferred<ExplorerDirectory>();
    const oldLoad = model.load("docs", old.promise);
    model.refresh(["."]);
    const fresh = deferred<ExplorerDirectory>();
    const freshLoad = model.load(".", fresh.promise);
    old.resolve(directory("docs", ["OLD.md"]));

    await expect(oldLoad).resolves.toBeNull();
    expect(model.state().directories.has("docs")).toBe(false);
    expect(model.state().isLoading).toBe(true);
    expect(model.state().pendingRequest?.path).toBe(".");

    const root = directory(".", ["docs", "NEW.md"]);
    fresh.resolve(root);
    await expect(freshLoad).resolves.toEqual(root);
    expect(model.state().directories.get(".")).toEqual(root);
    expect(model.state().isLoading).toBe(false);
  });

  it("does not let a pre-refresh reply replace a newer listing of the same folder", async () => {
    const model = explorer();
    const old = deferred<ExplorerDirectory>();
    const oldLoad = model.load("docs", old.promise);
    model.refresh([".", "docs"]);
    const fresh = directory("docs", ["NEW.md"]);
    await model.load("docs", Promise.resolve(fresh));
    old.resolve(directory("docs", ["OLD.md"]));

    await expect(oldLoad).resolves.toBeNull();
    expect(model.state().directories.get("docs")).toEqual(fresh);
  });

  it("ignores errors from requests invalidated by Refresh", async () => {
    const model = explorer();
    const old = deferred<ExplorerDirectory>();
    const oldLoad = model.load("docs", old.promise);
    model.refresh(["."]);
    const fresh = deferred<ExplorerDirectory>();
    const freshLoad = model.load(".", fresh.promise);
    old.reject(new Error("Old request failed"));

    await expect(oldLoad).resolves.toBeNull();
    expect(model.state().lastError).toBeNull();
    expect(model.state().isLoading).toBe(true);
    fresh.resolve(directory(".", ["docs"]));
    await freshLoad;
  });

  it("keeps expanded listings visible and discards collapsed listings on Refresh", async () => {
    const model = explorer();
    const docs = directory("docs", ["guide.md"]);
    await model.load("docs", Promise.resolve(docs));
    await model.load("assets", Promise.resolve(directory("assets", ["logo.png"])));
    model.refresh([".", "docs"]);

    expect(model.state().directories.get("docs")).toEqual(docs);
    expect(model.state().directories.has("assets")).toBe(false);
    expect(model.state().currentPath).toBe(".");
    expect(model.state().history).toEqual(["."]);
  });
});
