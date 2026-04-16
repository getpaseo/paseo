import { db } from "./db";
import { eq, and } from "drizzle-orm";
import { planFeature, member } from "@/db/schema";
import { getOrganizationBillingSummary, getUserBillingSummary } from "@/lib/billing";

async function getFeaturesForPlan(planId: string): Promise<Record<string, string>> {
  const features = await db.query.planFeature.findMany({
    where: eq(planFeature.planId, planId),
  });

  const result: Record<string, string> = {};
  for (const f of features) {
    result[f.featureKey] = f.value;
  }
  return result;
}

export async function getUserPlanSummary(userId: string): Promise<{
  planId: string;
  subscriptionStatus: string;
}> {
  const summary = await getUserBillingSummary(userId);
  return {
    planId: summary.planId,
    subscriptionStatus: summary.subscriptionStatus,
  };
}

export async function getOrgFeatures(orgId: string): Promise<Record<string, string>> {
  const summary = await getOrganizationBillingSummary(orgId);
  return getFeaturesForPlan(summary.planId);
}

export async function getFeatureValue(orgId: string, featureKey: string): Promise<string | null> {
  const features = await getOrgFeatures(orgId);
  return features[featureKey] ?? null;
}

export async function checkFeatureLimit(
  orgId: string,
  featureKey: string,
  currentCount: number,
): Promise<{ allowed: boolean; limit: number | null; current: number }> {
  const value = await getFeatureValue(orgId, featureKey);

  if (!value || value === "unlimited") {
    return { allowed: true, limit: null, current: currentCount };
  }

  const limit = parseInt(value, 10);
  if (isNaN(limit)) {
    return { allowed: true, limit: null, current: currentCount };
  }

  return { allowed: currentCount < limit, limit, current: currentCount };
}

export async function checkMemberLimit(
  orgId: string,
): Promise<{ allowed: boolean; limit: number | null; current: number }> {
  const members = await db.query.member.findMany({
    where: eq(member.organizationId, orgId),
  });
  return checkFeatureLimit(orgId, "max_members", members.length);
}

export async function checkOrgLimit(
  userId: string,
): Promise<{ allowed: boolean; limit: number | null; current: number }> {
  const memberships = await db.query.member.findMany({
    where: and(eq(member.userId, userId), eq(member.role, "owner")),
  });

  const { planId } = await getUserPlanSummary(userId);
  const features = await getFeaturesForPlan(planId);
  const value = features.max_organizations;
  const current = memberships.length;

  if (!value || value === "unlimited") {
    return { allowed: true, limit: null, current };
  }

  const limit = parseInt(value, 10);
  if (isNaN(limit)) {
    return { allowed: true, limit: null, current };
  }

  return { allowed: current < limit, limit, current };
}
