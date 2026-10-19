import { createHash } from "node:crypto";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  compactViewedFileRevisions,
  restoreViewedFiles,
  updateViewedFileRevisions,
  viewedFileRevision,
} from "./viewed-files";

const file: ParsedDiffFile = {
  path: "src/a.ts",
  status: "ok",
  isNew: false,
  isDeleted: false,
  additions: 1,
  deletions: 0,
  hunks: [
    {
      oldStart: 1,
      oldCount: 0,
      newStart: 1,
      newCount: 1,
      lines: [{ type: "add", content: "const a = 1;" }],
    },
  ],
};

describe("viewed file revisions", () => {
  it("stores a fixed-size SHA-256 fingerprint for a large Unicode diff", () => {
    const large = structuredClone(file);
    large.hunks[0].lines[0].content = "const label = 'été 👋';".repeat(10_000);
    const serialized = JSON.stringify(large);
    const revision = viewedFileRevision(large);

    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    expect(revision).toBe(createHash("sha256").update(serialized, "utf8").digest("hex"));
    expect(JSON.stringify({ [large.path]: revision }).length).toBeLessThan(100);
    expect(viewedFileRevision(structuredClone(large))).toBe(revision);
    large.hunks[0].lines[0].content += "changed";
    expect(viewedFileRevision(large)).not.toBe(revision);
  });

  it("converts legacy JSON revisions without changing current fingerprints", () => {
    const other = { ...file, path: "src/b.ts" };
    const current = viewedFileRevision(other);
    const compact = compactViewedFileRevisions({
      [file.path]: JSON.stringify(file),
      [other.path]: current,
    });

    expect(compact).toEqual({ [file.path]: viewedFileRevision(file), [other.path]: current });
    expect(restoreViewedFiles(compact, [file, other]).size).toBe(2);
    expect(compactViewedFileRevisions(compact)).toBe(compact);
  });

  it("restores the current file object only for an unchanged revision", () => {
    const revisions = updateViewedFileRevisions({}, { kind: "toggle", file });
    const unchanged = structuredClone(file);
    const changed = { ...file, additions: 2 };

    expect(restoreViewedFiles(revisions, [unchanged])).toEqual(new Map([[file.path, unchanged]]));
    expect(restoreViewedFiles(revisions, [changed])).toEqual(new Map());
    expect(restoreViewedFiles(revisions, [])).toEqual(new Map());
  });

  it("toggles a revision without changing another viewed file", () => {
    const other = { ...file, path: "src/b.ts" };
    const revisions = updateViewedFileRevisions({}, { kind: "toggle", file: other });
    const viewed = updateViewedFileRevisions(revisions, { kind: "toggle", file });

    expect(updateViewedFileRevisions(viewed, { kind: "toggle", file })).toEqual(revisions);
    expect(revisions).toEqual({ [other.path]: viewedFileRevision(other) });
  });

  it("does not invalidate a newer revision saved after a diff changed", () => {
    const oldRevision = { [file.path]: viewedFileRevision(file) };
    const changed = { ...file, additions: 2 };
    const current = updateViewedFileRevisions(oldRevision, { kind: "toggle", file: changed });

    expect(
      updateViewedFileRevisions(current, { kind: "invalidate", revisions: oldRevision }),
    ).toEqual(current);
    expect(
      updateViewedFileRevisions(oldRevision, { kind: "invalidate", revisions: oldRevision }),
    ).toEqual({});
  });
});
