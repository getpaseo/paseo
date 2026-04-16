import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { subscription } from "@/db/schema";
import { eq } from "drizzle-orm";
import { stripe } from "@/lib/stripe";
import { randomUUID } from "crypto";
import Stripe from "stripe";

/**
 * POST /api/billing/webhook - Stripe webhook handler
 */
export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const { userId, planId, interval } = session.metadata || {};
      const billingInterval = interval === "yearly" ? "yearly" : "monthly";

      if (userId && planId) {
        const existingSub = await db.query.subscription.findFirst({
          where: eq(subscription.userId, userId),
        });

        if (existingSub) {
          await db
            .update(subscription)
            .set({
              planId,
              billingInterval,
              stripeSubscriptionId: session.subscription as string,
              stripeCustomerId: session.customer as string,
              status: "active",
              updatedAt: new Date(),
            })
            .where(eq(subscription.userId, userId));
        } else {
          await db.insert(subscription).values({
            id: randomUUID(),
            userId,
            planId,
            billingInterval,
            stripeSubscriptionId: session.subscription as string,
            stripeCustomerId: session.customer as string,
            status: "active",
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const existingSub = await db.query.subscription.findFirst({
        where: eq(subscription.stripeSubscriptionId, sub.id),
      });

      if (existingSub) {
        await db
          .update(subscription)
          .set({
            status:
              sub.status === "active"
                ? "active"
                : sub.status === "past_due"
                  ? "past_due"
                  : "canceled",
            currentPeriodStart: new Date(sub.current_period_start * 1000),
            currentPeriodEnd: new Date(sub.current_period_end * 1000),
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            updatedAt: new Date(),
          })
          .where(eq(subscription.stripeSubscriptionId, sub.id));
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const existingSub = await db.query.subscription.findFirst({
        where: eq(subscription.stripeSubscriptionId, sub.id),
      });

      if (existingSub) {
        // Downgrade to free
        await db
          .update(subscription)
          .set({
            planId: "plan_free",
            status: "canceled",
            stripeSubscriptionId: null,
            updatedAt: new Date(),
          })
          .where(eq(subscription.stripeSubscriptionId, sub.id));
      }
      break;
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      if (invoice.subscription) {
        const subId =
          typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription.id;
        await db
          .update(subscription)
          .set({
            status: "active",
            updatedAt: new Date(),
          })
          .where(eq(subscription.stripeSubscriptionId, subId));
      }
      break;
    }
  }

  return NextResponse.json({ received: true });
}
