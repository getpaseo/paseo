import { describe, expect, it, vi } from "vitest";

import { createForgeService } from "./forge-registry.js";
import { createForgeResolver, forgeForHost, parseRemoteHost } from "./forge-resolver.js";

function createSshHostnameResolver(hostnameByAlias: Record<string, string | null>) {
  return vi.fn(async (host: string): Promise<string | null> => {
    return hostnameByAlias[host] ?? null;
  });
}

async function resolveSshHostnameAsLiteralHost(host: string): Promise<string | null> {
  return host;
}

describe("parseRemoteHost", () => {
  it("parses ssh and https remotes", () => {
    expect(parseRemoteHost("git@github.com:owner/repo.git")).toBe("github.com");
    expect(parseRemoteHost("git@gitlab.example.com:group/sub/repo.git")).toBe("gitlab.example.com");
    expect(parseRemoteHost("https://GitLab.Example.Com./group/repo.git")).toBe(
      "gitlab.example.com",
    );
    expect(parseRemoteHost("not a url")).toBeNull();
  });
});

describe("forgeForHost", () => {
  it("maps public registered forge hosts without resolver-specific branches", () => {
    expect(forgeForHost("github.com")).toBe("github");
    expect(forgeForHost("gitlab.com")).toBe("gitlab");
    expect(forgeForHost("gitea.com")).toBe("gitea");
    expect(forgeForHost("codeberg.org")).toBe("codeberg");
  });

  it("returns null for hosts with no known adapter", () => {
    expect(forgeForHost("example.com")).toBeNull();
    expect(forgeForHost("bitbucket.org")).toBeNull();
    expect(forgeForHost("gitlab.example.com")).toBeNull();
    expect(forgeForHost("forgejo.example.org")).toBeNull();
    expect(forgeForHost("notgitlab.example.org")).toBeNull();
  });
});

