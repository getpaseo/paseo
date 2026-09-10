import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readGitFileContents } from "@server/utils/git-file-contents.js";
import { runGitCommand, runGitCommandBytes } from "@server/utils/run-git-command.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "git-contents-"));
  execFileSync("git", ["init", "-q"], { cwd });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

test("batch byte framing survives Unicode, invalid UTF-8, and missing objects", async () => {
  const text = Buffer.concat([Buffer.from("中文👩‍💻\n"), Buffer.from([0xff]), Buffer.from("\n")]);
  const { stdout: oid } = await runGitCommand(["hash-object", "-w", "--stdin"], {
    cwd,
    input: text,
  });
  const ref = oid.trim();
  const empty = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd, input: "" })
    .toString()
    .trim();
  const contents = await readGitFileContents(cwd, [ref, "HEAD:missing", empty, ref]);
  expect(contents).toEqual(
    new Map([
      [ref, text.toString("utf8")],
      ["HEAD:missing", null],
      [empty, ""],
    ]),
  );
  const raw = await runGitCommandBytes(["cat-file", "blob", ref], { cwd });
  expect(raw.stdout.equals(text)).toBe(true);
});

test("oversized output stays bounded and requests the existing per-file path", async () => {
  writeFileSync(join(cwd, "big"), Buffer.alloc(20 * 1024 * 1024, 97));
  const oid = execFileSync("git", ["hash-object", "-w", "big"], { cwd }).toString().trim();
  expect(await readGitFileContents(cwd, [oid])).toBeNull();
  const limited = await runGitCommandBytes(["cat-file", "--batch"], {
    cwd,
    input: oid + "\n",
    maxOutputBytes: 100,
  });
  expect(limited.truncated).toBe(true);
  expect(limited.stdout.length).toBe(100);
});

test("newline paths do not become extra batch requests", async () => {
  expect(await readGitFileContents(cwd, ["HEAD:with\nnewline"])).toBeNull();
});
