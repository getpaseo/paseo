import { describe, expect, it } from "vitest";
import { buildForgeSearchQueryOptions, forgeSearchQueryKey } from "./use-forge-search-query";

describe("forgeSearchQueryKey", () => {
  it("keeps the shared cache key shape for no-kinds searches", () => {
    expect(forgeSearchQueryKey("server-1", "/repo", "  123  ")).toEqual([
      "forge-search",
      "server-1",
      "/repo",
      "forge",
      "123",
    ]);
  });

  it("adds a deterministic kinds key when kinds are specified", () => {
    expect(forgeSearchQueryKey("server-1", "/repo", "123", ["change_request", "issue"])).toEqual([
      "forge-search",
      "server-1",
      "/repo",
      "forge",
      "123",
      "change_request,issue",
    ]);
  });

  it("separates legacy GitHub fallback results from forge search results", () => {
    expect(forgeSearchQueryKey("server-1", "/repo", "123", undefined, "github")).toEqual([
      "forge-search",
      "server-1",
      "/repo",
      "github",
      "123",
    ]);
  });
});

describe("buildForgeSearchQueryOptions", () => {
  it("forwards kinds to the forge search request when specified", async () => {
    const requests: unknown[] = [];
    const query = buildForgeSearchQueryOptions({
      client: {
        async searchForge(options) {
          requests.push(options);
          return {
            items: [],
            authState: "authenticated",
            error: null,
            requestId: "request-1",
          };
        },
      },
      serverId: "server-1",
      cwd: "/repo",
      query: " 123 ",
      kinds: ["change_request"],
      enabled: true,
    });

    await query.queryFn();

    expect(requests).toEqual([
      { cwd: "/repo", query: "123", limit: 20, kinds: ["change_request"] },
    ]);
  });

  it("uses the legacy GitHub search request when forge search is unsupported", async () => {
    const forgeRequests: unknown[] = [];
    const githubRequests: unknown[] = [];
    const query = buildForgeSearchQueryOptions({
      client: {
        async searchForge(options) {
          forgeRequests.push(options);
          return {
            items: [],
            authState: "authenticated",
            error: null,
            requestId: "forge-request",
          };
        },
        async searchGitHub(options) {
          githubRequests.push(options);
          return {
            items: [],
            featuresEnabled: true,
            authState: "authenticated",
            githubFeaturesEnabled: true,
            error: null,
            requestId: "github-request",
          };
        },
      },
      serverId: "server-1",
      cwd: "/repo",
      query: " 456 ",
      kinds: ["issue"],
      enabled: true,
      supportsForgeSearch: false,
    });

    await query.queryFn();

    expect(forgeRequests).toEqual([]);
    expect(githubRequests).toEqual([
      { cwd: "/repo", query: "456", limit: 20, kinds: ["github-issue"] },
    ]);
  });

  it("normalizes legacy GitHub PR items into neutral change-request items", async () => {
    const query = buildForgeSearchQueryOptions({
      client: {
        async searchForge() {
          throw new Error("unexpected forge search");
        },
        async searchGitHub() {
          return {
            items: [
              {
                kind: "pr" as const,
                number: 17,
                title: "Fix search",
                url: "https://github.com/acme/repo/pull/17",
                state: "open",
                body: null,
                labels: ["bug"],
                baseRefName: "main",
                headRefName: "fix-search",
              },
            ],
            featuresEnabled: true,
            authState: "authenticated" as const,
            githubFeaturesEnabled: true,
            error: null,
            requestId: "github-request",
          };
        },
      },
      serverId: "server-1",
      cwd: "/repo",
      query: " 456 ",
      enabled: true,
      supportsForgeSearch: false,
    });

    const result = await query.queryFn();

    expect(result.items).toEqual([
      {
        kind: "change_request",
        number: 17,
        title: "Fix search",
        url: "https://github.com/acme/repo/pull/17",
        state: "open",
        body: null,
        labels: ["bug"],
        baseRefName: "main",
        headRefName: "fix-search",
      },
    ]);
  });

  it("interprets modern search payloads at the query boundary", async () => {
    const query = buildForgeSearchQueryOptions({
      client: {
        async searchForge() {
          return {
            items: [
              {
                kind: "issue",
                number: 23,
                title: "Keep this",
                url: "https://gitlab.com/acme/repo/-/issues/23",
                state: "open",
                body: null,
                labels: [],
              },
              { kind: "future_kind", futureField: true },
            ],
            authState: "future_auth_state",
            error: null,
            requestId: "forge-request",
          };
        },
      },
      serverId: "server-1",
      cwd: "/repo",
      query: "23",
      enabled: true,
      supportsForgeSearch: true,
    });

    const result = await query.queryFn();

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.kind).toBe("issue");
    expect(result.authState).toBe("unauthenticated");
  });

  it("derives legacy search auth from legacy feature flags", async () => {
    const query = buildForgeSearchQueryOptions({
      client: {
        async searchForge() {
          throw new Error("unexpected forge search");
        },
        async searchGitHub() {
          return {
            items: [],
            githubFeaturesEnabled: false,
            error: null,
            requestId: "github-request",
          };
        },
      },
      serverId: "server-1",
      cwd: "/repo",
      query: "23",
      enabled: true,
      supportsForgeSearch: false,
    });

    expect((await query.queryFn()).authState).toBe("unauthenticated");
  });

  it("invokes forge search bound to the client so this-dependent methods work", async () => {
    const client = new ThisDependentSearchClient();

    const query = buildForgeSearchQueryOptions({
      client,
      serverId: "server-1",
      cwd: "/repo",
      query: " 789 ",
      enabled: true,
      supportsForgeSearch: true,
    });

    const result = await query.queryFn();

    expect(result.requestId).toBe("forge.search.request");
    expect(client.requests).toEqual([{ cwd: "/repo", query: "789", limit: 20 }]);
  });

  it("invokes the legacy GitHub search bound to the client", async () => {
    const client = new ThisDependentSearchClient();

    const query = buildForgeSearchQueryOptions({
      client,
      serverId: "server-1",
      cwd: "/repo",
      query: " 789 ",
      enabled: true,
      supportsForgeSearch: false,
    });

    const result = await query.queryFn();

    expect(result.requestId).toBe("github_search_request");
    expect(client.requests).toEqual([{ cwd: "/repo", query: "789", limit: 20 }]);
  });
});

class ThisDependentSearchClient {
  readonly requests: unknown[] = [];

  private send(requestId: string, options: { cwd: string; query: string; limit?: number }) {
    this.requests.push(options);
    return Promise.resolve({
      items: [],
      featuresEnabled: true,
      authState: "authenticated" as const,
      githubFeaturesEnabled: true,
      error: null,
      requestId,
    });
  }

  async searchForge(options: { cwd: string; query: string; limit?: number }) {
    return this.send("forge.search.request", options);
  }

  async searchGitHub(options: { cwd: string; query: string; limit?: number }) {
    return this.send("github_search_request", options);
  }
}
