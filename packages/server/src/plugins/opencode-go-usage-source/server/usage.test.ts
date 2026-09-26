import { expect, test } from "vitest";
import { fetchUsage } from "./usage.js";

test("reads the OpenCode Go usage windows", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetchApi = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: String(url), authorization: headers.get("Authorization") });
    return Response.json({
      rollingUsage: { usagePercent: 21, resetInSec: 1800 },
      weeklyUsage: { usagePercent: 42 },
      monthlyUsage: { usagePercent: 63 },
    });
  };
  const report = await fetchUsage({ apiKey: "fixture-key" }, fetchApi as typeof fetch);
  expect(requests).toEqual([
    { url: "https://opencode.ai/zen/go/v1/usage", authorization: "Bearer fixture-key" },
  ]);
  expect(report.status).toBe("available");
  expect(report.windows.map((window) => [window.id, window.usedPct, window.headline])).toEqual([
    ["rolling", 21, true],
    ["weekly", 42, undefined],
    ["monthly", 63, undefined],
  ]);
});

test("treats rejected credentials as unavailable", async () => {
  const report = await fetchUsage(
    { apiKey: "fixture-key" },
    async () => new Response(null, { status: 401 }),
  );
  expect(report.status).toBe("unavailable");
  expect(report.windows).toEqual([]);
});
