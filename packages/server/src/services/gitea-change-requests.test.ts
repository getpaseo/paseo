import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentMessageDelivery } from "../server/agent/agent-messages/index.js";
import { AgentBackgroundWorkStore } from "../server/agent/background-work/index.js";
import { createChangeRequestWatches } from "../server/agent/change-request-watches/index.js";
import { createChangeRequestRouter } from "./change-request-router.js";
import type { ChangeRequestSnapshot } from "./change-request-source.js";
import { createForgeResolver } from "./forge-resolver.js";
import { describeGiteaChangeRequest, resolveGiteaChangeRequest } from "./gitea-change-requests.js";
import {
  createGiteaService,
  TeaAuthenticationError,
  type TeaCommandRunner,
} from "./gitea-service.js";

const PR2_WORKDIR_NOTE = "cwd-free";

function teaHttp(
  body: unknown,
  options: { status?: string; headers?: Record<string, string>; headersOnStderr?: boolean } = {},
): { stdout: string; stderr: string } {
  const lines = [`HTTP/1.1 ${options.status ?? "200 OK"}`];
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    lines.push(`${key}: ${value}`);
  }
  const headerBlock = `${lines.join("\r\n")}\r\n\r\n`;
  const json = typeof body === "string" ? body : JSON.stringify(body);
  if (options.headersOnStderr) {
    return { stdout: json, stderr: headerBlock };
  }
  return { stdout: `${headerBlock}${json}`, stderr: "" };
}

function createFakeTeaRunner(
  handler: (
    args: string[],
    options: { cwd: string; envOverlay?: Record<string, string> },
  ) => Promise<{ stdout: string; stderr: string }> | { stdout: string; stderr: string },
) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runner: TeaCommandRunner = async (args, options) => {
    calls.push({ args: [...args], cwd: options.cwd });
    return await handler(args, options);
  };
  return { runner, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Gitea-family change request URL resolution and description", () => {
  it("canonicalizes Gitea, Codeberg, and self-hosted Forgejo PR URLs across tabs, queries, and ports", () => {
    expect(
      resolveGiteaChangeRequest("https://Codeberg.org/Org/Repo/pulls/042/files?style=split#diff-1"),
    ).toBe("https://codeberg.org/org/repo/pulls/42");
    expect(resolveGiteaChangeRequest("https://gitea.com/Alice/App/pulls/7/commits/")).toBe(
      "https://gitea.com/alice/app/pulls/7",
    );
    expect(
      resolveGiteaChangeRequest("https://Forgejo.Example.Org:3000/Team/Tool/pulls/9/checks"),
    ).toBe("https://forgejo.example.org:3000/team/tool/pulls/9");
    expect(resolveGiteaChangeRequest("http://gitea.lan:3000/Team/Tool/pulls/3")).toBe(
      "http://gitea.lan:3000/team/tool/pulls/3",
    );
  });

  it("maps repository case variants to one watch while preserving the mount path", () => {
    const baseUrl = "https://forge.example/Apps/Gitea";
    const canonical = `${baseUrl}/org/repo/pulls/1`;
    expect(resolveGiteaChangeRequest(`${baseUrl}/Org/Repo/pulls/1/files`)).toBe(canonical);
    expect(resolveGiteaChangeRequest(canonical)).toBe(canonical);
  });

  it("describes cloud and self-hosted PRs with native #N numbering and host when non-default", () => {
    expect(describeGiteaChangeRequest("https://codeberg.org/Org/Repo/pulls/42")).toBe(
      "Org/Repo #42",
    );
    expect(describeGiteaChangeRequest("https://gitea.com/Alice/App/pulls/7")).toBe("Alice/App #7");
    expect(describeGiteaChangeRequest("https://forgejo.example.org:3000/Team/Tool/pulls/9")).toBe(
      "forgejo.example.org:3000/Team/Tool #9",
    );
  });

  it("rejects invalid Gitea-family PR URLs", () => {
    for (const invalid of [
      "https://codeberg.org/Org/Repo/pull/42",
      "https://codeberg.org/Org/Repo/issues/42",
      "https://codeberg.org/Org/Repo/pulls/0",
      "https://codeberg.org/Org/../pulls/42",
      "https://codeberg.org/Org/Repo/pulls/42/unknown",
      "http://codeberg.org/Org/Repo/pulls/42",
      "http://gitea.com/Org/Repo/pulls/42",
    ]) {
      expect(() => resolveGiteaChangeRequest(invalid), invalid).toThrow(/pull request URL/i);
    }
  });
});

