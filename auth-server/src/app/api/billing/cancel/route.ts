import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { subscription } from "@/db/schema";
import { stripe } from "@/lib/stripe";

export async function POST(_request: NextRequest) {
  const user = await authenticateRequest(_request);
  if (!user) return unauthorized();

  const currentSubscription = await db.query.subscription.findFirst({
    where: eq(subscription.userId, user.id),
  });

  if (!currentSubscription) {
    return NextResponse.json({ error: "No active subscription found." }, { status: 404 });
  }

  if (currentSubscription.stripeSubscriptionId) {
    await stripe.subscriptions.cancel(currentSubscription.stripeSubscriptionId);
  }

  await db
    .update(subscription)
    .set({
      planId: "plan_free",
      status: "canceled",
      stripeSubscriptionId: null,
      cancelAtPeriodEnd: false,
      updatedAt: new Date(),
    })
    .where(eq(subscription.userId, user.id));

  return NextResponse.json({ success: true });
}
