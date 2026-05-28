import { describe, expect, it } from "vitest";
import { buildGithubSearchQueryOptions, githubSearchQueryKey } from "./use-github-search-query";

describe("githubSearchQueryKey", () => {
  it("keeps the shared cache key shape for no-kinds searches", () => {
    expect(githubSearchQueryKey("server-1", "/repo", "  123  ")).toEqual([
      "github-search",
      "server-1",
      "/repo",
      "123",
    ]);
  });

  it("adds a deterministic kinds key when kinds are specified", () => {
    expect(githubSearchQueryKey("server-1", "/repo", "123", ["github-pr", "github-issue"])).toEqual(
      ["github-search", "server-1", "/repo", "123", "github-issue,github-pr"],
    );
  });
});

describe("buildGithubSearchQueryOptions", () => {
  it("forwards kinds to the GitHub search request when specified", async () => {
    const requests: unknown[] = [];
    const query = buildGithubSearchQueryOptions({
      client: {
        async searchGitHub(options) {
          requests.push(options);
          return { items: [], githubFeaturesEnabled: true, error: null, requestId: "request-1" };
        },
      },
      serverId: "server-1",
      cwd: "/repo",
      query: " 123 ",
      kinds: ["github-pr"],
      enabled: true,
    });

    await query.queryFn();

    expect(requests).toEqual([{ cwd: "/repo", query: "123", limit: 20, kinds: ["github-pr"] }]);
  });
});
