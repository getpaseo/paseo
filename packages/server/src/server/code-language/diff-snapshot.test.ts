import { afterEach, expect, test } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { captureLanguageDiffs, identifyLanguageDiffs } from "./diff-snapshot.js";
import { contentIdentity } from "./content.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function file(): ParsedDiffFile {
  return {
    path: "renamed.ts",
    oldPath: "old.ts",
    additions: 1,
    deletions: 1,
    isNew: false,
    isDeleted: false,
    hunks: [],
  };
}
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-language-diff-"));
  roots.push(cwd);
  await writeFile(join(cwd, "renamed.ts"), "const a = 1;\n");
  return cwd;
}
test("identifies stable current files, including renames", async () => {
  const cwd = await fixture();
  const files = [file()];
  const before = await captureLanguageDiffs(cwd, files);
  await identifyLanguageDiffs({ cwd, files, before, readTarget: null });
  expect(files[0]?.targetContentId).toBe(contentIdentity("const a = 1;\n"));
});
test("omits files changed during diff generation and HEAD mismatches", async () => {
  const cwd = await fixture();
  const files = [file()];
  const before = await captureLanguageDiffs(cwd, files);
  await writeFile(join(cwd, "renamed.ts"), "const a = 2;\n");
  await identifyLanguageDiffs({ cwd, files, before, readTarget: null });
  expect(files[0]?.targetContentId).toBeUndefined();
  const current = await captureLanguageDiffs(cwd, files);
  await identifyLanguageDiffs({
    cwd,
    files,
    before: current,
    readTarget: async () => "const a = 1;\n",
  });
  expect(files[0]?.targetContentId).toBeUndefined();
  await identifyLanguageDiffs({
    cwd,
    files,
    before: current,
    readTarget: async () => "const a = 2;\n",
  });
  expect(files[0]?.targetContentId).toBeDefined();
});
test("normalizes BOM and line separators without changing Unicode columns", () => {
  expect(contentIdentity("\uFEFFconst a = '😀';\r\n")).toBe(contentIdentity("const a = '😀';\n"));
});

test("rejects transformed patch text even when the file stayed stable", async () => {
  const cwd = await fixture();
  const entry = file();
  entry.hunks = [
    {
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 1,
      lines: [{ type: "add", content: "const    a = 1;" }],
    },
  ];
  const files = [entry];
  const before = await captureLanguageDiffs(cwd, files);
  await identifyLanguageDiffs({ cwd, files, before, readTarget: null });
  expect(entry.targetContentId).toBeUndefined();
});
