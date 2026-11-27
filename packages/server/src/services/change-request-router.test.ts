import { describe, expect, it, vi } from "vitest";
import { createChangeRequestRouter } from "./change-request-router.js";
import type { ChangeRequestSource } from "./change-request-source.js";
import { createForgeResolver } from "./forge-resolver.js";
import type { ForgeService } from "./forge-service.js";

function createFakeSource(
  forge: string,
  canonicalize: (url: string) => string,
): ChangeRequestSource {
  return {
    resolve: canonicalize,
    describe: (url) => `${forge}:${url}`,
    observe: () => () => {},
  };
}

function createFakeForgeService(changeRequests?: ChangeRequestSource): ForgeService {
  return {
    ...(changeRequests ? { changeRequests } : {}),
    invalidate() {},
  } as unknown as ForgeService;
}

describe("createChangeRequestRouter", () => {
  it("routes cloud hosts without probing and delegates canonicalization to the matched forge", async () => {
    const probeForge = vi.fn(async () => {
      throw new Error("cloud host must not trigger a probe");
    });
    const githubSource = createFakeSource(
      "github",
      (url) => `https://github.com/canonical/${new URL(url).pathname.split("/").at(-1)}`,
    );
    const gitlabSource = createFakeSource(
      "gitlab",
      (url) => `https://gitlab.com/canonical/${new URL(url).pathname.split("/").at(-1)}`,
    );
    const resolver = createForgeResolver({
      probeForge,
      createService: (forge) => {
        if (forge === "github") return createFakeForgeService(githubSource);
        if (forge === "gitlab") return createFakeForgeService(gitlabSource);
        return null;
      },
    });
    const router = createChangeRequestRouter({ forgeResolver: resolver });

    await expect(router.resolve("https://GitHub.com/Org/Repo/pull/7")).resolves.toEqual({
      forge: "github",
      url: "https://github.com/canonical/7",
    });
    await expect(
      router.resolve("https://gitlab.com/org/sub/repo/-/merge_requests/12"),
    ).resolves.toEqual({
      forge: "gitlab",
      url: "https://gitlab.com/canonical/12",
    });
    expect(probeForge).not.toHaveBeenCalled();
    expect(router.source("github")).toBe(githubSource);
    expect(router.source("gitlab")).toBe(gitlabSource);
  });

  it("probes self-hosted hosts before parsing the URL path", async () => {
    const probeForge = vi.fn(async (host: string) =>
      host === "git.corp.internal" ? "gitlab" : null,
    );
    const gitlabResolve = vi.fn(() => "https://git.corp.internal/team/app/-/merge_requests/9");
    const githubResolve = vi.fn(() => {
      throw new Error("github must not parse a gitlab host");
    });
    const resolver = createForgeResolver({
      probeForge,
      createService: (forge) => {
        if (forge === "github")
          return createFakeForgeService(createFakeSource("github", githubResolve));
        if (forge === "gitlab")
          return createFakeForgeService(createFakeSource("gitlab", gitlabResolve));
        return null;
      },
    });
    const router = createChangeRequestRouter({ forgeResolver: resolver });

    await expect(
      router.resolve("https://git.corp.internal/team/app/-/merge_requests/9"),
    ).resolves.toEqual({
      forge: "gitlab",
      url: "https://git.corp.internal/team/app/-/merge_requests/9",
    });
    expect(probeForge).toHaveBeenCalledWith("git.corp.internal");
    expect(gitlabResolve).toHaveBeenCalledTimes(1);
    expect(githubResolve).not.toHaveBeenCalled();
  });

  it("rejects unrecognized hosts, credentials, non-http schemes, and forges without watch support", async () => {
    const resolver = createForgeResolver({
      probeForge: async () => null,
      createService: (forge) => {
        if (forge === "gitea") return createFakeForgeService();
        return null;
      },
    });
    const router = createChangeRequestRouter({ forgeResolver: resolver });

    await expect(router.resolve("not a url")).rejects.toThrow(/change request URL/i);
    await expect(router.resolve("ftp://github.com/org/repo/pull/1")).rejects.toThrow(
      /change request URL/i,
    );
    await expect(router.resolve("https://user:pass@github.com/org/repo/pull/1")).rejects.toThrow(
      /change request URL/i,
    );
    await expect(router.resolve("https://unknown.example.com/org/repo/pull/1")).rejects.toThrow(
      /unknown\.example\.com/,
    );
    await expect(router.resolve("https://gitea.com/org/repo/pulls/1")).rejects.toThrow(
      /not supported.*gitea/i,
    );
    expect(router.source("gitea")).toBeNull();
    expect(router.source("unknown")).toBeNull();
  });
});
