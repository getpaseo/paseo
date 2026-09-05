import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { createFileObserver, type FileChange } from "./index.js";

const native = vi.hoisted(() => ({ event: (_type: string, _filename: string) => {} }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  watch: (_root: string, _options: unknown, listener: typeof native.event) => {
    native.event = listener;
    return { on() {}, close() {} };
  },
}));
vi.mock("./internal/linux.js", async () => ({
  createLinuxBackend: (await import("./internal/native-recursive.js")).createNativeRecursiveBackend,
}));

test("reconciliation detects a coalesced deletion of a file announced before the first audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-observer-native-"));
  const observer = createFileObserver();
  const changes: FileChange[] = [];
  try {
    const subscription = await observer.subscribe(root, (error, events) => {
      expect(error).toBeNull();
      changes.push(...events);
    });
    const path = join(root, "new.txt");
    await writeFile(path, "created");
    native.event("rename", "new.txt");
    await expect
      .poll(() => changes.some((event) => event.path === path && event.type === "create"))
      .toBe(true);
    await rm(path);
    // Native watchers can coalesce the deletion. The next inventory scan must
    // compare against the file already announced to consumers.
    await subscription.updateIgnore([join(root, "ignored")]);
    await expect
      .poll(() => changes.some((event) => event.path === path && event.type === "delete"))
      .toBe(true);
  } finally {
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});
