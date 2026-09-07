import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { transformFileSync } from "@babel/core";
import { expect, test } from "vitest";
import type { useWorkspaceDraftSubmissionStore } from "./workspace-draft-submission-store";

// Exercise the emitted app code: plain TypeScript execution misses Expo's omit bug.
function loadProductionStore() {
  const filename = fileURLToPath(new URL("./workspace-draft-submission-store.ts", import.meta.url));
  const caller = { name: "metro", platform: "web", isDev: false, supportsStaticESM: false };
  const result = transformFileSync(filename, {
    envName: "production",
    caller,
  });
  if (!result?.code) throw new Error("Expo produced no store code");
  const module = {
    exports: {} as { useWorkspaceDraftSubmissionStore: typeof useWorkspaceDraftSubmissionStore },
  };
  new Function("require", "module", "exports", result.code)(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  return module.exports.useWorkspaceDraftSubmissionStore;
}

test("the production app consumes a draft once and leaves other drafts pending", () => {
  const store = loadProductionStore();
  const submission = {
    serverId: "server",
    workspaceId: "workspace",
    draftId: "draft-1",
    text: "hello",
    attachments: [],
    cwd: "/repo",
    provider: "codex",
    clientMessageId: "message",
    timestamp: 1,
  } as const;
  store.getState().setPending({ ...submission, attachments: [] });
  store.getState().setPending({ ...submission, attachments: [], draftId: "draft-2" });
  expect(store.getState().consumePending({ ...submission, workspaceId: "wrong" })).toBeNull();
  expect(store.getState().consumePending(submission)).toEqual(submission);
  expect(store.getState().consumePending(submission)).toBeNull();
  expect(Object.keys(store.getState().pendingByDraftId)).toEqual(["draft-2"]);
});
