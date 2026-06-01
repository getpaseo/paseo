import { describe, expect, it } from "vitest";
import { shortenPath, shortenPathTail } from "./shorten-path";

describe("shortenPath", () => {
  it("returns an empty string for null", () => {
    expect(shortenPath(null)).toBe("");
  });

  it("returns an empty string for undefined", () => {
    expect(shortenPath(undefined)).toBe("");
  });

  it("replaces /Users/<name> with ~", () => {
    expect(shortenPath("/Users/alice/code/paseo")).toBe("~/code/paseo");
  });

  it("replaces /home/<name> with ~", () => {
    expect(shortenPath("/home/alice/code/paseo")).toBe("~/code/paseo");
  });

  it("leaves non-home prefixes alone", () => {
    expect(shortenPath("/var/log/system.log")).toBe("/var/log/system.log");
  });

  it("collapses an exact home root to ~", () => {
    expect(shortenPath("/Users/alice")).toBe("~");
  });
});

describe("shortenPathTail", () => {
  it("returns empty for null", () => {
    expect(shortenPathTail(null, 20)).toBe("");
  });

  it("returns empty for undefined", () => {
    expect(shortenPathTail(undefined, 20)).toBe("");
  });

  it("returns the home-shortened path when within budget", () => {
    expect(shortenPathTail("/Users/alice/code/paseo", 20)).toBe("~/code/paseo");
  });

  it("snaps the cut to the next '/' so segments stay whole", () => {
    // shortenPath → "~/code/foo_wt/foo/zhaoshe/av_duplex_state" (41 chars).
    // budget 26, keep 25, raw cut at index 16 lands inside "foo"; the snap
    // pushes it to the next '/' at index 17 → "/zhaoshe/av_duplex_state".
    const result = shortenPathTail("/Users/alice/code/foo_wt/foo/zhaoshe/av_duplex_state", 26);
    expect(result).toBe("…/zhaoshe/av_duplex_state");
    expect(result.length).toBeLessThanOrEqual(26);
  });

  it("falls back to a raw character slice when the tail has no separator", () => {
    // shortenPath leaves "/this-is-a-very-long-trailing-segment" untouched.
    // budget 10, keep 9 → the last 9 chars; no '/' after rawStart so we just
    // take the raw tail.
    expect(shortenPathTail("/this-is-a-very-long-trailing-segment", 10)).toBe("…g-segment");
  });

  it("never exceeds maxChars when maxChars >= 2", () => {
    const longPath = "/Users/alice/code/foo_wt/foo/zhaoshe/av_duplex_state";
    for (const budget of [2, 5, 10, 26, 50, 200]) {
      expect(shortenPathTail(longPath, budget).length).toBeLessThanOrEqual(budget);
    }
  });

  it("produces a 2-char result when maxChars is 1", () => {
    // Documented corner: keep = max(maxChars - 1, 1) = 1, plus the leading '…'.
    expect(shortenPathTail("/x/yyy", 1)).toBe("…y");
  });

  it("leaves short paths untouched", () => {
    expect(shortenPathTail("/a", 50)).toBe("/a");
    expect(shortenPathTail("/Users/x", 50)).toBe("~");
  });

  it("ignores a trailing '/' so we don't end up with a bare ellipsis-slash", () => {
    // A trailing '/' at the very end shouldn't pull the snap point past every
    // meaningful character. The guard `slashStart < short.length - 1` keeps the
    // last segment in view.
    const result = shortenPathTail("/Users/alice/code/very-long-project-name/", 20);
    expect(result.startsWith("…")).toBe(true);
    expect(result.endsWith("/")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).not.toBe("…/");
  });
});