describe("createForgeResolver", () => {
  it("resolves a github.com remote to the github forge", async () => {
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@github.com:owner/repo.git",
    });
    const resolution = await resolver.resolve("/repo");
    expect(resolution).toMatchObject({ forge: "github", host: "github.com" });
    expect(resolution?.service.getCurrentPullRequestStatus).toBeTypeOf("function");
  });

  it("resolves a self-managed GitLab remote through the per-host probe", async () => {
    const probeForge = vi.fn(async () => "gitlab");
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@gitlab.example.com:example-group/example-project.git",
      probeForge,
      resolveSshHostname: resolveSshHostnameAsLiteralHost,
    });
    const resolution = await resolver.resolve("/repo");
    expect(resolution).toMatchObject({ forge: "gitlab", host: "gitlab.example.com" });
    expect(probeForge).toHaveBeenCalledWith("gitlab.example.com");
  });

  it("resolves an SSH alias that maps to github.com", async () => {
    const probeForge = vi.fn(async () => {
      throw new Error("github cloud alias should not probe CLI auth");
    });
    const resolveSshHostname = createSshHostnameResolver({ "github-work": "github.com" });
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@github-work:acme/repo.git",
      probeForge,
      resolveSshHostname,
    });

    await expect(resolver.resolve("/repo")).resolves.toMatchObject({
      forge: "github",
      host: "github.com",
    });
    expect(resolveSshHostname).toHaveBeenCalledWith("github-work");
    expect(probeForge).not.toHaveBeenCalled();
  });

  it("probes the resolved host for an SSH alias to a self-managed forge", async () => {
    const probeForge = vi.fn(async () => "gitlab");
    const resolveSshHostname = createSshHostnameResolver({
      "gitlab-work": "gitlab.example.com",
    });
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@gitlab-work:example-group/example-project.git",
      probeForge,
      resolveSshHostname,
    });

    await expect(resolver.resolve("/repo")).resolves.toMatchObject({
      forge: "gitlab",
      host: "gitlab.example.com",
    });
    expect(probeForge).toHaveBeenCalledWith("gitlab.example.com");
  });

  it("lets the sync resolver reuse an SSH-alias forge discovered by an async resolve", async () => {
    const remoteUrl = "git@github-work:acme/repo.git";
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => remoteUrl,
      probeForge: async () => null,
      resolveSshHostname: createSshHostnameResolver({ "github-work": "github.com" }),
    });

    expect(resolver.resolveFromRemoteUrl(remoteUrl)).toBeNull();
    await resolver.resolve("/repo");
    expect(resolver.resolveFromRemoteUrl(remoteUrl)).toMatchObject({ forge: "github" });
  });

  it("lets the sync resolver reuse an SSH-alias forge discovered through the probe", async () => {
    const remoteUrl = "git@gitlab-work:example-group/example-project.git";
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => remoteUrl,
      probeForge: async () => "gitlab",
      resolveSshHostname: createSshHostnameResolver({ "gitlab-work": "gitlab.example.com" }),
    });

    expect(resolver.resolveFromRemoteUrl(remoteUrl)).toBeNull();
    await resolver.resolve("/repo");
    expect(resolver.resolveFromRemoteUrl(remoteUrl)).toMatchObject({ forge: "gitlab" });
  });

  it("returns null when an SSH alias cannot be resolved to a forge host", async () => {
    const probeForge = vi.fn(async () => null);
    const resolveSshHostname = createSshHostnameResolver({ "github-work": null });
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@github-work:acme/repo.git",
      probeForge,
      resolveSshHostname,
    });

    await expect(resolver.resolve("/repo")).resolves.toBeNull();
  });

  it("does not use SSH hostname resolution for non-SSH remotes", async () => {
    const probeForge = vi.fn(async () => null);
    const resolveSshHostname = createSshHostnameResolver({ "github-work": "github.com" });
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "https://github-work/acme/repo.git",
      probeForge,
      resolveSshHostname,
    });

    await expect(resolver.resolve("/repo")).resolves.toBeNull();
    expect(resolveSshHostname).not.toHaveBeenCalled();
  });

  it("resolves Gitea and Codeberg remotes to their registered top-level forges", async () => {
    const gitea = createForgeResolver({
      resolveRemoteUrl: async () => "https://gitea.com/example/repo.git",
    });
    const codeberg = createForgeResolver({
      resolveRemoteUrl: async () => "git@codeberg.org:example/repo.git",
    });

    await expect(gitea.resolve("/gitea")).resolves.toMatchObject({
      forge: "gitea",
      host: "gitea.com",
    });
    await expect(codeberg.resolve("/codeberg")).resolves.toMatchObject({
      forge: "codeberg",
      host: "codeberg.org",
    });
  });

  it("does not classify an overlapping gitea-forgejo hostname without a probe", async () => {
    const probeForge = vi.fn(async () => null);
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@gitea-forgejo.example.org:example/repo.git",
      probeForge,
      resolveSshHostname: resolveSshHostnameAsLiteralHost,
    });

    await expect(resolver.resolve("/repo")).resolves.toBeNull();
    expect(probeForge).toHaveBeenCalledWith("gitea-forgejo.example.org");
  });

  it("returns null when the cwd has no origin remote", async () => {
    const resolver = createForgeResolver({ resolveRemoteUrl: async () => null });
    expect(await resolver.resolve("/repo")).toBeNull();
  });

  it("degrades to no forge when the host probe throws instead of crashing resolution", async () => {
    const probeForge = vi.fn(async () => {
      throw new Error("registry probe blew up");
    });
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@git.acme.internal:team/repo.git",
      probeForge,
      resolveSshHostname: resolveSshHostnameAsLiteralHost,
    });

    await expect(resolver.resolve("/repo")).resolves.toBeNull();
    expect(probeForge).toHaveBeenCalledWith("git.acme.internal");
  });

  it("reuses one adapter instance per forge across resolutions", async () => {
    let built = 0;
    const probeForge = vi.fn(async () => "gitlab");
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@gitlab.example.com:group/repo.git",
      probeForge,
      resolveSshHostname: resolveSshHostnameAsLiteralHost,
      createService: (forge) => {
        built += 1;
        return createForgeService(forge);
      },
    });
    const first = await resolver.resolve("/a");
    const second = await resolver.resolve("/b");
    expect(built).toBe(1);
    expect(probeForge).toHaveBeenCalledTimes(1);
    expect(first?.service).toBe(second?.service);
  });

  it("memoizes the remote-url resolution per cwd", async () => {
    const resolveRemoteUrl = vi.fn(async () => "git@github.com:owner/repo.git");
    const resolver = createForgeResolver({ resolveRemoteUrl });

    await resolver.resolve("/repo");
    await resolver.resolve("/repo");
    expect(resolveRemoteUrl).toHaveBeenCalledTimes(1);

    await resolver.resolve("/other-repo");
    expect(resolveRemoteUrl).toHaveBeenCalledTimes(2);
  });

  it("re-resolves the remote url for a cwd after invalidate()", async () => {
    const resolveRemoteUrl = vi.fn(async () => "git@github.com:owner/repo.git");
    const resolver = createForgeResolver({ resolveRemoteUrl });

    await resolver.resolve("/repo");
    resolver.invalidate("/repo");
    await resolver.resolve("/repo");

    expect(resolveRemoteUrl).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the cached remote url until the TTL expires", async () => {
    let currentTime = 0;
    let remoteUrl = "git@github.com:owner/repo.git";
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => remoteUrl,
      now: () => currentTime,
    });

    await expect(resolver.resolve("/repo")).resolves.toMatchObject({ forge: "github" });

    // A remote changed outside Paseo (`git remote set-url` from a terminal)
    // does not go through invalidate(), so the cache must still serve the
    // stale value until its TTL expires.
    remoteUrl = "git@gitlab.com:owner/repo.git";
    currentTime += 59_000;
    await expect(resolver.resolve("/repo")).resolves.toMatchObject({ forge: "github" });

    currentTime += 2_000;
    await expect(resolver.resolve("/repo")).resolves.toMatchObject({ forge: "gitlab" });
  });

  it("re-resolves the remote url immediately after invalidate(), before the TTL expires", async () => {
    let currentTime = 0;
    let remoteUrl = "git@github.com:owner/repo.git";
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => remoteUrl,
      now: () => currentTime,
    });

    await expect(resolver.resolve("/repo")).resolves.toMatchObject({ forge: "github" });

    remoteUrl = "git@gitlab.com:owner/repo.git";
    currentTime += 1_000;
    resolver.invalidate("/repo");

    await expect(resolver.resolve("/repo")).resolves.toMatchObject({ forge: "gitlab" });
  });

  it("detects a self-managed GitLab host with no name hint via the per-host probe", async () => {
    const probeForge = vi.fn(async () => "gitlab");
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@git.acme.internal:team/repo.git",
      probeForge,
      resolveSshHostname: resolveSshHostnameAsLiteralHost,
    });
    const resolution = await resolver.resolve("/repo");
    expect(resolution).toMatchObject({ forge: "gitlab", host: "git.acme.internal" });
    expect(probeForge).toHaveBeenCalledWith("git.acme.internal");
  });

  it("skips the probe when the name heuristic already resolves the host", async () => {
    const probeForge = vi.fn(async () => null);
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@github.com:owner/repo.git",
      probeForge,
    });
    const resolution = await resolver.resolve("/repo");
    expect(resolution).toMatchObject({ forge: "github", host: "github.com" });
    expect(probeForge).not.toHaveBeenCalled();
  });

  it.each([
    ["github", "git@github.com:owner/repo.git", "github.com"],
    ["gitlab", "git@gitlab.com:group/repo.git", "gitlab.com"],
    ["gitea", "git@gitea.com:owner/repo.git", "gitea.com"],
    ["codeberg", "git@codeberg.org:owner/repo.git", "codeberg.org"],
  ])("resolves the %s cloud host without probing CLI auth", async (forge, remoteUrl, host) => {
    const probeForge = vi.fn(async () => {
      throw new Error("cloud host should not probe");
    });
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => remoteUrl,
      probeForge,
    });

    await expect(resolver.resolve("/repo")).resolves.toMatchObject({ forge, host });
    expect(probeForge).not.toHaveBeenCalled();
  });

  it("returns null and probes a foreign host only once", async () => {
    const probeForge = vi.fn(async () => null);
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => "git@bitbucket.org:owner/repo.git",
      probeForge,
      resolveSshHostname: resolveSshHostnameAsLiteralHost,
    });
    expect(await resolver.resolve("/a")).toBeNull();
    expect(await resolver.resolve("/b")).toBeNull();
    expect(probeForge).toHaveBeenCalledTimes(1);
  });

  it("lets the synchronous resolveFromRemoteUrl reuse a probed forge", async () => {
    const url = "git@git.acme.internal:team/repo.git";
    const probeForge = vi.fn(async () => "gitlab");
    const resolver = createForgeResolver({
      resolveRemoteUrl: async () => url,
      probeForge,
      resolveSshHostname: resolveSshHostnameAsLiteralHost,
    });
    expect(resolver.resolveFromRemoteUrl(url)).toBeNull();
    await resolver.resolve("/repo");
    expect(resolver.resolveFromRemoteUrl(url)).toMatchObject({
      forge: "gitlab",
      host: "git.acme.internal",
    });
    expect(probeForge).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent probes of the same host into a single probe", async () => {
    let resolveProbe: ((forge: string | null) => void) | undefined;
    const probeForge = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const url = "git@git.acme.internal:team/repo.git";
    const resolver = createForgeResolver({
      probeForge,
      resolveSshHostname: resolveSshHostnameAsLiteralHost,
    });
    const first = resolver.resolveFromRemoteUrlAsync(url);
    const second = resolver.resolveFromRemoteUrlAsync(url);
    await vi.waitFor(() => expect(probeForge).toHaveBeenCalledTimes(1));
    expect(resolveProbe).toBeTypeOf("function");
    resolveProbe?.("gitlab");
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ forge: "gitlab", host: "git.acme.internal" });
    expect(b).toMatchObject({ forge: "gitlab", host: "git.acme.internal" });
    expect(probeForge).toHaveBeenCalledTimes(1);
  });
});
