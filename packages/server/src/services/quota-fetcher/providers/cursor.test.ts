import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { normalizeCursorPlanUsage, readCursorTokenFromAuthJson } from "./cursor.js";

describe("readCursorTokenFromAuthJson", () => {
  test("reads accessToken from cursor-agent auth.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-cursor-auth-"));
    await mkdir(join(home, ".config", "cursor"), { recursive: true });
    await writeFile(
      join(home, ".config", "cursor", "auth.json"),
      JSON.stringify({ accessToken: "cursor_cli_token", refreshToken: "refresh" }),
    );

    await expect(readCursorTokenFromAuthJson(home)).resolves.toBe("cursor_cli_token");
  });

  test("returns null when auth.json is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-cursor-auth-missing-"));
    await expect(readCursorTokenFromAuthJson(home)).resolves.toBeNull();
  });

  test("returns null when accessToken is empty", async () => {
    const home = await mkdtemp(join(tmpdir(), "paseo-cursor-auth-empty-"));
    await mkdir(join(home, ".config", "cursor"), { recursive: true });
    await writeFile(
      join(home, ".config", "cursor", "auth.json"),
      JSON.stringify({ accessToken: "" }),
    );

    await expect(readCursorTokenFromAuthJson(home)).resolves.toBeNull();
  });
});

describe("normalizeCursorPlanUsage", () => {
  test("attributes API dollars from apiPercentUsed, matching the Ultra dashboard", () => {
    const normalized = normalizeCursorPlanUsage(
      {
        totalSpend: 49828,
        includedSpend: 40000,
        bonusSpend: 9828,
        remaining: null,
        limit: 40000,
        autoPercentUsed: 15.114,
        apiPercentUsed: 39.2,
        totalPercentUsed: 19.9312,
      },
      "2026-08-21T09:02:10.000Z",
    );

    // 39.2% of the $400 API included rail — not includedSpend ($400) or bonus (~$98).
    expect(normalized.balances).toEqual([
      expect.objectContaining({
        id: "plan_usage",
        label: "API",
        used: 156.8,
        remaining: 243.2,
        limit: 400,
        unit: "usd",
        tone: "ok",
        resetsAt: "2026-08-21T09:02:10.000Z",
      }),
    ]);
    expect(normalized.windows.map((window) => window.id)).toEqual([
      "total_usage",
      "auto_usage",
      "api_usage",
    ]);
    expect(normalized.windows).toEqual([
      expect.objectContaining({ id: "total_usage", usedPct: 19.9312 }),
      expect.objectContaining({ id: "auto_usage", label: "First-party models", usedPct: 15.114 }),
      expect.objectContaining({ id: "api_usage", usedPct: 39.2 }),
    ]);
    expect(normalized.details).toEqual([
      { id: "bonus_spend", label: "Bonus usage", value: "$98.28" },
    ]);
  });

  test("falls back to includedSpend when percent fields are absent", () => {
    const normalized = normalizeCursorPlanUsage(
      {
        totalSpend: 1500,
        includedSpend: 1000,
        bonusSpend: 500,
        remaining: 2500,
        limit: 4000,
      },
      null,
    );

    expect(normalized.balances[0]).toMatchObject({
      used: 10,
      remaining: 25,
      limit: 40,
      tone: "ok",
    });
    expect(normalized.windows).toEqual([]);
    expect(normalized.details).toEqual([
      { id: "bonus_spend", label: "Bonus usage", value: "$5.00" },
    ]);
  });
});
