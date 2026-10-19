import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { Buffer } from "buffer";
import { hash } from "fast-sha256";
import { z } from "zod";

export const ViewedFileRevisionsSchema = z.record(z.string(), z.string());
export type ViewedFileRevisions = z.infer<typeof ViewedFileRevisionsSchema>;

export type ViewedFileUpdate =
  | { kind: "toggle"; file: ParsedDiffFile }
  | { kind: "invalidate"; revisions: ViewedFileRevisions };

export function compactViewedFileRevisions(revisions: ViewedFileRevisions): ViewedFileRevisions {
  const legacyEntries = Object.entries(revisions).filter(
    ([, revision]) => !/^[a-f0-9]{64}$/.test(revision),
  );
  if (legacyEntries.length === 0) return revisions;
  const next = { ...revisions };
  for (const [path, revision] of legacyEntries) next[path] = hashRevision(revision);
  return next;
}

export function updateViewedFileRevisions(
  revisions: ViewedFileRevisions,
  update: ViewedFileUpdate,
): ViewedFileRevisions {
  const next = { ...revisions };
  if (update.kind === "invalidate") {
    for (const [path, revision] of Object.entries(update.revisions)) {
      if (next[path] === revision) delete next[path];
    }
    return next;
  }
  const revision = viewedFileRevision(update.file);
  if (next[update.file.path] === revision) delete next[update.file.path];
  else return { ...next, [update.file.path]: revision };
  return next;
}

export function viewedFileRevision(file: ParsedDiffFile): string {
  return hashRevision(JSON.stringify(file));
}

function hashRevision(revision: string): string {
  const bytes = Buffer.from(revision, "utf8");
  const digest = hash(bytes);
  return Buffer.from(digest).toString("hex");
}

export function restoreViewedFiles(
  revisions: Readonly<Record<string, string>>,
  files: readonly ParsedDiffFile[],
): Map<string, ParsedDiffFile> {
  const viewedFiles = new Map<string, ParsedDiffFile>();
  for (const file of files) {
    const revision = revisions[file.path];
    if (revision !== undefined && revision === viewedFileRevision(file)) {
      viewedFiles.set(file.path, file);
    }
  }
  return viewedFiles;
}
