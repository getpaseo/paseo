import { replaceEqualDeep } from "@tanstack/react-query";
import type { ParsedDiffFile, SubscribeCheckoutDiffResponse } from "@getpaseo/protocol/messages";

type DiffPayload = Omit<SubscribeCheckoutDiffResponse["payload"], "subscriptionId">;

/** File identity owns text-model reuse. Never reconstruct the hunk/token graph. */
export function retainDiffFiles(
  previous: ParsedDiffFile[],
  incoming: ParsedDiffFile[],
): ParsedDiffFile[] {
  if (previous === incoming) return previous;
  const byPath = new Map(previous.map((file) => [file.path, file]));
  let unchanged = previous.length === incoming.length;
  const files = incoming.map((file, index) => {
    const old = byPath.get(file.path);
    const retained = old && equalFile(old, file) ? old : file;
    unchanged &&= retained === previous[index];
    return retained;
  });
  return unchanged ? previous : files;
}

export function shareCheckoutDiff(previous: unknown, incoming: unknown): DiffPayload {
  const next = incoming as DiffPayload;
  const old = previous as DiffPayload | undefined;
  if (!old || old === next) return next;
  const files = retainDiffFiles(old.files, next.files);
  const error = replaceEqualDeep(old.error, next.error);
  return files === old.files &&
    error === old.error &&
    old.cwd === next.cwd &&
    old.requestId === next.requestId &&
    old.diffTooLarge === next.diffTooLarge
    ? old
    : { ...next, files, error };
}

export function shareCommitFileDiff(
  previous: unknown,
  incoming: unknown,
): { file: ParsedDiffFile | null } {
  const next = incoming as { file: ParsedDiffFile | null };
  const old = previous as typeof next | undefined;
  return old &&
    (old.file === next.file || (old.file && next.file && equalFile(old.file, next.file)))
    ? old
    : next;
}

function equalFile(left: ParsedDiffFile, right: ParsedDiffFile): boolean {
  if (left === right) return true;
  if (
    left.path !== right.path ||
    left.oldPath !== right.oldPath ||
    left.status !== right.status ||
    left.isNew !== right.isNew ||
    left.isDeleted !== right.isDeleted ||
    left.additions !== right.additions ||
    left.deletions !== right.deletions ||
    left.hunks.length !== right.hunks.length
  )
    return false;
  for (let h = 0; h < left.hunks.length; h++) {
    const a = left.hunks[h]!;
    const b = right.hunks[h]!;
    if (a === b) continue;
    if (
      a.oldStart !== b.oldStart ||
      a.oldCount !== b.oldCount ||
      a.newStart !== b.newStart ||
      a.newCount !== b.newCount ||
      a.lines.length !== b.lines.length
    )
      return false;
    if (!equalLines(a.lines, b.lines)) return false;
  }
  return true;
}

function equalLines(
  left: ParsedDiffFile["hunks"][number]["lines"],
  right: ParsedDiffFile["hunks"][number]["lines"],
): boolean {
  for (let l = 0; l < left.length; l++) {
    const x = left[l]!;
    const y = right[l]!;
    if (x === y) continue;
    if (x.type !== y.type || x.content !== y.content) return false;
    if (x.tokens === y.tokens) continue;
    if (!x.tokens || !y.tokens || x.tokens.length !== y.tokens.length) return false;
    for (let t = 0; t < x.tokens.length; t++) {
      const p = x.tokens[t]!;
      const q = y.tokens[t]!;
      if (p.text !== q.text || p.style !== q.style) return false;
    }
  }
  return true;
}
