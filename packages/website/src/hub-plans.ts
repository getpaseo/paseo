import { createServerFn } from "@tanstack/react-start";

const HUB_PLANS_URL =
  import.meta.env.VITE_HUB_PLANS_URL ?? "https://hub.paseo.sh/api/billing/plans";

export interface HubBillingPlan {
  slug: string;
  name: string;
  billing: {
    model: "per_unit";
    unit: { key: string; label: string };
  };
  features: Array<{ key: string; label: string; tooltip: string | null }>;
  prices: Array<{
    interval: "monthly" | "annual";
    intervalCount: number;
    unitAmount: number;
    currency: string;
    tooltip: string | null;
  }>;
}

export function parseHubPlansResponse(value: unknown): HubBillingPlan[] {
  if (!isRecord(value) || !Array.isArray(value["plans"])) throw new Error("Invalid Hub plans");
  return value["plans"].map(parsePlan);
}

export const getHubPlans = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const response = await fetch(HUB_PLANS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return [];
    return parseHubPlansResponse(await response.json());
  } catch {
    return [];
  }
});

function parsePlan(value: unknown): HubBillingPlan {
  if (!isRecord(value) || typeof value["slug"] !== "string" || typeof value["name"] !== "string")
    throw new Error("Invalid Hub plan");
  const billing = parseBilling(value["billing"]);
  if (!Array.isArray(value["features"]) || !Array.isArray(value["prices"]))
    throw new Error("Invalid Hub plan presentation");
  return {
    slug: value["slug"],
    name: value["name"],
    billing,
    features: value["features"].map(parseFeature),
    prices: value["prices"].map(parsePrice),
  };
}

function parseBilling(value: unknown): HubBillingPlan["billing"] {
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

function parseFeature(value: unknown): HubBillingPlan["features"][number] {
  if (
    !isRecord(value) ||
    typeof value["key"] !== "string" ||
    typeof value["label"] !== "string" ||
    !isNullableString(value["tooltip"])
  )
    throw new Error("Invalid Hub plan feature");
  return { key: value["key"], label: value["label"], tooltip: value["tooltip"] };
}

function parsePrice(value: unknown): HubBillingPlan["prices"][number] {
  if (
    !isRecord(value) ||
    (value["interval"] !== "monthly" && value["interval"] !== "annual") ||
    typeof value["intervalCount"] !== "number" ||
    typeof value["unitAmount"] !== "number" ||
    typeof value["currency"] !== "string" ||
    !isNullableString(value["tooltip"])
  )
    throw new Error("Invalid Hub plan price");
  return {
    interval: value["interval"],
    intervalCount: value["intervalCount"],
    unitAmount: value["unitAmount"],
    currency: value["currency"],
    tooltip: value["tooltip"],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
