import { resolve } from "node:path";
import { stat as statFile, readFile } from "node:fs/promises";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { isTypeScriptFile } from "@getpaseo/protocol/code-language";
import { contentIdentity, languageText } from "./content.js";
interface LanguageDiffSnapshot {
  identity: string;
  stamp: string;
}

async function readLanguageDiffSnapshot(
  cwd: string,
  path: string,
): Promise<(LanguageDiffSnapshot & { content: string }) | null> {
  if (!isTypeScriptFile(path)) return null;
  try {
    const absolute = resolve(cwd, path);
    const before = await statFile(absolute, { bigint: true });
    if (!before.isFile() || before.size > 1024n * 1024n) return null;
    const content = await readFile(absolute, "utf8");
    const after = await statFile(absolute, { bigint: true });
    const stamp = `${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
    const endStamp = `${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}`;
    return stamp === endStamp ? { identity: contentIdentity(content), stamp, content } : null;
  } catch {
    return null;
  } // Eligibility is optional when an agent removes a file mid-diff.
}

export async function captureLanguageDiffs(
  cwd: string,
  files: ReadonlyArray<{ path: string }>,
): Promise<Map<string, LanguageDiffSnapshot>> {
  const before = new Map<string, LanguageDiffSnapshot>();
  for (const file of files) {
    const snapshot = await readLanguageDiffSnapshot(cwd, file.path);
    if (snapshot) before.set(file.path, { identity: snapshot.identity, stamp: snapshot.stamp });
  }
  return before;
}
interface IdentifyInput {
  cwd: string;
  files: ParsedDiffFile[];
  before: Map<string, LanguageDiffSnapshot>;
  readTarget: ((path: string) => Promise<string | null>) | null;
}
export async function identifyLanguageDiffs(input: IdentifyInput): Promise<void> {
  for (const file of input.files) {
    const before = input.before.get(file.path);
    if (!before || file.isDeleted || (file.status && file.status !== "ok")) continue;
    const after = await readLanguageDiffSnapshot(input.cwd, file.path);
    if (!after || before.stamp !== after.stamp || before.identity !== after.identity) continue;
    if (!matchesDiffTarget(file, after.content)) continue;
    if (input.readTarget) {
      const target = await input.readTarget(file.path);
      if (target === null || contentIdentity(target) !== after.identity) continue;
    }
    file.targetContentId = after.identity;
  }
}

function matchesDiffTarget(file: ParsedDiffFile, content: string): boolean {
  const lines = languageText(content).split("\n");
  for (const hunk of file.hunks) {
    let lineNumber = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.type !== "context" && line.type !== "add") continue;
      let text = line.content.replace(/\r$/, "");
      if (lineNumber === 1) text = text.replace(/^\uFEFF/, "");
      if (lines[lineNumber - 1] !== text) return false;
      lineNumber++;
    }
  }
  return true;
}