describe("Gitea-family ChangeRequestSource polling", () => {
  it("refreshes cached inline comments even if the review count stays the same", async () => {
    vi.useFakeTimers();
    const origin = "https://codeberg.org";
    const url = `${origin}/org/repo/pulls/1`;
    let inlineId = 10;
    let closed = false;
    let inlineRequests = 0;
    const { runner, calls } = createFakeTeaRunner((args) => {
      if (args[0] === "login")
        return { stdout: JSON.stringify([{ name: "cb", url: origin }]), stderr: "" };
      const endpoint = args.at(-1)!;
      if (endpoint.endsWith("/pulls/1"))
        return teaHttp({ number: 1, state: closed ? "closed" : "open", head: { sha: "head" } });
      if (endpoint.includes("/status?")) return teaHttp({ statuses: [] });
      if (endpoint.includes("/actions/tasks?")) return teaHttp({ workflow_runs: [] });
      if (endpoint.includes("/reviews?"))
        return teaHttp([{ id: 5, state: "APPROVED", comments_count: 1 }]);
      if (endpoint.endsWith("/reviews/5/comments")) {
        inlineRequests += 1;
        return teaHttp([{ id: inlineId }]);
      }
      return teaHttp([]);
    });
    const service = createGiteaService({
      runner,
      resolveTeaPath: async () => "tea",
      watchPollMs: 60_000,
    });
    const seen = new Set<string>();
    try {
      service.changeRequests!.observe(url, {
        knownActivity: () => seen,
        async snapshot(snapshot) {
          for (const item of snapshot.activity) seen.add(item.id);
        },
        error(error) {
          throw error;
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(seen.has("inline:10")).toBe(true);
      inlineId = 12;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(seen.has("inline:12")).toBe(false);
      expect(inlineRequests).toBe(1);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(seen.has("inline:12")).toBe(true);
      expect(calls.filter(({ args }) => args.at(-1)?.endsWith("/reviews/5/comments"))).toHaveLength(
        2,
      );
      inlineId = 13;
      closed = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(seen.has("inline:13")).toBe(true);
    } finally {
      service.dispose?.();
    }
  });

  it("keeps path-mounted and root tea logins separate", async () => {
    vi.useFakeTimers();
    const origin = "https://forge.example";
    const { runner } = createFakeTeaRunner((args) => {
      if (args[0] === "login") {
        return {
          stdout: JSON.stringify([
            { name: "subpath", url: `${origin}/apps/gitea/` },
            { name: "root", url: `${origin}/` },
          ]),
          stderr: "",
        };
      }
      const endpoint = args.at(-1)!;
      if (endpoint === "repos/Org/Repo/pulls/1") {
        return teaHttp({ number: 1, state: "open", head: { sha: args[2] } });
      }
      if (endpoint.includes("/status?")) return teaHttp({ statuses: [] });
      if (endpoint.includes("/actions/tasks?")) return teaHttp({ workflow_runs: [] });
      return teaHttp([]);
    });
    const service = createGiteaService({ runner, resolveTeaPath: async () => "tea" });
    try {
      const source = service.changeRequests!;
      const snapshots: ChangeRequestSnapshot[] = [];
      source.observe(`${origin}/Org/Repo/pulls/1`, {
        async snapshot(snapshot) {
          snapshots.push(snapshot);
        },
        error(error) {
          throw error;
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(snapshots.map(({ headSha }) => headSha)).toEqual(["root"]);
      const mountedPr = `${origin}/apps/gitea/Org/Repo/pulls/1`;
      expect(source.resolve(`${mountedPr}/files?view=split`)).toBe(
        `${origin}/apps/gitea/org/repo/pulls/1`,
      );
      source.observe(mountedPr, {
        async snapshot(snapshot) {
          snapshots.push(snapshot);
        },
        error(error) {
          throw error;
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(snapshots.map(({ headSha }) => headSha)).toEqual(["root", "subpath"]);
    } finally {
      service.dispose?.();
    }
  });

  it.each(["Gitea page", "Forgejo array", "unrelated run"])(
    "correlates Actions jobs from a %s response with the watched run",
    async (shape) => {
      vi.useFakeTimers();
      const origin = "https://codeberg.org";
      const run = `${origin}/Org/Repo/actions/runs/100`;
      const responseRun = shape === "unrelated run" ? `${origin}/Org/Repo/actions/runs/99` : run;
      const { runner } = createFakeTeaRunner((args) => {
        if (args[0] === "login")
          return { stdout: JSON.stringify([{ name: "cb", url: origin }]), stderr: "" };
        const endpoint = args.at(-1)!;
        if (endpoint.endsWith("/pulls/1"))
          return teaHttp({ number: 1, state: "open", head: { sha: "head" } });
        if (endpoint.includes("/status?")) {
          return teaHttp({
            statuses: [
              { id: 1, status: "success", context: "CI / job", target_url: `${run}/jobs/1` },
            ],
          });
        }
        if (endpoint.includes("/actions/tasks?")) {
          return teaHttp({
            workflow_runs: [
              {
                id: 55,
                name: "job",
                head_sha: "head",
                status: shape === "unrelated run" ? "success" : "failure",
                url: run,
              },
              { id: 56, name: "job", head_sha: "head", status: "success", url: run },
            ],
            total_count: 2,
          });
        }
        if (endpoint.includes("/actions/runs/100/jobs?")) {
          const jobs = [
            {
              id: 201,
              name: "job",
              status: "completed",
              conclusion: "failure",
              html_url: `${responseRun}/jobs/0`,
            },
            {
              id: 202,
              name: "job",
              status: "completed",
              conclusion: "success",
              html_url: `${responseRun}/jobs/1`,
            },
          ];
          return teaHttp(shape === "Forgejo array" ? jobs : { jobs, total_count: jobs.length });
        }
        return teaHttp([]);
      });
      const service = createGiteaService({ runner, resolveTeaPath: async () => "tea" });
      const snapshots: ChangeRequestSnapshot[] = [];
      try {
        service.changeRequests!.observe(`${origin}/Org/Repo/pulls/1`, {
          async snapshot(snapshot) {
            snapshots.push(snapshot);
          },
          error(error) {
            throw error;
          },
        });
        await vi.advanceTimersByTimeAsync(25);
        if (shape === "unrelated run") {
          expect(snapshots[0]?.checksState).toBe("passed");
          expect(snapshots[0]?.checks.map(({ url }) => url)).toEqual([`${run}/jobs/1`, run, run]);
        } else {
          expect(snapshots[0]?.checksState).toBe("failed");
          expect(snapshots[0]?.checks.map(({ state, url }) => [state, url])).toEqual([
            ["failed", `${run}/jobs/0`],
            ["passed", `${run}/jobs/1`],
          ]);
        }
      } finally {
        service.dispose?.();
      }
    },
  );

  it("refreshes the named tea login when the user changes its destination", async () => {
    vi.useFakeTimers();
    const origin = "https://codeberg.org";
    let changed = false;
    const { runner } = createFakeTeaRunner((args) => {
      if (args[0] === "login")
        return {
          stdout: JSON.stringify(
            changed
              ? [
                  { name: "old", url: "https://forge.example" },
                  { name: "new", url: origin },
                ]
              : [{ name: "old", url: origin }],
          ),
          stderr: "",
        };
      const endpoint = args.at(-1)!;
      if (endpoint.endsWith("/pulls/1")) {
        const correct = !changed || args[2] === "new";
        return teaHttp({
          number: 1,
          state: correct ? "open" : "closed",
          html_url: `${correct ? origin : "https://forge.example"}/Org/Repo/pulls/1`,
          head: { sha: correct ? "intended" : "wrong" },
        });
      }
      if (endpoint.includes("/status?")) return teaHttp({ statuses: [] });
      if (endpoint.includes("/actions/tasks?")) return teaHttp({ workflow_runs: [] });
      return teaHttp([]);
    });
    const service = createGiteaService({
      runner,
      resolveTeaPath: async () => "tea",
      watchPollMs: 10_000,
    });
    const snapshots: ChangeRequestSnapshot[] = [];
    try {
      service.changeRequests!.observe(`${origin}/Org/Repo/pulls/1`, {
        async snapshot(snapshot) {
          snapshots.push(snapshot);
        },
        error(error) {
          throw error;
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      changed = true;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(snapshots.map(({ state, headSha }) => [state, headSha])).toEqual([
        ["open", "intended"],
        ["open", "intended"],
      ]);
    } finally {
      service.dispose?.();
    }
  });

  it("rejects overlapping status pages before reporting that checks passed", async () => {
    vi.useFakeTimers();
    const origin = "https://codeberg.org";
    const firstPage = Array.from({ length: 50 }, (_, id) => ({ id, status: "success" }));
    const { runner } = createFakeTeaRunner((args) => {
      if (args[0] === "login")
        return { stdout: JSON.stringify([{ name: "cb", url: origin }]), stderr: "" };
      const endpoint = args.at(-1)!;
      if (endpoint.endsWith("/pulls/1"))
        return teaHttp({ number: 1, state: "open", head: { sha: "head" } });
      if (endpoint.includes("/status?")) {
        const statuses = endpoint.includes("page=1")
          ? firstPage
          : [firstPage[0], { id: 51, status: "success" }];
        return teaHttp({ statuses }, { headers: { "X-Total-Count": "52" } });
      }
      if (endpoint.includes("/actions/tasks?")) return teaHttp({ workflow_runs: [] });
      return teaHttp([]);
    });
    const service = createGiteaService({ runner, resolveTeaPath: async () => "tea" });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: unknown[] = [];
    try {
      service.changeRequests!.observe(`${origin}/Org/Repo/pulls/1`, {
        async snapshot(snapshot) {
          snapshots.push(snapshot);
        },
        error: (error) => errors.push(error),
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(errors).toEqual([
        expect.objectContaining({ message: expect.stringContaining("status pages") }),
      ]);
      expect(snapshots).toEqual([]);
    } finally {
      service.dispose?.();
    }
  });

  it.each(["Has been cancelled", "Canceled after 5s"])(
    "keeps the canceled job neutral without run details (%s)",
    async (description) => {
      vi.useFakeTimers();
      const origin = "https://codeberg.org";
      const run = `${origin}/Org/Repo/actions/runs/42`;
      const { runner } = createFakeTeaRunner((args) => {
        if (args[0] === "login")
          return { stdout: JSON.stringify([{ name: "cb", url: origin }]), stderr: "" };
        const endpoint = args.at(-1)!;
        if (endpoint.endsWith("/pulls/1"))
          return teaHttp({ number: 1, state: "open", head: { sha: "head" } });
        if (endpoint.includes("/status?")) {
          return teaHttp({
            statuses: [{ id: 4, status: "failure", description, target_url: `${run}/jobs/2` }],
          });
        }
        if (endpoint.includes("/actions/tasks?")) {
          return teaHttp({
            workflow_runs: [{ id: 53, head_sha: "head", status: "cancelled", url: run }],
            total_count: 1,
          });
        }
        if (endpoint.includes("/actions/runs/42/jobs")) {
          return teaHttp({ message: "Not found" }, { status: "404 Not Found" });
        }
        return teaHttp([]);
      });
      const service = createGiteaService({ runner, resolveTeaPath: async () => "tea" });
      const snapshots: ChangeRequestSnapshot[] = [];
      try {
        service.changeRequests!.observe(`${origin}/Org/Repo/pulls/1`, {
          async snapshot(snapshot) {
            snapshots.push(snapshot);
          },
          error(error) {
            throw error;
          },
        });
        await vi.advanceTimersByTimeAsync(25);
        expect(snapshots[0]?.checksState).toBe("neutral");
        expect(snapshots[0]?.checks.map(({ state }) => state)).toEqual(["neutral", "neutral"]);
      } finally {
        service.dispose?.();
      }
    },
  );

  it("keeps one check for an Actions job reported as both a commit status and a run task", async () => {
    vi.useFakeTimers();
    const origin = "https://codeberg.org";
    const run = `${origin}/Org/Repo/actions/runs/100`;
    const { runner } = createFakeTeaRunner((args) => {
      if (args[0] === "login") {
        return { stdout: JSON.stringify([{ name: "cb", url: origin }]), stderr: "" };
      }
      const endpoint = args.at(-1)!;
      if (endpoint.endsWith("/pulls/1")) {
        return teaHttp({ number: 1, state: "open", head: { sha: "head" } });
      }
      if (endpoint.includes("/status?")) {
        return teaHttp({
          statuses: [{ id: 1, status: "failure", context: "build", target_url: `${run}/jobs/21` }],
        });
      }
      if (endpoint.includes("/actions/tasks?")) {
        return teaHttp({
          workflow_runs: [{ id: 55, head_sha: "head", status: "cancelled", url: run }],
          total_count: 1,
        });
      }
      if (endpoint.includes("/actions/runs/100/jobs?")) {
        return teaHttp({
          jobs: [
            {
              id: 55,
              name: "build",
              status: "completed",
              conclusion: "cancelled",
              html_url: `${run}/jobs/21`,
            },
          ],
          total_count: 1,
        });
      }
      return teaHttp([]);
    });
    const service = createGiteaService({ runner, resolveTeaPath: async () => "tea" });
    const snapshots: ChangeRequestSnapshot[] = [];
    try {
      service.changeRequests!.observe(`${origin}/Org/Repo/pulls/1`, {
        async snapshot(snapshot) {
          snapshots.push(snapshot);
        },
        error(error) {
          throw error;
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(snapshots[0]?.checks).toEqual([
        { id: "action-job:55", name: "build", state: "neutral", url: `${run}/jobs/21` },
      ]);
    } finally {
      service.dispose?.();
    }
  });

  it("stops admitting queued inline-comment requests after a 429", async () => {
    vi.useFakeTimers();
    const origin = "https://codeberg.org";
    const reviews = Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      state: "APPROVED",
      comments_count: 1,
    }));
    let inlineRequests = 0;
    const { runner } = createFakeTeaRunner((args) => {
      if (args[0] === "login") {
        return { stdout: JSON.stringify([{ name: "cb", url: origin }]), stderr: "" };
      }
      const endpoint = args.at(-1)!;
      if (endpoint.endsWith("/pulls/1")) {
        return teaHttp({ number: 1, state: "open", head: { sha: "head" } });
      }
      if (endpoint.includes("/status?")) return teaHttp({ statuses: [] });
      if (endpoint.includes("/actions/tasks?")) return teaHttp({ workflow_runs: [] });
      if (endpoint.includes("/reviews?")) {
        return teaHttp(reviews);
      }
      if (endpoint.includes("/reviews/")) {
        inlineRequests += 1;
        if (inlineRequests === 1) {
          return teaHttp(
            { message: "slow down" },
            {
              status: "429 Too Many Requests",
              headers: { "Retry-After": "60" },
            },
          );
        }
      }
      return teaHttp([]);
    });
    const service = createGiteaService({ runner, resolveTeaPath: async () => "tea" });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: unknown[] = [];
    try {
      service.changeRequests!.observe(`${origin}/Org/Repo/pulls/1`, {
        async snapshot(snapshot) {
          snapshots.push(snapshot);
        },
        error: (error) => errors.push(error),
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(errors).toHaveLength(1);
      expect(inlineRequests).toBeGreaterThan(0);
      expect(inlineRequests).toBeLessThanOrEqual(3);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(inlineRequests).toBeLessThanOrEqual(3);
      expect(snapshots).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(snapshots).toHaveLength(1);
    } finally {
      service.dispose?.();
    }
  });

  it("reads submitted reviews after an empty page filtered by the forge", async () => {
    vi.useFakeTimers();
    const origin = "https://codeberg.org";
    const url = `${origin}/Org/Repo/pulls/1`;
    const { runner } = createFakeTeaRunner((args) => {
      if (args[0] === "login") {
        return { stdout: JSON.stringify([{ name: "cb", url: origin }]), stderr: "" };
      }
      const endpoint = args.at(-1)!;
      if (endpoint.endsWith("/pulls/1")) {
        return teaHttp({ number: 1, state: "open", head: { sha: "head" } });
      }
      if (endpoint.includes("/status?")) return teaHttp({ statuses: [] });
      if (endpoint.includes("/actions/tasks?")) return teaHttp({ workflow_runs: [] });
      if (endpoint.includes("/reviews?")) {
        const page = new URL(endpoint, `${origin}/`).searchParams.get("page");
        const items = page === "2" ? [{ id: 5, state: "APPROVED" }] : [];
        return teaHttp(items, { headers: { "X-Total-Count": "2" } });
      }
      return teaHttp([]);
    });
    const service = createGiteaService({ runner, resolveTeaPath: async () => "tea" });
    const snapshots: ChangeRequestSnapshot[] = [];
    try {
      service.changeRequests!.observe(url, {
        async snapshot(snapshot) {
          snapshots.push(snapshot);
        },
        error(error) {
          throw error;
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(snapshots[0]?.activity).toEqual([
        { id: "review:5", kind: "review", url: `${url}#pullrequestreview-5` },
      ]);
    } finally {
      service.dispose?.();
    }
  });

  it("selects the tea login for the exact web origin", async () => {
    vi.useFakeTimers();
    const { runner } = createFakeTeaRunner((args) => {
      if (args[0] === "login") {
        return {
          stdout: JSON.stringify([
            { name: "custom-port", url: "https://forge.example:3000" },
            { name: "http", url: "http://forge.example" },
            { name: "https", url: "https://forge.example:443" },
          ]),
          stderr: "",
        };
      }
      const endpoint = args.at(-1)!;
      if (endpoint === "repos/Org/Repo/pulls/1") {
        return teaHttp({ number: 1, state: "open", head: { sha: args[2] } });
      }
      if (endpoint.includes("/status?")) return teaHttp({ statuses: [] });
      if (endpoint.includes("/actions/tasks?")) return teaHttp({ workflow_runs: [] });
      return teaHttp([]);
    });
    const service = createGiteaService({ runner, resolveTeaPath: async () => "tea" });
    const snapshots: ChangeRequestSnapshot[] = [];
    try {
      for (const origin of ["https://forge.example", "http://forge.example"]) {
        service.changeRequests!.observe(`${origin}/Org/Repo/pulls/1`, {
          async snapshot(snapshot) {
            snapshots.push(snapshot);
          },
          error(error) {
            throw error;
          },
        });
      }
      await vi.advanceTimersByTimeAsync(25);
      expect(snapshots.map(({ headSha }) => headSha).sort()).toEqual(["http", "https"]);
    } finally {
      service.dispose?.();
    }
  });

  it("keeps a sibling's pending status when a task only identifies the run", async () => {
    vi.useFakeTimers();
    const origin = "https://codeberg.org";
    const run = `${origin}/Org/Repo/actions/runs/100`;
    const { runner } = createFakeTeaRunner((args) => {
      if (args[0] === "login") {
        return { stdout: JSON.stringify([{ name: "cb", url: origin }]), stderr: "" };
      }
      const endpoint = args.at(-1)!;
      if (endpoint === "repos/Org/Repo/pulls/1") {
        return teaHttp({ number: 1, state: "open", head: { sha: "head" } });
      }
      if (endpoint.includes("/status?")) {
        return teaHttp({
          statuses: [
            { id: 1, status: "success", context: "build", target_url: `${run}/jobs/0` },
            { id: 2, status: "pending", context: "test", target_url: `${run}/jobs/1` },
          ],
        });
      }
      if (endpoint.includes("/actions/tasks?")) {
        return teaHttp({
          workflow_runs: [{ id: 55, head_sha: "head", status: "success", url: run }],
          total_count: 1,
        });
      }
      if (endpoint.includes("/actions/runs/100/jobs?")) {
        return teaHttp({ message: "Not found" }, { status: "404 Not Found" });
      }
      return teaHttp([]);
    });
    const service = createGiteaService({ runner, resolveTeaPath: async () => "tea" });
    const snapshots: ChangeRequestSnapshot[] = [];
    try {
      service.changeRequests!.observe(`${origin}/Org/Repo/pulls/1`, {
        async snapshot(snapshot) {
          snapshots.push(snapshot);
        },
        error(error) {
          throw error;
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(snapshots).toEqual([
        expect.objectContaining({
          checksState: "pending",
          checks: expect.arrayContaining([
            expect.objectContaining({ id: "status:2", state: "pending" }),
            expect.objectContaining({ id: "status:1", state: "passed" }),
          ]),
        }),
      ]);
    } finally {
      service.dispose?.();
    }
  });

  it("holds host slots until failed polls drain their already-started reads", async () => {
    vi.useFakeTimers();
    const origin = "https://codeberg.org";
    let finishFirstReads!: () => void;
    let finishLaterReads!: () => void;
    const firstReads = new Promise<void>((resolve) => {
      finishFirstReads = resolve;
    });
    const laterReads = new Promise<void>((resolve) => {
      finishLaterReads = resolve;
    });
    let actionRequests = 0;
    const { runner, calls } = createFakeTeaRunner(async (args) => {
      if (args[0] === "login")
        return { stdout: JSON.stringify([{ name: "cb", url: origin }]), stderr: "" };
      const endpoint = args.at(-1)!;
      const pr = /\/pulls\/(\d+)$/.exec(endpoint);
      if (pr) return teaHttp({ number: Number(pr[1]), state: "open", head: { sha: "head" } });
      if (endpoint.includes("/status?")) {
        return teaHttp({ message: "oops" }, { status: "500 Internal Server Error" });
      }
      if (endpoint.includes("/actions/tasks?")) {
        if (!endpoint.includes("page=1")) return teaHttp({ workflow_runs: [], total_count: 3 });
        actionRequests += 1;
        await (actionRequests <= 2 ? firstReads : laterReads);
        return teaHttp({
          workflow_runs: [{ id: 1, head_sha: "head", status: "running" }],
          total_count: 3,
        });
      }
      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });
    const service = createGiteaService({ runner, resolveTeaPath: async () => "tea" });
    const errors: unknown[] = [];
    const observer = {
      async snapshot() {
        throw new Error("Expected the poll to fail");
      },
      error: (error: unknown) => errors.push(error),
    };
    try {
      for (const number of [1, 2, 3, 4]) {
        service.changeRequests!.observe(`${origin}/Org/Repo/pulls/${number}`, observer);
      }
      await vi.advanceTimersByTimeAsync(25);
      expect(calls.filter(({ args }) => args.at(-1)?.includes("/actions/tasks?"))).toHaveLength(2);
      expect(errors).toEqual([]);
      finishFirstReads();
      await vi.advanceTimersByTimeAsync(0);
      expect(errors).toHaveLength(2);
      expect(actionRequests).toBe(4);
      finishLaterReads();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.filter(({ args }) => /actions\/tasks.*page=2/.test(args.at(-1) ?? ""))).toEqual(
        [],
      );
      expect(errors).toHaveLength(4);
      expect(errors).toEqual(
        Array.from({ length: 4 }, () => expect.objectContaining({ status: 500 })),
      );
    } finally {
      finishFirstReads();
      finishLaterReads();
      service.dispose?.();
    }
  });

  it("pauses the host when a sibling request fails before an Actions rate limit arrives", async () => {
    vi.useFakeTimers();
    const origin = "https://codeberg.org";
    const { runner, calls } = createFakeTeaRunner(async (args) => {
      if (args[0] === "login") {
        return { stdout: JSON.stringify([{ name: "cb", url: origin }]), stderr: "" };
      }
      const endpoint = args.at(-1)!;
      if (endpoint.endsWith("/pulls/1")) {
        return teaHttp({ number: 1, state: "open", head: { sha: "head" } });
      }
      if (endpoint.includes("/status?")) {
        return teaHttp({ message: "oops" }, { status: "500 Internal Server Error" });
      }
      if (endpoint.includes("/actions/tasks?")) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return teaHttp(
          { message: "slow down" },
          { status: "429 Too Many Requests", headers: { "Retry-After": "60" } },
        );
      }
      return teaHttp({ message: "no PR" }, { status: "404 Not Found" });
    });
    const service = createGiteaService({ runner, resolveTeaPath: async () => "tea" });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: unknown[] = [];
    const observer = {
      async snapshot(snapshot: ChangeRequestSnapshot) {
        snapshots.push(snapshot);
      },
      error: (error: unknown) => errors.push(error),
    };
    try {
      service.changeRequests!.observe(`${origin}/Org/Repo/pulls/1`, observer);
      await vi.advanceTimersByTimeAsync(75);
      expect(errors[0]).toMatchObject({ status: 500 });
      service.changeRequests!.observe(`${origin}/Org/Repo/pulls/2`, observer);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(calls.some(({ args }) => args.at(-1)?.endsWith("/pulls/2"))).toBe(false);
      expect(snapshots).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      // The first recovery poll hits another 429. The next window must
      // let the waiting watch start even though that first poll failed.
      expect(calls.some(({ args }) => args.at(-1)?.endsWith("/pulls/2"))).toBe(false);
      await vi.advanceTimersByTimeAsync(60_050);
      expect(calls.some(({ args }) => args.at(-1)?.endsWith("/pulls/2"))).toBe(true);
    } finally {
      service.dispose?.();
    }
  });

  it("uses cwd-free tea login list + tea api --login -i, combines statuses + Actions tasks + approval-held runs, and namespaces comments/reviews/inline", async () => {
    vi.useFakeTimers();
    const prUrl = "https://codeberg.org/Alice/App/pulls/12";
    const headSha = "sha-111";
    let loginListCalls = 0;

    const { runner, calls } = createFakeTeaRunner((args) => {
      if (args[0] === "login" && args[1] === "list") {
        loginListCalls += 1;
        return {
          stdout: JSON.stringify([
            { name: "cb-login", url: "https://codeberg.org", ssh_host: "codeberg.org" },
          ]),
          stderr: "",
        };
      }
      expect(args.slice(0, 4)).toEqual(["api", "--login", "cb-login", "-i"]);
      const endpoint = args[4] ?? "";
      if (endpoint === "repos/Alice/App/pulls/12") {
        return teaHttp({
          number: 12,
          state: "open",
          merged: false,
          html_url: prUrl,
          head: { sha: headSha },
        });
      }
      if (endpoint.startsWith(`repos/Alice/App/commits/${headSha}/status`)) {
        return teaHttp(
          {
            state: "pending",
            total_count: 3,
            statuses: [
              // Native status for run 100 job 501 owns the check result
              {
                id: 1,
                status: "success",
                context: "CI / build",
                target_url: "https://codeberg.org/Alice/App/actions/runs/100/jobs/501",
              },
              // Uncovered pending shadow for cross-repo approval-held run 101
              {
                id: 2,
                status: "pending",
                context: "CI / fork-e2e",
                target_url: "https://codeberg.org/Alice/App/actions/runs/101/jobs/502",
              },
              // External status with warning -> non-passing failure
              {
                id: 3,
                status: "warning",
                context: "external/lint",
                target_url: "https://ci.example.com/build/3",
              },
            ],
          },
          { headersOnStderr: true },
        );
      }
      if (endpoint.startsWith("repos/Alice/App/actions/tasks")) {
        return teaHttp({
          total_count: 2,
          workflow_runs: [
            // Older rerun of build workflow — must be collapsed
            {
              id: 500,
              name: "build",
              head_sha: headSha,
              run_number: 1,
              workflow_id: "ci.yml",
              status: "failure",
              url: "https://codeberg.org/Alice/App/actions/runs/99/jobs/500",
            },
            // Latest rerun of build workflow — passed
            {
              id: 501,
              name: "build",
              head_sha: headSha,
              run_number: 2,
              workflow_id: "ci.yml",
              status: "success",
              url: "https://codeberg.org/Alice/App/actions/runs/100/jobs/501",
            },
          ],
        });
      }
      if (endpoint.startsWith("repos/Alice/App/actions/runs/100/jobs?")) {
        return teaHttp({
          jobs: [
            {
              id: 501,
              name: "build",
              status: "completed",
              conclusion: "success",
              html_url: "https://codeberg.org/Alice/App/actions/runs/100/jobs/501",
            },
          ],
          total_count: 1,
        });
      }
      if (endpoint.startsWith("repos/Alice/App/actions/runs")) {
        return teaHttp({
          total_count: 1,
          workflow_runs: [
            {
              id: 101,
              head_sha: headSha,
              status: "waiting",
              need_approval: false,
              pull_requests: [{ head: { repo: { id: 999 } }, base: { repo: { id: 1 } } }],
            },
          ],
        });
      }
      if (endpoint.startsWith("repos/Alice/App/issues/12/comments")) {
        return teaHttp([
          { id: 10, type: "comment", html_url: `${prUrl}#issuecomment-10`, body: "Looks good" },
          { id: 11, type: "label", html_url: `${prUrl}#issuecomment-11`, body: "" },
        ]);
      }
      if (endpoint.startsWith("repos/Alice/App/pulls/12/reviews?")) {
        return teaHttp([
          {
            id: 20,
            state: "APPROVED",
            comments_count: 1,
            submitted_at: "2026-11-20T06:00:00Z",
            html_url: `${prUrl}#pullrequestreview-20`,
          },
          {
            id: 21,
            state: "PENDING",
            comments_count: 2,
            html_url: `${prUrl}#pullrequestreview-21`,
          },
          {
            id: 22,
            state: "REQUEST_REVIEW",
            comments_count: 0,
            html_url: `${prUrl}#pullrequestreview-22`,
          },
        ]);
      }
      if (endpoint.startsWith("repos/Alice/App/pulls/12/reviews/20/comments")) {
        return teaHttp([
          {
            id: 10, // Same numeric id as issue comment 10 — must NOT collide!
            html_url: `${prUrl}#issuecomment-999`,
            body: "Nit here",
          },
        ]);
      }
      throw new Error(`Unexpected tea endpoint (${PR2_WORKDIR_NOTE}): ${endpoint}`);
    });

    const service = createGiteaService({
      runner,
      resolveTeaPath: async () => "tea",
      resolveRemoteUrl: async () => {
        throw new Error("watch must not inspect local git remote");
      },
      watchPollMs: 10_000,
    });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: unknown[] = [];
    try {
      const release = service.changeRequests!.observe(prUrl, {
        async snapshot(s) {
          snapshots.push(s);
        },
        error(err) {
          errors.push(err);
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(errors).toEqual([]);
      expect(loginListCalls).toBe(1);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toEqual({
        state: "open",
        headSha,
        checksState: "failed",
        checks: [
          {
            id: "status:2",
            name: "CI / fork-e2e",
            state: "pending",
            url: "https://codeberg.org/Alice/App/actions/runs/101/jobs/502",
          },
          {
            id: "status:3",
            name: "external/lint",
            state: "failed",
            url: "https://ci.example.com/build/3",
          },
          {
            id: "action-job:501",
            name: "build",
            state: "passed",
            url: "https://codeberg.org/Alice/App/actions/runs/100/jobs/501",
          },
        ],
        reviewDecision: null,
        activity: [
          { id: "comment:10", kind: "comment", url: `${prUrl}#issuecomment-10` },
          { id: "review:20", kind: "review", url: `${prUrl}#pullrequestreview-20` },
          { id: "inline:10", kind: "inline comment", url: `${prUrl}#issuecomment-999` },
        ],
      });
      expect(calls.some((c) => c.args.includes("reviews/21/comments"))).toBe(false);
      release();
    } finally {
      service.dispose?.();
    }
  });

  it("inspects HTTP status codes directly instead of trusting exit code 0 (500, 401, 429, missing status)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const prUrl = "https://gitea.com/Org/Repo/pulls/5";
    let step = 0;
    let loginLists = 0;

    const { runner } = createFakeTeaRunner((args) => {
      if (args[0] === "login") {
        loginLists += 1;
        return {
          stdout: JSON.stringify([{ name: "gitea-main", url: "https://gitea.com" }]),
          stderr: "",
        };
      }
      step += 1;
      // Step 1: exit 0 with HTTP 500 on stdout -> must fail poll
      if (step === 1) {
        return teaHttp({ message: "boom" }, { status: "500 Internal Server Error" });
      }
      // Step 2: exit 0 with NO HTTP status line -> must fail poll
      if (step === 2) {
        return { stdout: JSON.stringify({ number: 5 }), stderr: "" };
      }
      // Step 3: exit 0 with HTTP 401 on stderr -> TeaAuthenticationError
      if (step === 3) {
        return teaHttp(
          { message: "token expired" },
          { status: "401 Unauthorized", headersOnStderr: true },
        );
      }
      // Step 4: exit 0 with HTTP 429 + Retry-After: 50 -> pauses host for 50s
      if (step === 4) {
        return teaHttp(
          { message: "slow down" },
          { status: "429 Too Many Requests", headers: { "Retry-After": "50" } },
        );
      }
      const endpoint = args[4] ?? "";
      if (endpoint === "repos/Org/Repo/pulls/5") {
        return teaHttp({
          number: 5,
          state: "open",
          merged: false,
          html_url: prUrl,
          head: { sha: "ok" },
        });
      }
      if (endpoint.includes("/status")) {
        return teaHttp({ state: "", statuses: [], total_count: 0 });
      }
      if (endpoint.includes("/actions/tasks")) {
        return teaHttp({ message: "Not Found" }, { status: "404 Not Found" });
      }
      return teaHttp([]);
    });

    const service = createGiteaService({
      runner,
      resolveTeaPath: async () => "tea",
      watchPollMs: 10_000,
    });
    const errors: unknown[] = [];
    const snapshots: ChangeRequestSnapshot[] = [];
    try {
      service.changeRequests!.observe(prUrl, {
        async snapshot(s) {
          snapshots.push(s);
        },
        error(err) {
          errors.push(err);
        },
      });

      // Step 1: HTTP 500 (exit 0)
      await vi.advanceTimersByTimeAsync(25);
      expect(errors).toHaveLength(1);
      expect(snapshots).toHaveLength(0);

      // Step 2: Missing HTTP status line (after 10s backoff)
      await vi.advanceTimersByTimeAsync(10_000);
      expect(errors).toHaveLength(2);

      // Step 3: HTTP 401 (after 20s backoff)
      await vi.advanceTimersByTimeAsync(20_000);
      expect(errors).toHaveLength(3);
      expect(errors[2]).toBeInstanceOf(TeaAuthenticationError);
      expect(loginLists).toBe(3);

      // Step 4: HTTP 429 (after 40s backoff) -> pauses host 50s
      await vi.advanceTimersByTimeAsync(40_000);
      expect(errors).toHaveLength(4);
      expect(loginLists).toBe(4);

      // Still paused at 49.999s
      await vi.advanceTimersByTimeAsync(49_999);
      expect(snapshots).toHaveLength(0);

      // Resumes at 50s and succeeds (tolerating 404 on /actions/tasks)
      await vi.advanceTimersByTimeAsync(1);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.headSha).toBe("ok");
    } finally {
      service.dispose?.();
    }
  });

  it("bounds review-comment fan-out, skips unchanged reviews on quiet polls, rejects mid-pagination headSha changes, and treats partial failures as stale", async () => {
    vi.useFakeTimers();
    const prUrl = "https://forgejo.example.org/Team/Core/pulls/4";
    let prReads = 0;
    let activeReviewFetches = 0;
    let maxReviewFetches = 0;
    let reviewCommentCalls = 0;
    let failReview3 = true;

    const { runner } = createFakeTeaRunner(async (args) => {
      if (args[0] === "login") {
        return {
          stdout: JSON.stringify([{ name: "fj", url: "https://forgejo.example.org" }]),
          stderr: "",
        };
      }
      const endpoint = args[4] ?? "";
      if (endpoint === "repos/Team/Core/pulls/4") {
        prReads += 1;
        // Poll 1: headSha shifts mid-pagination (read 1 -> sha-a, recheck read 2 -> sha-b)
        const sha = prReads === 1 ? "sha-a" : "sha-b";
        return teaHttp({ number: 4, state: "open", merged: false, html_url: prUrl, head: { sha } });
      }
      if (endpoint.includes("/commits/sha-a/status") && endpoint.includes("page=1")) {
        return teaHttp(
          {
            state: "pending",
            total_count: 1,
            statuses: [{ id: 1, status: "pending", context: "c1" }],
          },
          { headers: { "X-Total-Count": "2" } },
        );
      }
      if (endpoint.includes("/commits/sha-a/status") && endpoint.includes("page=2")) {
        return teaHttp(
          {
            state: "pending",
            total_count: 1,
            statuses: [{ id: 2, status: "success", context: "c2" }],
          },
          { headers: { "X-Total-Count": "2" } },
        );
      }
      if (endpoint.includes("/commits/sha-b/status")) {
        return teaHttp({ state: "success", total_count: 0, statuses: [] });
      }
      if (endpoint.includes("/actions/tasks")) {
        return teaHttp({ total_count: 0, workflow_runs: [] });
      }
      if (endpoint.includes("/issues/4/comments")) {
        return teaHttp([]);
      }
      if (endpoint.includes("/pulls/4/reviews?")) {
        const reviews = [];
        for (let id = 1; id <= 5; id += 1) {
          reviews.push({
            id,
            state: "COMMENT",
            comments_count: 1,
            submitted_at: "2026-11-20T06:00:00Z",
            html_url: `${prUrl}#pullrequestreview-${id}`,
          });
        }
        return teaHttp(reviews);
      }
      const reviewMatch = /\/pulls\/4\/reviews\/(\d+)\/comments/.exec(endpoint);
      if (reviewMatch) {
        const reviewId = Number(reviewMatch[1]);
        reviewCommentCalls += 1;
        activeReviewFetches += 1;
        maxReviewFetches = Math.max(maxReviewFetches, activeReviewFetches);
        await Promise.resolve();
        activeReviewFetches -= 1;
        if (reviewId === 3 && failReview3) {
          failReview3 = false;
          return teaHttp({ message: "502" }, { status: "502 Bad Gateway" });
        }
        return teaHttp([
          { id: reviewId * 100, html_url: `${prUrl}#issuecomment-${reviewId * 100}` },
        ]);
      }
      throw new Error(`Unexpected: ${endpoint}`);
    });

    const service = createGiteaService({
      runner,
      resolveTeaPath: async () => "tea",
      watchPollMs: 10_000,
    });
    const snapshots: ChangeRequestSnapshot[] = [];
    const errors: Error[] = [];
    const seen = new Set<string>();
    try {
      service.changeRequests!.observe(prUrl, {
        knownActivity: () => seen,
        async snapshot(s) {
          snapshots.push(s);
          for (const a of s.activity) seen.add(a.id);
        },
        error(err) {
          errors.push(err as Error);
        },
      });

      // Poll 1: fails due to mid-pagination headSha change
      await vi.advanceTimersByTimeAsync(25);
      expect(snapshots).toHaveLength(0);
      expect(errors[0]?.message).toMatch(/changed during pagination/i);

      // Poll 2: review 3 comments returns 502 -> entire poll fails (no partial seenActivity committed)
      await vi.advanceTimersByTimeAsync(10_000);
      expect(snapshots).toHaveLength(0);
      expect(errors).toHaveLength(2);

      // Poll 3: succeeds with bounded review-comment fan-out (<= 3 concurrent)
      await vi.advanceTimersByTimeAsync(20_000);
      expect(snapshots).toHaveLength(1);
      expect(maxReviewFetches).toBeLessThanOrEqual(3);
      expect(snapshots[0]!.activity.filter((a) => a.kind === "inline comment")).toHaveLength(5);
      const callsAfterBaseline = reviewCommentCalls;

      // Poll 4 (quiet): unchanged reviews are skipped — zero additional review-comment fetches
      await vi.advanceTimersByTimeAsync(10_000);
      expect(snapshots).toHaveLength(2);
      expect(reviewCommentCalls).toBe(callsAfterBaseline);
    } finally {
      service.dispose?.();
    }
  });

  it("routes gitea.com, codeberg.org, and probed self-hosted forgejo through ChangeRequestRouter", async () => {
    const forgeResolver = createForgeResolver({
      probeForge: async (host) => (host === "forgejo.internal" ? "forgejo" : null),
    });
    const router = createChangeRequestRouter({ forgeResolver });
    try {
      await expect(router.resolve("https://gitea.com/Org/Repo/pulls/3")).resolves.toEqual({
        forge: "gitea",
        url: "https://gitea.com/org/repo/pulls/3",
      });
      await expect(router.resolve("https://codeberg.org/Org/Repo/pulls/4/files")).resolves.toEqual({
        forge: "codeberg",
        url: "https://codeberg.org/org/repo/pulls/4",
      });
      await expect(
        router.resolve("https://forgejo.internal/Org/Repo/pulls/5/commits"),
      ).resolves.toEqual({
        forge: "forgejo",
        url: "https://forgejo.internal/org/repo/pulls/5",
      });
      expect(router.source("codeberg")?.describe("https://codeberg.org/Org/Repo/pulls/4")).toBe(
        "Org/Repo #4",
      );
      expect(router.source("forgejo")?.describe("https://forgejo.internal/Org/Repo/pulls/5")).toBe(
        "forgejo.internal/Org/Repo #5",
      );
    } finally {
      forgeResolver.dispose();
    }
  });

  it("keeps blocked need_approval Actions tasks pending and delivers digests across restart via ChangeRequestWatches", async () => {
    vi.useFakeTimers();
    const artifacts = join(import.meta.dirname, "../../../../.artifacts");
    await mkdir(artifacts, { recursive: true });
    const home = await mkdtemp(join(artifacts, "gitea-watch-"));
    const prUrl = "https://codeberg.org/org/repo/pulls/42";
    let phase = 1;

    const { runner } = createFakeTeaRunner((args) => {
      if (args[0] === "login") {
        return {
          stdout: JSON.stringify([{ name: "cb", url: "https://codeberg.org" }]),
          stderr: "",
        };
      }
      const endpoint = args[4] ?? "";
      if (endpoint === "repos/org/repo/pulls/42") {
        return teaHttp({
          number: 42,
          state: phase >= 3 ? "closed" : "open",
          merged: phase >= 3,
          html_url: prUrl,
          head: { sha: "sha-approval" },
        });
      }
      if (endpoint.includes("/commits/sha-approval/status")) {
        return teaHttp({ state: "", statuses: [], total_count: 0 });
      }
      if (endpoint.includes("/actions/tasks")) {
        return teaHttp({
          total_count: 1,
          workflow_runs: [
            {
              id: 700,
              name: "ci",
              head_sha: "sha-approval",
              run_number: 1,
              workflow_id: "ci.yml",
              status: phase === 1 ? "blocked" : "success",
              url: "https://codeberg.org/Org/Repo/actions/runs/70/jobs/700",
            },
          ],
        });
      }
      if (endpoint.includes("/actions/runs")) {
        return teaHttp({
          total_count: 1,
          workflow_runs: [
            {
              id: 70,
              run_number: 1,
              head_sha: "sha-approval",
              status: "blocked",
              need_approval: true,
            },
          ],
        });
      }
      if (endpoint.includes("/issues/42/comments")) {
        return teaHttp([]);
      }
      if (endpoint.includes("/pulls/42/reviews?")) {
        return teaHttp(
          phase >= 2
            ? [
                {
                  id: 88,
                  state: "APPROVED",
                  comments_count: 1,
                  submitted_at: "2026-11-20T07:00:00Z",
                  html_url: `${prUrl}#pullrequestreview-88`,
                },
              ]
            : [],
        );
      }
      if (endpoint.includes("/pulls/42/reviews/88/comments")) {
        return teaHttp([{ id: 901, html_url: `${prUrl}#issuecomment-901` }]);
      }
      throw new Error(`Unexpected: ${endpoint}`);
    });

    const createWatchHarness = () => {
      const gitea = createGiteaService({
        runner,
        resolveTeaPath: async () => "tea",
        watchPollMs: 10_000,
      });
      const forgeResolver = createForgeResolver({
        createService: (forge) => (forge === "codeberg" ? gitea : null),
      });
      const backgroundWork = new AgentBackgroundWorkStore();
      const turns: Array<{ recipientId: string; prompt: string }> = [];
      const messages = createAgentMessageDelivery({
        isRunning: () => false,
        subscribe: () => () => {},
        async dispatch(request) {
          turns.push({ recipientId: request.recipientId, prompt: String(request.prompt) });
          return "turn_started";
        },
        onError(error) {
          throw error;
        },
      });
      const watches = createChangeRequestWatches({
        router: createChangeRequestRouter({ forgeResolver }),
        paseoHome: home,
        logger: pino({ enabled: false }),
        isActive: async () => true,
        messages: () => messages,
        backgroundWork,
      });
      return {
        watches,
        backgroundWork,
        turns,
        async close() {
          await watches.close();
          await messages.close();
          forgeResolver.dispose();
        },
      };
    };

    let harness = createWatchHarness();
    try {
      await harness.watches.start();
      const subPromise = harness.watches.subscribe(
        "agent-1",
        "https://codeberg.org/Org/Repo/pulls/42/files",
      );
      await vi.advanceTimersByTimeAsync(25);
      const sub = await subPromise;
      expect(sub).toMatchObject({
        url: prUrl,
        state: "open",
        headSha: "sha-approval",
        checksState: "pending",
        checks: [{ id: "action:700", name: "ci", state: "pending" }],
        subscribed: true,
        stale: false,
      });
      await expect(harness.watches.subscribe("agent-1", prUrl)).resolves.toMatchObject({
        url: prUrl,
      });
      expect(harness.backgroundWork.list("agent-1")).toEqual([
        expect.objectContaining({ description: "org/repo #42", kind: "monitor" }),
      ]);
      const saved = JSON.parse(await readFile(join(home, "change-request-watches.json"), "utf8"));
      expect(saved).toEqual([expect.objectContaining({ forge: "codeberg", url: prUrl })]);

      // Restart daemon and verify watch restores and delivers passed checks + review + inline comment + merge
      await harness.close();
      phase = 2;
      harness = createWatchHarness();
      await harness.watches.start();
      expect(harness.backgroundWork.list("agent-1")).toEqual([
        expect.objectContaining({ description: "org/repo #42", kind: "monitor" }),
      ]);

      await vi.advanceTimersByTimeAsync(25);
      await vi.waitFor(async () => {
        const current = JSON.parse(
          await readFile(join(home, "change-request-watches.json"), "utf8"),
        ) as Array<{ seenActivity: string[] }>;
        expect(current[0]?.seenActivity).toContain("inline:901");
      });
      await vi.advanceTimersByTimeAsync(32_000);
      expect(harness.turns).toHaveLength(1);
      expect(harness.turns[0]!.prompt).toContain("Checks passed on sha-approval.");
      expect(harness.turns[0]!.prompt).toContain(`${prUrl}#pullrequestreview-88`);
      expect(harness.turns[0]!.prompt).toContain(`${prUrl}#issuecomment-901`);

      phase = 3;
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(harness.backgroundWork.list("agent-1")).toEqual([]));
      await vi.advanceTimersByTimeAsync(32_000);
      expect(harness.turns).toHaveLength(2);
      expect(harness.turns[1]!.prompt).toContain("Change request merged.");
    } finally {
      await harness.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reads 55 inline review comments in a single request and paginates >50 commit statuses via X-Total-Count", async () => {
    vi.useFakeTimers();
    const prUrl = "https://codeberg.org/Org/Repo/pulls/99";
    const headSha = "sha-large";
    let reviewCommentsCalls = 0;
    let actionRunsCalls = 0;

    const page1Statuses = [];
    for (let i = 1; i <= 50; i += 1) {
      page1Statuses.push({ id: i, status: "success", context: `ctx-${i}` });
    }
    const page2Statuses = [];
    for (let i = 51; i <= 60; i += 1) {
      page2Statuses.push({
        id: i,
        status: i === 55 ? "failure" : "success",
        context: `ctx-${i}`,
      });
    }
    const fiftyFiveInlineComments = [];
    for (let i = 1; i <= 55; i += 1) {
      fiftyFiveInlineComments.push({ id: i, html_url: `${prUrl}#issuecomment-${i}` });
    }

    const { runner } = createFakeTeaRunner((args) => {
      if (args[0] === "login") {
        return {
          stdout: JSON.stringify([{ name: "cb", url: "https://codeberg.org" }]),
          stderr: "",
        };
      }
      const endpoint = args[4] ?? "";
      if (endpoint === "repos/Org/Repo/pulls/99") {
        return teaHttp({
          number: 99,
          state: "open",
          merged: false,
          html_url: prUrl,
          head: { sha: headSha },
        });
      }
      if (endpoint.includes(`/commits/${headSha}/status`) && endpoint.includes("page=1")) {
        // Real Gitea sets body `total_count` to the page length (50) and puts 60 in X-Total-Count.
        return teaHttp(
          { state: "success", total_count: 50, statuses: page1Statuses },
          { headers: { "X-Total-Count": "60" } },
        );
      }
      if (endpoint.includes(`/commits/${headSha}/status`) && endpoint.includes("page=2")) {
        return teaHttp(
          { state: "failure", total_count: 10, statuses: page2Statuses },
          { headers: { "X-Total-Count": "60" } },
        );
      }
      if (endpoint.includes("/actions/tasks")) {
        return teaHttp({ total_count: 0, workflow_runs: [] });
      }
      if (endpoint.includes("/actions/runs")) {
        actionRunsCalls += 1;
        return teaHttp({ total_count: 0, workflow_runs: [] });
      }
      if (endpoint.includes("/issues/99/comments")) {
        return teaHttp([]);
      }
      if (endpoint.includes("/pulls/99/reviews?")) {
        return teaHttp([
          {
            id: 7,
            state: "COMMENT",
            comments_count: 55,
            submitted_at: "2026-11-20T08:00:00Z",
            html_url: `${prUrl}#pullrequestreview-7`,
          },
        ]);
      }
      if (endpoint === "repos/Org/Repo/pulls/99/reviews/7/comments") {
        reviewCommentsCalls += 1;
        return teaHttp(fiftyFiveInlineComments);
      }
      throw new Error(`Unexpected: ${endpoint}`);
    });

    const service = createGiteaService({
      runner,
      resolveTeaPath: async () => "tea",
      watchPollMs: 10_000,
    });
    const snapshots: ChangeRequestSnapshot[] = [];
    try {
      const release = service.changeRequests!.observe(prUrl, {
        async snapshot(s) {
          snapshots.push(s);
        },
        error(err) {
          throw err;
        },
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(snapshots).toHaveLength(1);
      expect(actionRunsCalls).toBe(0);
      expect(reviewCommentsCalls).toBe(1);
      expect(snapshots[0]!.checks).toHaveLength(60);
      expect(snapshots[0]!.checksState).toBe("failed");
      expect(snapshots[0]!.activity.filter((a) => a.kind === "inline comment")).toHaveLength(55);
      release();
    } finally {
      service.dispose?.();
    }
  });
});
