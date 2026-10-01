import { describe, expect, it, vi } from "vitest";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";
import type { ForgeSearchClient } from "./use-forge-search-query";
import {
  AttachPullRequestNotFoundError,
  parseAttachPullRequestNumbers,
  refreshAttachedPullRequests,
  resolvePullRequestForAttach,
  submitAttachPullRequests,
} from "./use-attach-pull-request";
import { pullRequestCurationStore } from "./pull-request-curation-store";

function searchItem(number: number, kind = "change_request", state = "open"): ForgeSearchItem {
  return {
    kind: kind as ForgeSearchItem["kind"],
    number,
    title: `PR ${number}`,
    url: `https://github.com/o/r/pull/${number}`,
    state,
    body: null,
    labels: [],
  };
}

function clientWith(items: ForgeSearchItem[]): ForgeSearchClient & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    searchForge: vi.fn(async (options: unknown) => {
      calls.push(options);
      return { items, authState: "authenticated", error: null, requestId: "test" };
    }),
  };
}

describe("parseAttachPullRequestNumbers", () => {
  it("takes a pasted list, in any of the separators people paste with", () => {
    expect(parseAttachPullRequestNumbers("1335,1346,1350")).toEqual([1335, 1346, 1350]);
    expect(parseAttachPullRequestNumbers("1335 1346\n#1350")).toEqual([1335, 1346, 1350]);
    expect(parseAttachPullRequestNumbers("1335, 1335")).toEqual([1335]);
  });

  it("rejects the whole list when one entry is not a number", () => {
    expect(parseAttachPullRequestNumbers("1335, nope, 1350")).toBeNull();
  });

  it("accepts plain numbers and #prefixed numbers", () => {
    expect(parseAttachPullRequestNumbers("1346")).toEqual([1346]);
    expect(parseAttachPullRequestNumbers("  #1371 ")).toEqual([1371]);
  });

  it("rejects urls, ranges, and garbage", () => {
    expect(parseAttachPullRequestNumbers("https://github.com/o/r/pull/1346")).toBeNull();
    expect(parseAttachPullRequestNumbers("1346-1350")).toBeNull();
    expect(parseAttachPullRequestNumbers("")).toBeNull();
    expect(parseAttachPullRequestNumbers("0")).toBeNull();
    expect(parseAttachPullRequestNumbers("abc")).toBeNull();
  });
});

describe("resolvePullRequestForAttach", () => {
  it("resolves an exact number match with origin manual", async () => {
    const client = clientWith([searchItem(1346)]);
    const result = await resolvePullRequestForAttach({ client, cwd: "/repo", number: 1346 });
    expect(result).toMatchObject({ number: 1346, origin: "manual", state: "open" });
    expect(client.calls).toEqual([
      { cwd: "/repo", query: "1346", limit: 10, kinds: ["change_request"] },
    ]);
  });

  it.each(["OPEN", "MERGED", "CLOSED"])("attaches a %s pull request by number", async (state) => {
    const client = clientWith([searchItem(1377, "change_request", state)]);
    const attached = await submitAttachPullRequests({
      client,
      cwd: "/repo",
      workspaceKey: `srv:ws-terminal-${state}`,
      rawValue: "1377",
      formatInvalid: () => "invalid",
      formatNotFound: () => "missing",
    });
    expect(attached).toEqual([
      expect.objectContaining({ number: 1377, state: state.toLowerCase() }),
    ]);
    expect(pullRequestCurationStore.getFacts(`srv:ws-terminal-${state}`)).toEqual(attached);
    expect(client.calls).toEqual([
      { cwd: "/repo", query: "1377", limit: 10, kinds: ["change_request"] },
    ]);
    pullRequestCurationStore.clear(`srv:ws-terminal-${state}`);
  });

  it("ignores fuzzy hits and matches the exact number", async () => {
    const client = clientWith([searchItem(13460), searchItem(1346)]);
    const result = await resolvePullRequestForAttach({ client, cwd: "/repo", number: 1346 });
    expect(result.number).toBe(1346);
  });

  it("falls back to merged pull requests", async () => {
    const calls: unknown[] = [];
    const client: ForgeSearchClient = {
      searchForge: vi.fn(async (options: { query: string }) => {
        calls.push(options);
        const items =
          options.query === "1377 is:merged" ? [searchItem(1377, "change_request", "MERGED")] : [];
        return { items, authState: "authenticated", error: null, requestId: "test" };
      }),
    };
    const result = await resolvePullRequestForAttach({ client, cwd: "/repo", number: 1377 });
    expect(result).toMatchObject({ number: 1377, state: "merged" });
    expect(calls).toEqual([
      { cwd: "/repo", query: "1377", limit: 10, kinds: ["change_request"] },
      { cwd: "/repo", query: "1377 is:merged", limit: 10, kinds: ["change_request"] },
    ]);
  });

  it("throws not-found when nothing matches exactly", async () => {
    const client = clientWith([searchItem(13460)]);
    await expect(
      resolvePullRequestForAttach({ client, cwd: "/repo", number: 1346 }),
    ).rejects.toBeInstanceOf(AttachPullRequestNotFoundError);
  });

  it("throws not-found on empty results", async () => {
    const client = clientWith([]);
    await expect(
      resolvePullRequestForAttach({ client, cwd: "/repo", number: 1346 }),
    ).rejects.toBeInstanceOf(AttachPullRequestNotFoundError);
  });
});

