import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { discover, fetchUsage, identify } from "./usage.js";

import { inputSchema } from "../shared/input.js";

let fixtureDirectory: string;
let fixturePath: string;
beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "go-default-"));
  fixturePath = join(fixtureDirectory, "auth.json");
  await writeFile(
    fixturePath,
    JSON.stringify({ "opencode-go": { type: "api", key: "fixture-secret" } }),
  );
});
afterEach(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

test("discovery input rejects an explicit API key", () => {
  expect(inputSchema.safeParse({ apiKey: "unused" }).success).toBe(false);
  expect(inputSchema.parse({})).toEqual({});
});

const upstreamResponse = {
  usage: {
    rolling: { status: "ok", percent: 21, resetsAt: "2026-09-26T20:00:00.000Z" },
    weekly: { status: "ok", percent: 42, resetsAt: "2026-09-28T00:00:00.000Z" },
    monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-10-01T00:00:00.000Z" },
  },
};

test("discovers and fetches the default key from read-only auth.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-go-usage-"));
  const path = join(directory, "auth.json");
  const content = JSON.stringify({ "opencode-go": { type: "api", key: "fixture-key" } });
  try {
    await writeFile(path, content);
    expect(await discover(path)).toEqual([{}]);
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchApi = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return Response.json(upstreamResponse);
    };
    const report = await fetchUsage({}, fetchApi as typeof fetch, path);
    expect((await identify({}, path))?.key).toMatch(/^[a-f0-9]{64}$/);
    expect(requests).toEqual([
      { url: "https://opencode.ai/zen/go/v1/usage", authorization: "Bearer fixture-key" },
    ]);
    expect(report.status).toBe("available");
    expect(report.windows.map((window) => [window.id, window.usedPct, window.resetsAt])).toEqual([
      ["rolling", 21, "2026-09-26T20:00:00.000Z"],
      ["weekly", 42, "2026-09-28T00:00:00.000Z"],
      ["monthly", 100, "2026-10-01T00:00:00.000Z"],
    ]);
    // The rolling window's length is not reported, so its percent stands without a name.
    expect(report.windows.map((window) => window.shortLabel)).toEqual(["", "wk", "mo"]);
    // The current upstream endpoint returns windows only; do not invent balances.
    expect(report.balances).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("omits default discovery when auth.json lacks an OpenCode Go API key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-go-usage-"));
  const path = join(directory, "auth.json");
  try {
    await writeFile(path, JSON.stringify({ openai: { type: "oauth", access: "other-token" } }));
    expect(await discover(path)).toEqual([]);
    const report = await fetchUsage(
      {},
      async () => {
        throw new Error("must not fetch");
      },
      path,
    );
    expect(report).toEqual({ status: "unavailable", windows: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([401, 403])("maps HTTP %i to unavailable", async (status) => {
  const report = await fetchUsage({}, async () => new Response(null, { status }), fixturePath);
  expect(report.status).toBe("unavailable");
  expect(report.windows).toEqual([]);
});

test("identify returns a key when fetch finds OpenCode Go credentials", async () => {
  let requested = false;
  await fetchUsage(
    {},
    async () => {
      requested = true;
      return new Response(null, { status: 401 });
    },
    fixturePath,
  );
  expect(requested).toBe(true);
  const identity = await identify({}, fixturePath);
  expect(identity?.key).toMatch(/^[a-f0-9]{64}$/);
  expect(identity?.key).not.toBe("fixture-secret");
  expect(await identify({}, fixturePath)).toEqual(identity);
});
