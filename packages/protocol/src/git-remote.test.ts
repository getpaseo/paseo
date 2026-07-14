import { describe, expect, it } from "vitest";
import { isCompleteGitRemote, parseGitRemoteLocation } from "./git-remote.js";

describe("isCompleteGitRemote", () => {
  it("treats supported URLs and scp-like addresses as complete remotes", () => {
    expect(isCompleteGitRemote("https://github.com/owner/repo")).toBe(true);
    expect(isCompleteGitRemote("http://internal/owner/repo.git")).toBe(true);
    expect(isCompleteGitRemote("ssh://git@github.com/owner/repo")).toBe(true);
    expect(isCompleteGitRemote("git@github.com:owner/repo.git")).toBe(true);
    expect(isCompleteGitRemote("  https://github.com/owner/repo  ")).toBe(true);
  });

  it("treats owner/repo shorthand as incomplete (needs a clone protocol)", () => {
    expect(isCompleteGitRemote("owner/repo")).toBe(false);
    expect(isCompleteGitRemote("owner/repo.git")).toBe(false);
    expect(isCompleteGitRemote("")).toBe(false);
  });

  it("rejects schemes the daemon's parser does not accept, so clients agree with the server", () => {
    // The old client-side regex matched any `scheme://`, classifying these as
    // complete URLs while the daemon (parseGitRemoteLocation) rejected them —
    // producing a confusing "use owner/repo format" error. The shared helper
    // must classify them identically to the daemon.
    for (const repo of ["git://github.com/owner/repo", "ftp://host/repo", "file:///tmp/repo"]) {
      expect(isCompleteGitRemote(repo)).toBe(false);
      expect(parseGitRemoteLocation(repo)).toBeNull();
    }
  });
});
