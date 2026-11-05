import { expect, it } from "vitest";
import { fetchUsage } from "./usage.js";

const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const ME_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe";
const PLAN_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo";

// Shaped like a live Enterprise login's responses; identities and amounts are made up.
// Without includePooledUsage the server reports only placeholder billing dates.
const enterprisePlainUsage = {
  billingCycleStart: "1793900000000",
  billingCycleEnd: "1793900000000",
  displayThreshold: 100,
};
const enterprisePooledUsage = {
  billingCycleStart: "1793491200000",
  billingCycleEnd: "1796083200000",
  planUsage: {
    remainingBonus: false,
    bonusTooltip:
      "We work with model providers to give you free usage beyond what you've purchased. Amounts may vary.",
    autoPercentUsed: 0,
    apiPercentUsed: 0,
    totalPercentUsed: 0,
  },
  spendLimitUsage: {
    totalSpend: 1500000,
    pooledLimit: "10000000",
    pooledUsed: 1500000,
    pooledRemaining: "8500000",
    limitType: "team",
    overallLimit: 40000,
    overallUsed: 10000,
    overallRemaining: 30000,
  },
  displayThreshold: 200,
  displayMessage: "You've used 25% of your included usage",
  autoBucketModels: ["default", "composer-2"],
};
const enterpriseMe = {
  authId: "auth-fixture",
  userId: 1001,
  email: "user@example.com",
  teamId: 2002,
  isEnterpriseUser: true,
  teamName: "Example Team",
  isTeamAdmin: false,
};

interface RecordedRequest {
  url: string;
  body: unknown;
}

function cursorApi(routes: {
  plain: unknown;
  pooled?: () => Response;
  me?: unknown;
  planName?: string;
}): {
  fetchApi: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchApi = (async (url: string | URL | Request, init?: RequestInit) => {
    const body: unknown = JSON.parse(String(init?.body));
    requests.push({ url: String(url), body });
    if (String(url) === PLAN_URL)
      return Response.json({ planInfo: { planName: routes.planName ?? "Enterprise" } });
    if (String(url) === ME_URL) return Response.json(routes.me);
    if (String(url) !== USAGE_URL) throw new Error(`Unmocked fetch: ${String(url)}`);
    if (JSON.stringify(body) === "{}") return Response.json(routes.plain);
    if (!routes.pooled) throw new Error("Unexpected pooled usage request");
    return routes.pooled();
  }) as typeof fetch;
  return { fetchApi, requests };
}

const lookup = { platform: "darwin" as const, readKeychainToken: async () => "fixture-token" };
const input = { store: "keychain", locator: "cursor-access-token" } as const;

it("reports an Enterprise login's personal spend cap and team pool", async () => {
  const { fetchApi, requests } = cursorApi({
    plain: enterprisePlainUsage,
    me: enterpriseMe,
    pooled: () => Response.json(enterprisePooledUsage),
  });

  const report = await fetchUsage(input, fetchApi, lookup);

  expect(requests).toEqual([
    { url: PLAN_URL, body: {} },
    { url: USAGE_URL, body: {} },
    { url: ME_URL, body: {} },
    { url: USAGE_URL, body: { includePooledUsage: true } },
  ]);
  // The all-zero included-usage pools are omitted: the spend limits are what bind.
  expect(report).toEqual({
    status: "available",
    planLabel: "Enterprise",
    windows: [
      {
        id: "personal_spend",
        label: "Personal spend",
        usedPct: 25,
        remainingPct: 75,
        resetsAt: "2026-12-01T00:00:00.000Z",
        summary: true,
        tone: "ok",
      },
      {
        id: "team_pool",
        label: "Team pool",
        usedPct: 15,
        remainingPct: 85,
        resetsAt: "2026-12-01T00:00:00.000Z",
        tone: "ok",
      },
    ],
    balances: [],
    details: [],
  });
});

it("keeps included-usage pools for an Enterprise login once they report usage", async () => {
  const { fetchApi } = cursorApi({
    plain: enterprisePlainUsage,
    me: enterpriseMe,
    pooled: () =>
      Response.json({
        ...enterprisePooledUsage,
        planUsage: { autoPercentUsed: 4, apiPercentUsed: 0, totalPercentUsed: 3 },
      }),
  });

  const report = await fetchUsage(input, fetchApi, lookup);

  expect(report.status === "available" && report.windows.map((window) => window.id)).toEqual([
    "personal_spend",
    "team_pool",
    "plan_usage",
    "cursor_usage",
    "third_party_usage",
  ]);
  // Only the personal cap is the default summary.
  expect(
    report.status === "available" &&
      report.windows.filter((window) => window.summary).map((window) => window.id),
  ).toEqual(["personal_spend"]);
});

it("shows only the personal cap when the team pool has no limit", async () => {
  const {
    pooledLimit: _limit,
    pooledUsed: _used,
    ...spendLimitUsage
  } = enterprisePooledUsage.spendLimitUsage;
  const { fetchApi } = cursorApi({
    plain: enterprisePlainUsage,
    me: enterpriseMe,
    pooled: () => Response.json({ ...enterprisePooledUsage, spendLimitUsage }),
  });

  const report = await fetchUsage(input, fetchApi, lookup);

  expect(report.status === "available" && report.windows.map((window) => window.id)).toEqual([
    "personal_spend",
  ]);
});

it("does not ask for pooled usage when a login without plan usage is not Enterprise", async () => {
  const { fetchApi, requests } = cursorApi({
    plain: enterprisePlainUsage,
    me: { ...enterpriseMe, isEnterpriseUser: false },
    planName: "Free",
  });

  const report = await fetchUsage(input, fetchApi, lookup);

  expect(requests.map((request) => request.url)).toEqual([PLAN_URL, USAGE_URL, ME_URL]);
  expect(report).toEqual({
    status: "available",
    planLabel: "Free",
    windows: [],
    balances: [],
    details: [],
  });
});

it("fails the fetch when Cursor rejects the pooled usage request", async () => {
  const { fetchApi } = cursorApi({
    plain: enterprisePlainUsage,
    me: enterpriseMe,
    pooled: () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
  });

  await expect(fetchUsage(input, fetchApi, lookup)).rejects.toThrow(
    "Cursor usage API returned 502",
  );
});

it("sends one empty usage request for a login that reports plan usage", async () => {
  const { fetchApi, requests } = cursorApi({
    plain: { ...enterprisePlainUsage, planUsage: { totalPercentUsed: 0 } },
  });

  await fetchUsage(input, fetchApi, lookup);

  expect(requests).toEqual([
    { url: PLAN_URL, body: {} },
    { url: USAGE_URL, body: {} },
  ]);
});
