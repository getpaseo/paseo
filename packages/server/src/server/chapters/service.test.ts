import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChapterOutline, ParsedDiffFile } from "@getpaseo/protocol/messages";
import { ChaptersService } from "./service.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const outline: ChapterOutline = {
  chapters: [
    {
      id: "behavior",
      title: "Introduce behavior",
      description: "Adds the behavior and its test.",
      sections: [{ fileIndex: 0, hunkIndex: 0, startLine: 0, endLine: 1 }],
    },
  ],
  categories: [],
};
function files(content = "first"): ParsedDiffFile[] {
  return [
    {
      path: "feature.ts",
      isNew: true,
      isDeleted: false,
      additions: 1,
      deletions: 0,
      hunks: [
        { oldStart: 0, newStart: 1, oldCount: 0, newCount: 1, lines: [{ type: "add", content }] },
      ],
    },
  ];
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "paseo-chapters-"));
  directories.push(directory);
  const read = vi.fn(async () => ({ files: files(), tooLarge: false }));
  const generate = vi.fn(async (_cwd: string, path: string) => {
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    expect(snapshot[0]).toMatchObject({ fileIndex: 0, path: "feature.ts" });
    expect(snapshot[0].hunks[0]).toMatchObject({
      hunkIndex: 0,
      lines: [{ lineIndex: 0, type: "add", content: "first" }],
    });
    return outline;
  });
  const options = { directory, read, generate };
  const service = new ChaptersService(options);
  const input = {
    cwd: "/workspace",
    comparison: { mode: "uncommitted" as const },
    generate: true,
    regenerate: false,
  };
  async function settled(instance = service) {
    await vi.waitFor(async () => expect((await instance.get(input)).status).not.toBe("generating"));
    return instance.get(input);
  }
  return { service, options, input, read, generate, settled };
}
it("deduplicates generation and restores the completed snapshot after reconnect and restart", async () => {
  const { service, input, options, generate, settled } = await setup();
  const [first, second] = await Promise.all([service.get(input), service.get(input)]);
  expect(first.status).toBe("generating");
  expect(second.status).toBe("generating");
  const completed = await settled();
  expect(completed.story?.outline).toEqual(outline);
  expect(generate).toHaveBeenCalledTimes(1);
  expect((await new ChaptersService(options).get(input)).story).toEqual(completed.story);
  expect(generate).toHaveBeenCalledTimes(1);
});
it("keeps the old story until explicit regeneration and retains it when generation fails", async () => {
  const { service, input, read, generate, settled } = await setup();
  await service.get(input);
  const completed = await settled();
  read.mockResolvedValue({ files: files("second"), tooLarge: false });
  const stale = await service.get(input);
  expect(stale.story).toEqual(completed.story);
  expect(stale.currentFingerprint).not.toBe(stale.story?.fingerprint);
  expect(generate).toHaveBeenCalledTimes(1);
  generate.mockRejectedValue(new Error("Provider unavailable"));
  await service.get({ ...input, regenerate: true });
  const failed = await settled();
  expect(failed.status).toBe("error");
  expect(failed.error).toBe("Provider unavailable");
  expect(failed.story).toEqual(completed.story);
  await service.get(input);
  expect(generate).toHaveBeenCalledTimes(2);
});
it("does not generate incomplete or empty diffs", async () => {
  const { service, input, read, generate } = await setup();
  read.mockResolvedValue({ files: [], tooLarge: true });
  expect((await service.get(input)).status).toBe("unsupported");
  read.mockResolvedValue({ files: [], tooLarge: false });
  expect((await service.get(input)).status).toBe("empty");
  expect(generate).not.toHaveBeenCalled();
});
it("pins changes arriving during generation to their original snapshot", async () => {
  const { service, input, read, generate, settled } = await setup();
  let finish: (value: ChapterOutline) => void = () => {
    throw new Error("not started");
  };
  generate.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await service.get(input);
  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  read.mockResolvedValue({ files: files("second"), tooLarge: false });
  finish(outline);
  const result = await settled();
  expect(result.story?.files).toEqual(files());
  expect(result.story?.fingerprint).not.toBe(result.currentFingerprint);
});
it("rejects missing coverage instead of publishing a partial story", async () => {
  const { service, input, generate, settled } = await setup();
  generate.mockResolvedValue({ chapters: [], categories: [] });
  await service.get(input);
  const result = await settled();
  expect(result.status).toBe("error");
  expect(result.story).toBeNull();
  expect(result.error).toContain("changes have no chapter");
});
