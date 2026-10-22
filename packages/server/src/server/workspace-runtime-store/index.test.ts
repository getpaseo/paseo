import { expect, test } from "vitest";
import { resolve } from "node:path";
import { createNoGitWorkspaceRuntimeSnapshot } from "../test-utils/workspace-git-service-stub.js";
import { createWorkspaceRuntimeStore } from "./index.js";

test("retains, replaces, and removes snapshots by resolved workspace directory", () => {
  const store = createWorkspaceRuntimeStore();
  const cwd = "./workspace";
  const snapshot = createNoGitWorkspaceRuntimeSnapshot(cwd);
  expect(store.get(cwd)).toBeNull();
  store.set(snapshot);
  expect(store.get(resolve(cwd))).toBe(snapshot);
  const replacement = createNoGitWorkspaceRuntimeSnapshot(cwd);
  store.set(replacement);
  expect(store.get(cwd)).toBe(replacement);
  store.remove(resolve(cwd));
  expect(store.get(cwd)).toBeNull();
});
