import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, test } from "vitest";
import { TaskArtifactStore, extractArtifactPaths } from "./task-artifacts.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-artifacts-"));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  await mkdir(cwd);
  await writeFile(path.join(cwd, "结果.pdf"), "%PDF-test");
  return { root, cwd, store: new TaskArtifactStore(path.join(root, "home")) };
}
test("artifacts persist per task, refresh changed/missing status, and removal leaves the file intact", async () => {
  const { root, cwd, store } = await fixture();
  await store.update("task-a", cwd, "add", "结果.pdf");
  expect(await store.list("task-b", cwd)).toEqual([]);
  expect(await new TaskArtifactStore(path.join(root, "home")).list("task-a", cwd)).toMatchObject([
    { name: "结果.pdf", status: "ready" },
  ]);
  await writeFile(path.join(cwd, "结果.pdf"), "%PDF-updated");
  expect(await store.list("task-a", cwd)).toMatchObject([{ status: "changed" }]);
  await store.update("task-a", cwd, "remove", "结果.pdf");
  expect(await store.list("task-a", cwd)).toEqual([]);
  await store.update("task-a", cwd, "add", "结果.pdf");
  await unlink(path.join(cwd, "结果.pdf"));
  expect(await store.list("task-a", cwd)).toMatchObject([{ status: "missing" }]);
});
test("rejects directories, traversal and symlinks that leave the workspace", async () => {
  const { root, cwd, store } = await fixture();
  await writeFile(path.join(root, "private.txt"), "private");
  await symlink(path.join(root, "private.txt"), path.join(cwd, "linked.txt"));
  await expect(store.update("task", cwd, "add", "../private.txt")).rejects.toThrow("inside");
  await expect(store.update("task", cwd, "add", "linked.txt")).rejects.toThrow("inside");
  await expect(store.update("task", cwd, "add", ".")).rejects.toThrow("regular file");
});
test("concurrent registrations do not overwrite each other", async () => {
  const { root, cwd, store } = await fixture();
  await writeFile(path.join(cwd, "other.doc"), "other");
  await Promise.all([
    store.update("task", cwd, "add", "结果.pdf"),
    new TaskArtifactStore(path.join(root, "home")).update("task", cwd, "add", "other.doc"),
  ]);
  expect(await store.list("task", cwd)).toHaveLength(2);
});

test("collects assistant file links and inline paths, not user references, websites or code examples", () => {
  expect(
    extractArtifactPaths([
      { type: "user_message", text: "[input](input.pdf)" },
      { type: "reasoning", text: "[draft](draft.pdf)" },
      {
        type: "assistant_message",
        text: "[PDF](%E7%BB%93%E6%9E%9C.pdf#page=2) ![image](image.png) [file](<report (final).docx>) [web](https://example.com/x.pdf) [mail](mailto:a@example.com) `data.csv`\n```md\n[example](example.pdf)\n```\n[PDF again](结果.pdf)",
      },
    ]),
  ).toEqual(["结果.pdf", "image.png", "report (final).docx", "data.csv"]);
});

test("automatically discovers existing task files, retries missing files and keeps removed items hidden", async () => {
  const { root, cwd, store } = await fixture();
  await writeFile(path.join(root, "private.pdf"), "private");
  await symlink(path.join(root, "private.pdf"), path.join(cwd, "escape.pdf"));
  const transcript = [
    {
      type: "assistant_message" as const,
      text: "[PDF](结果.pdf) [later](later.docx) [outside](../private.pdf) [escape](escape.pdf) [dir](.)",
    },
  ];
  const first = await store.discover("task-a", cwd, transcript);
  expect(first).toMatchObject([{ path: "结果.pdf", status: "ready" }]);
  expect(await store.discover("task-b", cwd, [])).toEqual([]);
  const again = await store.discover("task-a", cwd, transcript);
  expect(again[0].id).toBe(first[0].id);
  await writeFile(path.join(cwd, "later.docx"), "later");
  expect(await store.discover("task-a", cwd, transcript)).toHaveLength(2);
  await store.update("task-a", cwd, "remove", "结果.pdf");
  const restored = new TaskArtifactStore(path.join(root, "home"));
  expect((await restored.discover("task-a", cwd, transcript)).map((x) => x.path)).toEqual([
    "later.docx",
  ]);
  await restored.update("task-a", cwd, "add", "结果.pdf");
  expect(await restored.discover("task-a", cwd, transcript)).toHaveLength(2);
});

test("collects local file URLs but rejects remote file authorities", () => {
  expect(
    extractArtifactPaths([
      {
        type: "assistant_message",
        text: "[local](file:///repo/a%20b.pdf) [remote](file://remote/a.pdf)",
      },
    ]),
  ).toEqual(["/repo/a b.pdf"]);
});
