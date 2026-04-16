import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { subscription } from "@/db/schema";
import { eq } from "drizzle-orm";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { stripe } from "@/lib/stripe";
import { randomUUID } from "crypto";

/**
 * POST /api/billing/sync - Sync subscription status from Stripe
 * Called after successful checkout to ensure DB is up to date
 * (in dev, webhooks may not reach the server)
 */
export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) return unauthorized();

  // Find the Stripe customer for this account.
  const existingSub = await db.query.subscription.findFirst({
    where: eq(subscription.userId, user.id),
  });

  const customerId = existingSub?.stripeCustomerId;
  if (!customerId) {
    // No Stripe customer yet — check recent checkout sessions by metadata.
    const sessions = await stripe.checkout.sessions.list({ limit: 10 });
    const matching = sessions.data.find(
      (s) =>
        s.metadata?.userId === user.id &&
        (s.status === "complete" || (s.subscription && s.payment_status === "paid")),
    );

    if (matching && matching.subscription) {
      const stripeSub = await stripe.subscriptions.retrieve(matching.subscription as string);
      const planId = matching.metadata?.planId || "plan_free";
      const interval = matching.metadata?.interval === "yearly" ? "yearly" : "monthly";

      if (existingSub) {
        await db
          .update(subscription)
          .set({
            planId,
            billingInterval: interval,
            stripeSubscriptionId: matching.subscription as string,
            stripeCustomerId: matching.customer as string,
            status: "active",
            currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
            currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
            updatedAt: new Date(),
          })
          .where(eq(subscription.userId, user.id));
      } else {
        await db.insert(subscription).values({
          id: randomUUID(),
          userId: user.id,
          planId,
          billingInterval: interval,
          stripeSubscriptionId: matching.subscription as string,
          stripeCustomerId: matching.customer as string,
          status: "active",
          currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
          currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      return NextResponse.json({ synced: true, planId });
    }

    return NextResponse.json({ synced: false, reason: "no_checkout_found" });
  }

  // Has a Stripe customer — list their subscriptions
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    limit: 1,
    status: "active",
  });

  if (subs.data.length > 0) {
    const stripeSub = subs.data[0];
    const priceId = stripeSub.items.data[0]?.price?.id;

    // Find matching plan by price ID
    const allPlans = await db.query.plan.findMany();
    const matchedPlan = allPlans.find(
      (p) => p.stripeMonthlyPriceId === priceId || p.stripeYearlyPriceId === priceId,
    );
    const planId = matchedPlan?.id || existingSub?.planId || "plan_free";
    const interval =
      stripeSub.items.data[0]?.price?.recurring?.interval === "year" ? "yearly" : "monthly";

    await db
      .update(subscription)
      .set({
        planId,
        billingInterval: interval,
        stripeSubscriptionId: stripeSub.id,
        status: "active",
        currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
        currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
        updatedAt: new Date(),
      })
      .where(eq(subscription.userId, user.id));

    return NextResponse.json({ synced: true, planId });
  }

  return NextResponse.json({ synced: false, reason: "no_active_subscription" });
}
