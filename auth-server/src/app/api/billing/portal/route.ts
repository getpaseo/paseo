import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { subscription } from "@/db/schema";
import { eq } from "drizzle-orm";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { stripe } from "@/lib/stripe";

/**
 * POST /api/billing/portal - Create a Stripe Billing Portal session
 */
export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) return unauthorized();

  const sub = await db.query.subscription.findFirst({
    where: eq(subscription.userId, user.id),
  });

  if (!sub?.stripeCustomerId) {
    return NextResponse.json(
      { error: "No billing account found. Subscribe to a plan first." },
      { status: 400 },
    );
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3001";

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${appUrl}/dashboard/billing`,
  });

  return NextResponse.json({ url: portalSession.url });
}
