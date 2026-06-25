import { describe, expect, it } from "vitest";
import { type DiffTarget, diffTargetKey } from "./diff-target";

describe("diffTargetKey", () => {
  it("produces the same key for identical working targets", () => {
    const a: DiffTarget = { kind: "working", mode: "uncommitted" };
    const b: DiffTarget = { kind: "working", mode: "uncommitted" };
    expect(diffTargetKey(a)).toBe(diffTargetKey(b));
  });

  it("produces the same key for identical commit targets", () => {
    const a: DiffTarget = { kind: "commit", sha: "abc123" };
    const b: DiffTarget = { kind: "commit", sha: "abc123" };
    expect(diffTargetKey(a)).toBe(diffTargetKey(b));
  });

  it("distinguishes a working target from a commit target", () => {
    const working: DiffTarget = { kind: "working", mode: "uncommitted" };
    const commit: DiffTarget = { kind: "commit", sha: "abc123" };
    expect(diffTargetKey(working)).not.toBe(diffTargetKey(commit));
  });

  it("distinguishes commits by sha", () => {
    expect(diffTargetKey({ kind: "commit", sha: "abc123" })).not.toBe(
      diffTargetKey({ kind: "commit", sha: "def456" }),
    );
  });

  it("distinguishes working targets by mode", () => {
    expect(diffTargetKey({ kind: "working", mode: "uncommitted" })).not.toBe(
      diffTargetKey({ kind: "working", mode: "base" }),
    );
  });

  it("distinguishes working base targets by baseRef", () => {
    expect(diffTargetKey({ kind: "working", mode: "base", baseRef: "main" })).not.toBe(
      diffTargetKey({ kind: "working", mode: "base", baseRef: "develop" }),
    );
  });

  it("treats a missing baseRef the same as null", () => {
    expect(diffTargetKey({ kind: "working", mode: "base" })).toBe(
      diffTargetKey({ kind: "working", mode: "base", baseRef: null }),
    );
  });

  it("ignores ignoreWhitespace so it does not split the working tab", () => {
    expect(diffTargetKey({ kind: "working", mode: "uncommitted", ignoreWhitespace: true })).toBe(
      diffTargetKey({ kind: "working", mode: "uncommitted", ignoreWhitespace: false }),
    );
  });
});
