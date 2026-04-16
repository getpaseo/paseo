import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { subscription, plan } from "@/db/schema";
import { eq } from "drizzle-orm";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { stripe } from "@/lib/stripe";

/**
 * POST /api/billing/checkout - Create a Stripe Checkout session
 * Body: { planId, interval: 'monthly' | 'yearly' }
 */
export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) return unauthorized();

  const body = await request.json();
  const { planId, interval = "monthly" } = body;

  if (!planId) {
    return NextResponse.json({ error: "planId is required" }, { status: 400 });
  }

  if (!["monthly", "yearly"].includes(interval)) {
    return NextResponse.json({ error: "interval must be monthly or yearly" }, { status: 400 });
  }

  // Get the plan
  const targetPlan = await db.query.plan.findFirst({
    where: eq(plan.id, planId),
  });

  const priceId =
    interval === "yearly" ? targetPlan?.stripeYearlyPriceId : targetPlan?.stripeMonthlyPriceId;

  if (!targetPlan || !priceId) {
    return NextResponse.json({ error: "Invalid plan or interval" }, { status: 400 });
  }

  // Get or create Stripe customer for the account owner.
  const sub = await db.query.subscription.findFirst({
    where: eq(subscription.userId, user.id),
  });

  let customerId = sub?.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name || undefined,
      metadata: { userId: user.id },
    });
    customerId = customer.id;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3002";

  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl}/dashboard/billing/success`,
    cancel_url: `${appUrl}/dashboard/billing?canceled=true`,
    metadata: { userId: user.id, planId, interval },
  });

  return NextResponse.json({ url: checkoutSession.url });
}
