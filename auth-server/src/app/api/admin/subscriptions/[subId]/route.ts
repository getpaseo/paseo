import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { subscription } from "@/db/schema";
import { eq } from "drizzle-orm";
import { authenticateRequest, unauthorized, forbidden } from "@/lib/api-auth";
import { stripe } from "@/lib/stripe";
import { logActivity } from "@/lib/activity";

type Params = { params: Promise<{ subId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();
  if (authUser.role !== "admin") return forbidden();

  const { subId } = await params;
  const body = await request.json();

  const sub = await db.query.subscription.findFirst({
    where: eq(subscription.id, subId),
  });
  if (!sub) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }

  // Cancel subscription in Stripe if requested
  if (body.action === "cancel" && sub.stripeSubscriptionId) {
    await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
    await db
      .update(subscription)
      .set({ status: "canceled", planId: "plan_free", updatedAt: new Date() })
      .where(eq(subscription.id, subId));

    await logActivity({
      userId: authUser.id,
      action: "subscription.canceled",
      resourceType: "subscription",
      resourceId: subId,
      details: { userId: sub.userId },
    });
  }

  // Change plan
  if (body.planId) {
    await db
      .update(subscription)
      .set({ planId: body.planId, updatedAt: new Date() })
      .where(eq(subscription.id, subId));

    await logActivity({
      userId: authUser.id,
      action: "subscription.plan_changed",
      resourceType: "subscription",
      resourceId: subId,
      details: { planId: body.planId },
    });
  }

  const updated = await db.query.subscription.findFirst({
    where: eq(subscription.id, subId),
  });

  return NextResponse.json(updated);
}
