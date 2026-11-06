import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeQuotaResponse, discover, fetchUsage } from "./usage.js";

function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return bytes;
}

function lengthDelimited(field: number, payload: number[]): number[] {
  return [...varint((field << 3) | 2), ...varint(payload.length), ...payload];
}

function numberField(field: number, value: number): number[] {
  return [...varint(field << 3), ...varint(value)];
}

function text(value: string): number[] {
  return [...Buffer.from(value, "utf8")];
}

function responseFixture(input: {
  planName?: string;
  dailyRemaining?: number;
  weeklyRemaining?: number;
  dailyReset?: number;
  weeklyReset?: number;
}): Uint8Array {
  const planStatus = [
    ...lengthDelimited(1, lengthDelimited(2, text(input.planName ?? "Max"))),
    ...numberField(14, input.dailyRemaining ?? 100),
    ...numberField(15, input.weeklyRemaining ?? 99),
    ...numberField(17, input.dailyReset ?? 1_792_915_200),
    ...numberField(18, input.weeklyReset ?? 1_792_915_200),
  ];
  return Uint8Array.from([
    ...lengthDelimited(1, lengthDelimited(13, planStatus)),
    ...lengthDelimited(2, lengthDelimited(2, text(input.planName ?? "Max"))),
  ]);
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function credentialsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "devin-usage-"));
  tempDirs.push(dir);
  const locator = join(dir, "credentials.toml");
  writeFileSync(
    locator,
    [
      'windsurf_api_key = "devin-session-token$test"',
      'api_server_url = "https://server.example"',
      "",
    ].join("\n"),
  );
  return locator;
}

describe("decodeQuotaResponse", () => {
  it("reads the plan name, remaining percentages and reset times", () => {
    expect(
      decodeQuotaResponse(responseFixture({ dailyRemaining: 100, weeklyRemaining: 99 })),
    ).toEqual({
      planName: "Max",
      dailyRemainingPct: 100,
      weeklyRemainingPct: 99,
      dailyResetsAt: "2026-10-25T08:00:00.000Z",
      weeklyResetsAt: "2026-10-25T08:00:00.000Z",
    });
  });

  it("clamps out-of-range percentages and tolerates missing windows", () => {
    expect(decodeQuotaResponse(responseFixture({ dailyRemaining: 120 })).dailyRemainingPct).toBe(
      100,
    );
    expect(decodeQuotaResponse(new Uint8Array()).dailyRemainingPct).toBeNull();
  });
});

describe("fetchUsage", () => {
  it("calls GetUserStatus with the login and turns the proto into daily and weekly windows", async () => {
    const locator = credentialsFile();
    let url = "";
    let init: RequestInit | undefined;
    const fetchApi = vi.fn(async (input: string | URL | Request, request?: RequestInit) => {
      url = String(input);
      init = request;
      return new Response(responseFixture({ dailyRemaining: 100, weeklyRemaining: 98 }), {
        status: 200,
        headers: { "content-type": "application/proto" },
      });
    }) as unknown as typeof fetch;

    const report = await fetchUsage({ store: "file", locator }, fetchApi);

    expect(report).toMatchObject({
      status: "available",
      planLabel: "Max",
    });
    expect(report.status === "available" ? report.windows : []).toMatchObject([
      { id: "daily", label: "Daily limit", usedPct: 0, remainingPct: 100, tone: "ok" },
      { id: "weekly", label: "Weekly limit", usedPct: 2, remainingPct: 98, tone: "ok" },
    ]);
    expect(url).toBe(
      "https://server.example/exa.seat_management_pb.SeatManagementService/GetUserStatus",
    );
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["Content-Type"]).toBe("application/proto");
    expect(headers?.Authorization).toMatch(/^Basic /);
  });

  it("refuses a non-HTTPS API server before sending the login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devin-usage-"));
    tempDirs.push(dir);
    const locator = join(dir, "credentials.toml");
    writeFileSync(
      locator,
      [
        'windsurf_api_key = "devin-session-token$test"',
        'api_server_url = "http://server.example"',
      ].join("\n"),
    );
    const fetchApi = vi.fn() as unknown as typeof fetch;
    await expect(fetchUsage({ store: "file", locator }, fetchApi)).rejects.toThrow(/not HTTPS/);
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("maps a rejected login to an unavailable account", async () => {
    const locator = credentialsFile();
    const fetchApi = vi.fn(
      async () => new Response("", { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(fetchUsage({ store: "file", locator }, fetchApi)).resolves.toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status: 401 },
    });
  });
});

describe("discover", () => {
  it("prefers an environment login over credential files", async () => {
    vi.stubEnv("DEVIN_API_KEY", "devin-session-token$env");
    await expect(discover()).resolves.toEqual([
      { key: "default", input: { store: "env", locator: "DEVIN_API_KEY" } },
    ]);
  });
});
