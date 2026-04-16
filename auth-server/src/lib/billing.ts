import { db } from "@/lib/db";
import { member, plan, subscription } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export interface BillingSummary {
  billingOwnerUserId: string | null;
  planId: string;
  subscriptionStatus: string;
  billingInterval: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  currentPlan: {
    id: string;
    name: string;
    monthlyPriceCents: number;
    yearlyPriceCents: number;
  } | null;
}

async function getPlanDetails(planId: string) {
  const currentPlan = await db.query.plan.findFirst({
    where: eq(plan.id, planId),
  });

  if (!currentPlan) {
    return null;
  }

  return {
    id: currentPlan.id,
    name: currentPlan.name,
    monthlyPriceCents: currentPlan.monthlyPriceCents,
    yearlyPriceCents: currentPlan.yearlyPriceCents,
  };
}

export async function getUserBillingSummary(userId: string): Promise<BillingSummary> {
  const userSubscription = await db.query.subscription.findFirst({
    where: eq(subscription.userId, userId),
  });

  const planId = userSubscription?.planId ?? "plan_free";
  const currentPlan = await getPlanDetails(planId);

  return {
    billingOwnerUserId: userId,
    planId,
    subscriptionStatus: userSubscription?.status ?? "active",
    billingInterval: userSubscription?.billingInterval ?? "monthly",
    stripeCustomerId: userSubscription?.stripeCustomerId ?? null,
    stripeSubscriptionId: userSubscription?.stripeSubscriptionId ?? null,
    currentPeriodStart: userSubscription?.currentPeriodStart ?? null,
    currentPeriodEnd: userSubscription?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: userSubscription?.cancelAtPeriodEnd ?? false,
    currentPlan,
  };
}

export async function getOrganizationBillingOwnerId(orgId: string): Promise<string | null> {
  const owners = await db.query.member.findMany({
    where: and(eq(member.organizationId, orgId), eq(member.role, "owner")),
  });

  if (owners.length === 0) {
    return null;
  }

  owners.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return owners[0]?.userId ?? null;
}

export async function getOrganizationBillingSummary(orgId: string): Promise<BillingSummary> {
  const billingOwnerUserId = await getOrganizationBillingOwnerId(orgId);

  if (!billingOwnerUserId) {
    const currentPlan = await getPlanDetails("plan_free");
    return {
      billingOwnerUserId: null,
      planId: "plan_free",
      subscriptionStatus: "active",
      billingInterval: "monthly",
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      currentPlan,
    };
  }

  return getUserBillingSummary(billingOwnerUserId);
}
