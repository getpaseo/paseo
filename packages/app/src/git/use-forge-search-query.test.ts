import { describe, expect, it, vi } from "vitest";
import { buildForgeSearchQueryOptions, forgeSearchQueryKey } from "./use-forge-search-query";

const target = {
  cwd: "/workspace",
  queryIdentity: ["selected", "workspace-a"] as const,
};

describe("forge search query", () => {
  it("keys same-cwd workspaces independently", () => {
    expect(forgeSearchQueryKey("server", target, "  issue ")).not.toEqual(
      forgeSearchQueryKey(
        "server",
        { ...target, queryIdentity: ["selected", "workspace-b"] },
        "issue",
      ),
    );
  });

  it("does not alias a selected id that resembles a legacy address", () => {
    expect(
      forgeSearchQueryKey(
        "server",
        { cwd: "/shared", queryIdentity: ["selected", "legacy:/shared"] },
        "issue",
      ),
    ).not.toEqual(
      forgeSearchQueryKey(
        "server",
        { cwd: "/shared", queryIdentity: ["legacy", "/shared"] },
        "issue",
      ),
    );
  });

  it("searches through the already-bound workspace capability", async () => {
    const searchForge = vi.fn(async () => ({
      items: [],
      authState: "authenticated" as const,
      error: null,
      requestId: "search-1",
    }));
    const options = buildForgeSearchQueryOptions({
      client: { ...target, searchForge },
      serverId: "server",
      query: "  issue ",
      supportsForgeSearch: true,
      enabled: true,
    });
    await expect(options.queryFn()).resolves.toMatchObject({ authState: "authenticated" });
    expect(searchForge).toHaveBeenCalledWith({ query: "issue", limit: 20 });
  });

  it("uses the bound legacy GitHub method when the forge RPC is unavailable", async () => {
    const searchForge = vi.fn();
    const searchGitHub = vi.fn(async () => ({
      items: [],
      authState: "authenticated" as const,
      featuresEnabled: true,
      githubFeaturesEnabled: true,
      error: null,
      requestId: "search-legacy",
    }));
    const options = buildForgeSearchQueryOptions({
      client: { ...target, searchForge, searchGitHub },
      serverId: "server",
      query: "42",
      kinds: ["change_request"],
      enabled: true,
    });
    await options.queryFn();
    expect(searchGitHub).toHaveBeenCalledWith({ query: "42", limit: 20, kinds: ["github-pr"] });
    expect(searchForge).not.toHaveBeenCalled();
  });
});
