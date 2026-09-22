import { expect, test } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { LanguageDocuments } from "./process.js";

test("sends full text only when content changes and reopens closed documents", async () => {
  const notifications: unknown[][] = [];
  const documents = new LanguageDocuments({
    sendNotification: async (...args) => {
      notifications.push(args);
    },
  });
  const path = resolve("example.ts");
  const uri = pathToFileURL(path).href;
  await documents.sync(path, "const n = 1;", 1);
  await documents.sync(path, "const n = 1;", 2);
  await documents.sync(path, "const n = 1;", 3);
  await documents.sync(path, "const n = 2;", 4);
  await documents.sync(path, "const n = 2;", 5);
  await documents.close(path);
  await documents.sync(path, "const n = 2;", 6);
  expect(
    notifications.map(([type, params]) => [(type as { method: string }).method, params]),
  ).toEqual([
    [
      "textDocument/didOpen",
      { textDocument: { uri, languageId: "typescript", version: 1, text: "const n = 1;" } },
    ],
    [
      "textDocument/didChange",
      { textDocument: { uri, version: 4 }, contentChanges: [{ text: "const n = 2;" }] },
    ],
    ["textDocument/didClose", { textDocument: { uri } }],
    [
      "textDocument/didOpen",
      { textDocument: { uri, languageId: "typescript", version: 6, text: "const n = 2;" } },
    ],
  ]);
});

test("coalesces concurrent identical syncs while a notification is being written", async () => {
  let finish!: () => void;
  const writing = new Promise<void>((complete) => {
    finish = complete;
  });
  let notifications = 0;
  const documents = new LanguageDocuments({
    sendNotification: async () => {
      notifications++;
      await writing;
    },
  });
  const first = documents.sync(resolve("concurrent.ts"), "const n = 1;", 1);
  const second = documents.sync(resolve("concurrent.ts"), "const n = 1;", 2);
  expect(notifications).toBe(1);
  finish();
  await Promise.all([first, second]);
});

test("retries text whose notification failed", async () => {
  let notifications = 0;
  let fail = true;
  const documents = new LanguageDocuments({
    sendNotification: async () => {
      notifications++;
      if (fail) throw new Error("Connection closed");
    },
  });
  await expect(documents.sync(resolve("failed.ts"), "const n = 1;", 1)).rejects.toThrow(
    "Connection closed",
  );
  fail = false;
  await documents.sync(resolve("failed.ts"), "const n = 1;", 2);
  expect(notifications).toBe(2);
});
