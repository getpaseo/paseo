import { hostname } from "node:os";
import { describe, expect, test } from "vitest";
import { resolveWorktreeRepositoryIdentity } from "./repository-identity.js";

describe("resolveWorktreeRepositoryIdentity", () => {
  test("uses an explicit daemon project without consulting the caller cwd", () => {
    const identity = resolveWorktreeRepositoryIdentity(
      { project: "prj_remote" },
      { getLastServerInfoMessage: () => null, isLocalDaemonConnection: () => false },
    );

    expect(identity).toEqual({ projectId: "prj_remote" });
  });

  test("requires explicit identity for a remote daemon", () => {
    expect(() => {
      resolveWorktreeRepositoryIdentity(
        {},
        {
          getLastServerInfoMessage: () => ({ hostname: "other-host" }),
          isLocalDaemonConnection: () => false,
        },
      );
    }).toThrow(expect.objectContaining({ code: "REPOSITORY_IDENTITY_REQUIRED" }));
  });

  test("does not infer the caller cwd for a remote connection with the same hostname", () => {
    expect(() => {
      resolveWorktreeRepositoryIdentity(
        { host: "remote.example" },
        {
          getLastServerInfoMessage: () => ({ hostname: hostname() }),
          isLocalDaemonConnection: () => false,
        },
      );
    }).toThrow(expect.objectContaining({ code: "REPOSITORY_IDENTITY_REQUIRED" }));
  });

  test("does not infer the caller cwd for an empty host option that falls back to remote", () => {
    expect(() => {
      resolveWorktreeRepositoryIdentity(
        { host: "" },
        {
          getLastServerInfoMessage: () => ({ hostname: hostname() }),
          isLocalDaemonConnection: () => false,
        },
      );
    }).toThrow(expect.objectContaining({ code: "REPOSITORY_IDENTITY_REQUIRED" }));
  });

  test("defaults to the local cwd only after local connection and same-host proof", () => {
    const identity = resolveWorktreeRepositoryIdentity(
      {},
      {
        getLastServerInfoMessage: () => ({ hostname: hostname() }),
        isLocalDaemonConnection: () => true,
      },
    );

    expect(identity).toEqual({ repoRoot: process.cwd() });
  });

  test("rejects conflicting identity flags", () => {
    expect(() => {
      resolveWorktreeRepositoryIdentity(
        { project: "prj_remote", repoRoot: "/srv/repo" },
        { getLastServerInfoMessage: () => null, isLocalDaemonConnection: () => false },
      );
    }).toThrow(expect.objectContaining({ code: "AMBIGUOUS_REPOSITORY_IDENTITY" }));
  });
});
