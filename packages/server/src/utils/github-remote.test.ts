import { describe, expect, it } from "vitest";

import { parseGitHubRemoteUrl, resolveGitHubRemote } from "./github-remote.js";

function createSshHostnameResolver(hostnameByAlias: Record<string, string | null>) {
  return async (host: string): Promise<string | null> => {
    return hostnameByAlias[host] ?? null;
  };
}

describe("parseGitHubRemoteUrl", () => {
  it.each([
    ["https://github.com/acme/repo.git", { owner: "acme", name: "repo", repo: "acme/repo" }],
    ["http://github.com/acme/repo.git", { owner: "acme", name: "repo", repo: "acme/repo" }],
    ["git@github.com:acme/repo.git", { owner: "acme", name: "repo", repo: "acme/repo" }],
    ["ssh://git@github.com/acme/repo.git", { owner: "acme", name: "repo", repo: "acme/repo" }],
    ["ssh://git@ssh.github.com/acme/repo.git", { owner: "acme", name: "repo", repo: "acme/repo" }],
  ])("parses direct GitHub remotes: %s", (remoteUrl, expected) => {
    expect(parseGitHubRemoteUrl(remoteUrl)).toEqual(expected);
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGitHubRemoteUrl("git@gitlab.com:acme/repo.git")).toBeNull();
  });

  it("returns null for SSH aliases before hostname resolution", () => {
    expect(parseGitHubRemoteUrl("git@github-work:acme/repo.git")).toBeNull();
  });
});

describe("resolveGitHubRemote", () => {
  it("resolves an SSH alias that maps to github.com", async () => {
    await expect(
      resolveGitHubRemote({
        remoteUrl: "git@github-work:acme/repo.git",
        resolveSshHostname: createSshHostnameResolver({ "github-work": "github.com" }),
      }),
    ).resolves.toEqual({ owner: "acme", name: "repo", repo: "acme/repo" });
  });

  it("resolves a dotted SSH alias that maps to github.com", async () => {
    await expect(
      resolveGitHubRemote({
        remoteUrl: "git@mindnexus.github.com:JakubMindNexus/postline.git",
        resolveSshHostname: createSshHostnameResolver({
          "mindnexus.github.com": "github.com",
        }),
      }),
    ).resolves.toEqual({
      owner: "JakubMindNexus",
      name: "postline",
      repo: "JakubMindNexus/postline",
    });
  });

  it("resolves an SSH alias that maps to ssh.github.com", async () => {
    await expect(
      resolveGitHubRemote({
        remoteUrl: "ssh://git@github-work/acme/repo.git",
        resolveSshHostname: createSshHostnameResolver({ "github-work": "ssh.github.com" }),
      }),
    ).resolves.toEqual({ owner: "acme", name: "repo", repo: "acme/repo" });
  });

  it("returns null when an SSH alias resolves to a non-GitHub host", async () => {
    await expect(
      resolveGitHubRemote({
        remoteUrl: "git@github-work:acme/repo.git",
        resolveSshHostname: createSshHostnameResolver({ "github-work": "gitlab.com" }),
      }),
    ).resolves.toBeNull();
  });

  it("does not use SSH hostname resolution for HTTPS remotes", async () => {
    let resolverCalls = 0;

    await expect(
      resolveGitHubRemote({
        remoteUrl: "https://github.com/acme/repo.git",
        resolveSshHostname: async () => {
          resolverCalls += 1;
          return "github.com";
        },
      }),
    ).resolves.toEqual({ owner: "acme", name: "repo", repo: "acme/repo" });

    expect(resolverCalls).toBe(0);
  });

  it.each([
    "git@-oProxyCommand=evil:acme/repo.git",
    "ssh://git@-oProxyCommand=evil/acme/repo.git",
    "git@host with space:acme/repo.git",
  ])("rejects malformed hostnames without invoking the SSH resolver: %s", async (remoteUrl) => {
    let resolverCalls = 0;

    await expect(
      resolveGitHubRemote({
        remoteUrl,
        resolveSshHostname: async (host) => {
          resolverCalls += 1;
          return host;
        },
      }),
    ).resolves.toBeNull();

    expect(resolverCalls).toBe(0);
  });
});
