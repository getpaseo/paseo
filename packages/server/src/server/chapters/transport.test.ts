import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/daemon-test-context.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
let ctx: DaemonTestContext | undefined;
let directory: string | undefined;
afterEach(async () => {
  await ctx?.cleanup();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it("generates through the client, keeps helpers internal, and restores the story on reconnect", async () => {
  directory = await mkdtemp(join(tmpdir(), "chapters-wire-"));
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", [
    "-C",
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "Initial",
  ]);
  await writeFile(join(directory, "feature.ts"), "export const enabled = true;\n");
  ctx = await createDaemonTestContext();
  const manager = ctx.daemon.daemon.agentManager;
  const run = vi.spyOn(manager, "runAgent").mockImplementation(async (id) => ({
    sessionId: id,
    finalText: JSON.stringify({
      chapters: [
        {
          id: "feature",
          title: "Enable the feature",
          description: "The feature is enabled by default.",
          sections: [{ fileIndex: 0, hunkIndex: 0, startLine: 0, endLine: 2 }],
        },
      ],
      categories: [],
    }),
    timeline: [],
  }));
  const input = {
    cwd: directory,
    comparison: { mode: "uncommitted" as const },
    generate: true,
    regenerate: false,
  };
  expect((await ctx.client.getChapters(input)).status).toBe("generating");
  const client = ctx.client;
  await expect
    .poll(async () => (await client.getChapters(input)).status, { timeout: 15000 })
    .toBe("ready");
  const completed = await client.getChapters(input);
  expect(completed.story?.outline.chapters[0].title).toBe("Enable the feature");
  expect(run).toHaveBeenCalledTimes(1);
  expect(manager.listAgents()).toEqual([]);
  let omittedSnapshot = false;
  const unsubscribe = client.subscribeRawMessages((message) => {
    if (message.type === "checkout.chapters.get.response")
      omittedSnapshot = message.payload.state.story === undefined;
  });
  expect(
    (await client.getChapters({ ...input, knownStory: completed.story ?? undefined })).story,
  ).toEqual(completed.story);
  unsubscribe();
  expect(omittedSnapshot).toBe(true);
  expect((await client.getBackgroundActivity()).requests).toMatchObject([
    { title: "Chapters", purpose: "chapters", status: "completed" },
  ]);
  await client.close();
  const reconnected = new DaemonClient({ url: `ws://127.0.0.1:${ctx.daemon.port}/ws` });
  try {
    await reconnected.connect();
    expect((await reconnected.getChapters(input)).story).toEqual(completed.story);
  } finally {
    await reconnected.close();
  }
});
