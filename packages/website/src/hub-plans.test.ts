import { describe, expect, it } from "vitest";
// The documented `GET /api/billing/plans` response, copied from getpaseo/hub docs/public-api.md.
import documentedResponse from "./hub-plans.fixture.json" with { type: "json" };
import { parseHubPlansResponse } from "./hub-plans";

describe("parseHubPlansResponse", () => {
  it("reads Free and Pro, their monthly prices, and the figures each includes", () => {
    const plans = parseHubPlansResponse(documentedResponse);

    expect(plans.free.name).toBe("Free");
    expect(plans.free.included).toEqual({ seats: 1, executionsPerMonth: 50 });
    expect(plans.free.price.unitAmount).toBe(0);
    expect(plans.free.features).toEqual([
      { key: "daemon-location", label: "Daemons run on your machines", tooltip: null },
    ]);

    expect(plans.paid.slug).toBe("hosted");
    expect(plans.paid.name).toBe("Pro");
    expect(plans.paid.included).toEqual({ seats: null, executionsPerMonth: null });
    expect(plans.paid.price.unitAmount).toBe(1500);
    expect(plans.paid.price.currency).toBe("eur");
    expect(plans.paid.billing.unit.label).toBe("seat");
  });

  it("rejects a catalog that omits the free plan", () => {
    const withoutFree = {
      plans: documentedResponse.plans.filter((plan) => plan.slug !== "free"),
    };

    expect(() => parseHubPlansResponse(withoutFree)).toThrow('Hub plan "free" is unavailable');
  });

  it("rejects the pre-included plan shape instead of rendering a plan with no figures", () => {
    const withoutIncluded = {
      plans: documentedResponse.plans.map(({ included: _included, ...plan }) => plan),
    };

    expect(() => parseHubPlansResponse(withoutIncluded)).toThrow(
      "Invalid Hub plan included figures",
    );
  });

  it("rejects a plan that has no monthly price", () => {
    const annualOnly = structuredClone(documentedResponse);
    for (const plan of annualOnly.plans) {
      if (plan.slug !== "hosted") continue;
      for (const price of plan.prices) price.interval = "annual";
    }

    expect(() => parseHubPlansResponse(annualOnly)).toThrow(
      'Hub plan "hosted" has no monthly price',
    );
  });
});
