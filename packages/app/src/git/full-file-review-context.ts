import { useMemo } from "react";
import { create } from "zustand";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { diffFileSignature } from "./full-file-diff";

interface FullFileReviewContextEntry {
  sourceSignature: string;
  fullFile: ParsedDiffFile;
}

interface FullFileReviewContextState {
  byCwd: Record<string, Record<string, FullFileReviewContextEntry>>;
  publish: (input: { cwd: string; source: ParsedDiffFile; fullFile: ParsedDiffFile }) => void;
}

const EMPTY_ENTRIES: Record<string, FullFileReviewContextEntry> = {};

/**
 * Full-file expansions the user has viewed, per checkout. Review comments resolve their
 * context from diff hunks, so a comment on an unchanged line only has context while the
 * expansion is known. Every host of the same checkout reads this one registry, which keeps
 * the published review attachment identical whichever panel publishes last. Not persisted:
 * the expansion is rebuilt the next time the file is viewed in full.
 */
const useFullFileReviewContextStore = create<FullFileReviewContextState>()((set) => ({
  byCwd: {},
  publish: ({ cwd, source, fullFile }) =>
    set((state) => {
      const current = state.byCwd[cwd]?.[source.path];
      if (current?.fullFile === fullFile) return state;
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            ...state.byCwd[cwd],
            [source.path]: { sourceSignature: diffFileSignature(source), fullFile },
          },
        },
      };
    }),
}));

export function usePublishFullFileReviewContext() {
  return useFullFileReviewContextStore((state) => state.publish);
}

/** Swaps in viewed full-file expansions whose source diff is still current. */
export function useReviewContextFiles(cwd: string, files: ParsedDiffFile[]): ParsedDiffFile[] {
  const entries = useFullFileReviewContextStore((state) => state.byCwd[cwd] ?? EMPTY_ENTRIES);
  return useMemo(() => {
    if (entries === EMPTY_ENTRIES) return files;
    let changed = false;
    const next = files.map((file) => {
      const entry = entries[file.path];
      if (!entry || entry.sourceSignature !== diffFileSignature(file)) return file;
      changed = true;
      return entry.fullFile;
    });
    return changed ? next : files;
  }, [entries, files]);
}
