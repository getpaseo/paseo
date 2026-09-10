import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { productionStat } from "@getpaseo/protocol/diff-stat";
import { runGitCommand } from "../../utils/run-git-command.js";
import { parseNumstat, readComparisonBreakdown } from "./read.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});
async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-change-stats-"));
  roots.push(cwd);
  await runGitCommand(["init", "-b", "main"], { cwd });
  await runGitCommand(["config", "user.email", "test@example.com"], { cwd });
  await runGitCommand(["config", "user.name", "Test"], { cwd });
  return cwd;
}
it("partitions real tracked and untracked changes including deleted source", async () => {
  const cwd = await repository();
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src/a.ts"), "const a = 1; // before\n");
  await writeFile(join(cwd, "README.md"), "before\n");
  await writeFile(join(cwd, "src/deleted.ts"), "// removed comment\nconst gone = 1;\n");
  await runGitCommand(["add", "."], { cwd });
  await runGitCommand(["commit", "-m", "initial"], { cwd });
  await writeFile(join(cwd, "src/a.ts"), "const a = 1; // after\n");
  await writeFile(join(cwd, "README.md"), "after\n");
  await rm(join(cwd, "src/deleted.ts"));
  await writeFile(join(cwd, "src/new.test.ts"), "// a test\nconst test = 1;\n");
  const breakdown = await readComparisonBreakdown({
    cwd,
    baseRef: "HEAD",
    total: { additions: 4, deletions: 4 },
  });
  expect(breakdown.comments).toEqual({ additions: 1, deletions: 2 });
  expect(breakdown.docs).toEqual({ additions: 1, deletions: 1 });
  expect(breakdown.tests).toEqual({ additions: 2, deletions: 0 });
  expect(productionStat(breakdown)).toEqual({ additions: 0, deletions: 1 });
  expect(breakdown.other).toEqual({ additions: 0, deletions: 0 });
  await writeFile(join(cwd, "src/a.ts"), "const a = 2; // after\n");
  const changed = await readComparisonBreakdown({
    cwd,
    baseRef: "HEAD",
    total: { additions: 4, deletions: 4 },
  });
  expect(productionStat(changed)).toEqual({ additions: 1, deletions: 2 });
  expect(changed.comments).toEqual({ additions: 0, deletions: 1 });
});
it("handles renamed paths containing tabs and spaces", async () => {
  const cwd = await repository();
  const oldPath = "old file\tname.ts";
  const path = "new file\tname.ts";
  await writeFile(join(cwd, oldPath), "const a = 1;\nconst b = 2;\nconst c = 3; // before\n");
  await runGitCommand(["add", "."], { cwd });
  await runGitCommand(["commit", "-m", "initial"], { cwd });
  await rename(join(cwd, oldPath), join(cwd, path));
  await writeFile(join(cwd, path), "const a = 1;\nconst b = 2;\nconst c = 3; // after\n");
  await runGitCommand(["add", "."], { cwd });
  const result = await readComparisonBreakdown({
    cwd,
    baseRef: "HEAD",
    total: { additions: 1, deletions: 1 },
  });
  expect(result.comments).toEqual({ additions: 1, deletions: 1 });
});
it("parses NUL-delimited numstat without corrupting paths", () => {
  const files = parseNumstat("1\t2\t\0old\tfile.ts\0new\nfile.ts\0-\t-\timage.png\0");
  expect(files[0]).toMatchObject({
    path: "new\nfile.ts",
    oldPath: "old\tfile.ts",
    additions: 1,
    deletions: 2,
  });
  expect(files[1]).toMatchObject({ path: "image.png", additions: 0, deletions: 0 });
});
