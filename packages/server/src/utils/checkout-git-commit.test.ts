import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { commitChanges } from "./checkout-git.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).replaceAll("\r\n", "\n");
}

function createRepo(files: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), "checkout-git-commit-"));
  tempDirs.push(cwd);
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@example.com"]);
  git(cwd, ["config", "user.name", "Test User"]);
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(cwd, path), content);
  }
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", "commit.gpgsign=false", "commit", "-qm", "initial"]);
  return cwd;
}

function headChanges(cwd: string): string[] {
  return git(cwd, ["show", "--format=", "--name-status", "--find-renames", "HEAD"])
    .trim()
    .split("\n")
    .filter(Boolean);
}

describe("commitChanges", () => {
  it("commits only selected files and preserves unrelated staged changes", async () => {
    const cwd = createRepo({ "selected.txt": "old\n", "unrelated.txt": "old\n" });
    writeFileSync(join(cwd, "selected.txt"), "selected\n");
    writeFileSync(join(cwd, "unrelated.txt"), "unrelated\n");
    git(cwd, ["add", "unrelated.txt"]);

    await commitChanges(cwd, { message: "selected commit", files: ["selected.txt"] });

    expect(headChanges(cwd)).toEqual(["M\tselected.txt"]);
    expect(git(cwd, ["diff", "--cached", "--name-only"]).trim()).toBe("unrelated.txt");
    expect(git(cwd, ["show", "-s", "--format=%s", "HEAD"]).trim()).toBe("selected commit");
  });

  it("rejects an empty selected-file list without creating a commit", async () => {
    const cwd = createRepo({ "file.txt": "old\n" });
    writeFileSync(join(cwd, "file.txt"), "changed\n");
    const before = git(cwd, ["rev-parse", "HEAD"]).trim();

    await expect(commitChanges(cwd, { message: "nothing", files: [] })).rejects.toThrow(
      "At least one file must be selected for commit",
    );

    expect(git(cwd, ["rev-parse", "HEAD"]).trim()).toBe(before);
    expect(git(cwd, ["status", "--short"]).trim()).toBe("M file.txt");
  });

  it("commits selected deletions and renames while excluding unrelated staged changes", async () => {
    const cwd = createRepo({
      "old-name.txt": "rename me\n",
      "deleted.txt": "delete me\n",
      "unrelated.txt": "old\n",
    });
    renameSync(join(cwd, "old-name.txt"), join(cwd, "new-name.txt"));
    unlinkSync(join(cwd, "deleted.txt"));
    writeFileSync(join(cwd, "unrelated.txt"), "staged unrelated\n");
    git(cwd, ["add", "unrelated.txt"]);

    await commitChanges(cwd, {
      message: "rename and delete",
      files: ["old-name.txt", "new-name.txt", "deleted.txt"],
    });

    expect(headChanges(cwd)).toEqual(["D\tdeleted.txt", "R100\told-name.txt\tnew-name.txt"]);
    expect(git(cwd, ["diff", "--cached", "--name-only"]).trim()).toBe("unrelated.txt");
  });

  it("keeps add-all behavior when selected files are omitted", async () => {
    const cwd = createRepo({ "a.txt": "old\n", "b.txt": "old\n" });
    writeFileSync(join(cwd, "a.txt"), "new a\n");
    writeFileSync(join(cwd, "b.txt"), "new b\n");

    await commitChanges(cwd, { message: "all changes", addAll: true });

    expect(headChanges(cwd)).toEqual(["M\ta.txt", "M\tb.txt"]);
    expect(git(cwd, ["status", "--short"])).toBe("");
  });
});
