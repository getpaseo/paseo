import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { BillingPageClient } from "@/components/billing-page-client";
import { getServerSession } from "@/lib/session";
import { db } from "@/lib/db";
import { plan, planFeature } from "@/db/schema";
import { getUserBillingSummary } from "@/lib/billing";

export default async function AccountBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; canceled?: string }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in/web");

  const search = await searchParams;
  const billing = await getUserBillingSummary(session.user.id);

  const allPlans = await db.query.plan.findMany({
    where: eq(plan.active, true),
  });

  const plansWithFeatures = await Promise.all(
    allPlans.map(async (currentPlan) => {
      const features = await db.query.planFeature.findMany({
        where: eq(planFeature.planId, currentPlan.id),
      });
      return {
        ...currentPlan,
        features: Object.fromEntries(
          features.map((feature) => [feature.featureKey, feature.value]),
        ),
      };
    }),
  );

  return (
    <BillingPageClient
      accountName={session.user.name}
      currentPlanId={billing.planId}
      currentPlan={billing.currentPlan}
      billingInterval={billing.billingInterval}
      hasStripeCustomer={!!billing.stripeCustomerId}
      plans={plansWithFeatures}
      success={search.success === "true"}
      canceled={search.canceled === "true"}
    />
  );
}