describe("submitAttachPullRequests", () => {
  const formatInvalid = () => "invalid";
  const formatNotFound = (numbers: number[]) => `missing ${numbers.join(", ")}`;

  it("resolves and records the attachment in the workspace store", async () => {
    const client = clientWith([searchItem(1346)]);
    const facts = await submitAttachPullRequests({
      client,
      cwd: "/repo",
      workspaceKey: "srv:ws-submit",
      rawValue: "1346",
      formatInvalid,
      formatNotFound,
    });
    expect(facts.map((fact) => fact.number)).toEqual([1346]);
    expect(pullRequestCurationStore.getCuration("srv:ws-submit")).toEqual({
      added: [1346],
      removed: [],
    });
    pullRequestCurationStore.clear("srv:ws-submit");
  });

  it("keeps the pull requests it found when one number in the list is stale", async () => {
    const client = clientWith([searchItem(1346), searchItem(1350)]);
    await expect(
      submitAttachPullRequests({
        client,
        cwd: "/repo",
        workspaceKey: "srv:ws-partial",
        rawValue: "1346, 1349, 1350",
        formatInvalid,
        formatNotFound,
      }),
    ).rejects.toThrow("missing 1349");
    expect(pullRequestCurationStore.getCuration("srv:ws-partial")).toEqual({
      added: [1346, 1350],
      removed: [],
    });
    pullRequestCurationStore.clear("srv:ws-partial");
  });

  it("rejects invalid input without touching the store", async () => {
    const client = clientWith([searchItem(1346)]);
    await expect(
      submitAttachPullRequests({
        client,
        cwd: "/repo",
        workspaceKey: "srv:ws-submit-invalid",
        rawValue: "abc",
        formatInvalid,
        formatNotFound,
      }),
    ).rejects.toThrow("invalid");
    expect(pullRequestCurationStore.getCuration("srv:ws-submit-invalid")).toEqual({
      added: [],
      removed: [],
    });
  });

  it("maps a missed lookup to the not-found message", async () => {
    const client = clientWith([]);
    await expect(
      submitAttachPullRequests({
        client,
        cwd: "/repo",
        workspaceKey: "srv:ws-submit-miss",
        rawValue: "9999",
        formatInvalid,
        formatNotFound,
      }),
    ).rejects.toThrow("missing 9999");
  });
});

// Eight numbers used to cost sixteen round trips taken strictly one after
// another, and the dialog sat on "Saving..." for the sum of all of them. The
// two queries per number stay: `gh pr list --search` is open-only, so the
// second one is how a merged pull request is found at all.
describe("submitAttachPullRequests round trips", () => {
  it("resolves the numbers at the same time rather than in sequence", async () => {
    let inFlight = 0;
    let peak = 0;
    const client: ForgeSearchClient = {
      searchForge: async (options: { query: string }) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        const number = Number.parseInt(options.query, 10);
        return {
          items: Number.isNaN(number) ? [] : [searchItem(number)],
          authState: "authenticated",
          error: null,
          requestId: "test",
        };
      },
    };
    const attached = await submitAttachPullRequests({
      client,
      cwd: "/repo",
      workspaceKey: "ws-parallel",
      rawValue: "21,22,23,24",
      formatInvalid: () => "invalid",
      formatNotFound: (numbers) => `missing ${numbers.join(", ")}`,
    });
    expect(attached.map((entry) => entry.number)).toEqual([21, 22, 23, 24]);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("refreshAttachedPullRequests", () => {
  it("records an attached pull request merged since it was attached", async () => {
    const client: ForgeSearchClient = {
      searchForge: vi.fn(async (options: { query: string }) => ({
        items:
          options.query === "1335 is:merged" ? [searchItem(1335, "change_request", "MERGED")] : [],
        authState: "authenticated",
        error: null,
        requestId: "test",
      })),
    };
    const attached = (number: number, origin: "manual" | "branch") => ({
      number,
      url: `https://github.com/o/r/pull/${number}`,
      state: "open" as const,
      origin,
    });
    const changed = await refreshAttachedPullRequests({
      client,
      cwd: "/repo",
      workspaceKey: "srv:ws-refresh",
      pullRequests: [attached(1335, "manual"), attached(1400, "branch")],
    });
    expect(changed).toBe(1);
    expect(pullRequestCurationStore.getFacts("srv:ws-refresh")).toEqual([
      expect.objectContaining({ number: 1335, state: "merged" }),
    ]);
    pullRequestCurationStore.clear("srv:ws-refresh");
  });
});
