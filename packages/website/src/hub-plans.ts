import { createServerFn } from "@tanstack/react-start";

const HUB_PLANS_URL =
  import.meta.env.VITE_HUB_PLANS_URL ?? "https://hub.paseo.sh/api/billing/plans";

/** The two catalog slugs the page renders. `hosted` is displayed as whatever `name` says. */
const FREE_SLUG = "free";
const PAID_SLUG = "hosted";

export interface HubPlanOffer {
  slug: string;
  name: string;
  billing: {
    model: "per_unit";
    unit: { key: string; label: string };
  };
  /** What the plan gives, as figures. `null` is unlimited. */
  included: { seats: number | null; executionsPerMonth: number | null };
  features: Array<{ key: string; label: string; tooltip: string | null }>;
  price: HubBillingPrice & { interval: "monthly" };
}

export interface HubPlans {
  free: HubPlanOffer;
  paid: HubPlanOffer;
}

interface HubBillingPrice {
  interval: "monthly" | "annual";
  intervalCount: number;
  unitAmount: number;
  currency: string;
  tooltip: string | null;
}

interface HubBillingPlan extends Omit<HubPlanOffer, "price"> {
  prices: HubBillingPrice[];
}

export function parseHubPlansResponse(value: unknown): HubPlans {
  if (!isRecord(value) || !Array.isArray(value["plans"])) throw new Error("Invalid Hub plans");
  const plans = value["plans"].map(parsePlan);
  return {
    free: selectOffer(plans, FREE_SLUG),
    paid: selectOffer(plans, PAID_SLUG),
  };
}

export const getHubPlans = createServerFn({ method: "GET" }).handler(async () => {
  const response = await fetch(HUB_PLANS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Hub plans request failed (${response.status})`);
  return parseHubPlansResponse(await response.json());
});

function selectOffer(plans: readonly HubBillingPlan[], slug: string): HubPlanOffer {
  const plan = plans.find((candidate) => candidate.slug === slug);
  if (plan === undefined) throw new Error(`Hub plan "${slug}" is unavailable`);
  const price = plan.prices.find(isMonthlyPrice);
  if (price === undefined) throw new Error(`Hub plan "${slug}" has no monthly price`);
  return {
    slug: plan.slug,
    name: plan.name,
    billing: plan.billing,
    included: plan.included,
    features: plan.features,
    price,
  };
}

function parsePlan(value: unknown): HubBillingPlan {
  if (!isRecord(value) || typeof value["slug"] !== "string" || typeof value["name"] !== "string")
    throw new Error("Invalid Hub plan");
  const billing = parseBilling(value["billing"]);
  const included = parseIncluded(value["included"]);
  if (!Array.isArray(value["features"]) || !Array.isArray(value["prices"]))
    throw new Error("Invalid Hub plan presentation");
  return {
    slug: value["slug"],
    name: value["name"],
    billing,
    included,
    features: value["features"].map(parseFeature),
    prices: value["prices"].map(parsePrice),
  };
}

function parseBilling(value: unknown): HubPlanOffer["billing"] {
  if (!isRecord(value) || value["model"] !== "per_unit" || !isRecord(value["unit"]))
    throw new Error("Invalid Hub plan billing model");
  const unit = value["unit"];
  if (typeof unit["key"] !== "string" || typeof unit["label"] !== "string")
    throw new Error("Invalid Hub plan billing unit");
  return {
    model: "per_unit",
    unit: { key: unit["key"], label: unit["label"] },
  };
}

function parseIncluded(value: unknown): HubPlanOffer["included"] {
  if (
    !isRecord(value) ||
    !isNullableCount(value["seats"]) ||
    !isNullableCount(value["executionsPerMonth"])
  )
    throw new Error("Invalid Hub plan included figures");
  return { seats: value["seats"], executionsPerMonth: value["executionsPerMonth"] };
}

function parseFeature(value: unknown): HubPlanOffer["features"][number] {
  if (
    !isRecord(value) ||
    typeof value["key"] !== "string" ||
    typeof value["label"] !== "string" ||
    !isNullableString(value["tooltip"])
  )
    throw new Error("Invalid Hub plan feature");
  return { key: value["key"], label: value["label"], tooltip: value["tooltip"] };
}

function parsePrice(value: unknown): HubBillingPrice {
  const intervalCount = isRecord(value) ? value["intervalCount"] : undefined;
  if (
    !isRecord(value) ||
    (value["interval"] !== "monthly" && value["interval"] !== "annual") ||
    typeof intervalCount !== "number" ||
    !Number.isInteger(intervalCount) ||
    intervalCount < 1 ||
    typeof value["unitAmount"] !== "number" ||
    typeof value["currency"] !== "string" ||
    !isNullableString(value["tooltip"])
  )
    throw new Error("Invalid Hub plan price");
  return {
    interval: value["interval"],
    intervalCount,
    unitAmount: value["unitAmount"],
    currency: value["currency"],
    tooltip: value["tooltip"],
  };
}

function isMonthlyPrice(
  price: HubBillingPrice,
): price is HubBillingPrice & { interval: "monthly" } {
  return price.interval === "monthly";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}
