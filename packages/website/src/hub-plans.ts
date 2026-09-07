import { createServerFn } from "@tanstack/react-start";

const HUB_PLANS_URL =
  import.meta.env.VITE_HUB_PLANS_URL ?? "https://hub.paseo.sh/api/billing/plans";

export interface HubHostedOffer {
  name: string;
  billing: {
    model: "per_unit";
    unit: { key: string; label: string };
  };
  features: Array<{ key: string; label: string; tooltip: string | null }>;
  price: HubBillingPrice & { interval: "monthly" };
}

interface HubBillingPrice {
  interval: "monthly" | "annual";
  intervalCount: number;
  unitAmount: number;
  currency: string;
  tooltip: string | null;
}

interface HubBillingPlan extends Omit<HubHostedOffer, "price"> {
  slug: string;
  prices: HubBillingPrice[];
}

export function parseHostedOfferResponse(value: unknown): HubHostedOffer {
  if (!isRecord(value) || !Array.isArray(value["plans"])) throw new Error("Invalid Hub plans");
  const hosted = value["plans"].map(parsePlan).find((plan) => plan.slug === "hosted");
  const price = hosted?.prices.find(isMonthlyPrice);
  if (hosted === undefined || price === undefined) throw new Error("Hosted Hub is unavailable");
  return {
    name: hosted.name,
    billing: hosted.billing,
    features: hosted.features,
    price,
  };
}

export const getHostedOffer = createServerFn({ method: "GET" }).handler(async () => {
  const response = await fetch(HUB_PLANS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Hub plans request failed (${response.status})`);
  return parseHostedOfferResponse(await response.json());
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

function parseBilling(value: unknown): HubHostedOffer["billing"] {
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

function parseFeature(value: unknown): HubHostedOffer["features"][number] {
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
