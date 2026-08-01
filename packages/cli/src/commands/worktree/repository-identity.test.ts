import { hostname } from "node:os";
import { describe, expect, test } from "vitest";
import { resolveWorktreeRepositoryIdentity } from "./repository-identity.js";

describe("resolveWorktreeRepositoryIdentity", () => {
  test("uses an explicit daemon project without consulting the caller cwd", () => {
    const identity = resolveWorktreeRepositoryIdentity(
      { project: "prj_remote" },
      { getLastServerInfoMessage: () => null },
    );

    expect(identity).toEqual({ projectId: "prj_remote" });
  });

  test("requires explicit identity for a remote daemon", () => {
    expect(() => {
      resolveWorktreeRepositoryIdentity(
        {},
        { getLastServerInfoMessage: () => ({ hostname: "other-host" }) },
      );
    }).toThrow(expect.objectContaining({ code: "REPOSITORY_IDENTITY_REQUIRED" }));
  });

  test("does not infer the caller cwd for an explicit remote host with the same hostname", () => {
    expect(() => {
      resolveWorktreeRepositoryIdentity(
        { host: "remote.example" },
        { getLastServerInfoMessage: () => ({ hostname: hostname() }) },
      );
    }).toThrow(expect.objectContaining({ code: "REPOSITORY_IDENTITY_REQUIRED" }));
  });

  test("does not infer the caller cwd for PASEO_HOST with the same hostname", () => {
    expect(() => {
      resolveWorktreeRepositoryIdentity(
        {},
        { getLastServerInfoMessage: () => ({ hostname: hostname() }) },
        { PASEO_HOST: "remote.example" },
      );
    }).toThrow(expect.objectContaining({ code: "REPOSITORY_IDENTITY_REQUIRED" }));
  });

  test("defaults to the local cwd only after same-host proof", () => {
    const identity = resolveWorktreeRepositoryIdentity(
      {},
      { getLastServerInfoMessage: () => ({ hostname: hostname() }) },
    );

    expect(identity).toEqual({ repoRoot: process.cwd() });
  });

  test("rejects conflicting identity flags", () => {
    expect(() => {
      resolveWorktreeRepositoryIdentity(
        { project: "prj_remote", repoRoot: "/srv/repo" },
        { getLastServerInfoMessage: () => null },
      );
    }).toThrow(expect.objectContaining({ code: "AMBIGUOUS_REPOSITORY_IDENTITY" }));
  });
});
