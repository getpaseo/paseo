import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organization, subscription } from "@/db/schema";
import { eq } from "drizzle-orm";
import { authenticateRequest, unauthorized, forbidden } from "@/lib/api-auth";
import { logActivity } from "@/lib/activity";
import { getOrganizationBillingOwnerId } from "@/lib/billing";
import { randomUUID } from "crypto";

type Params = { params: Promise<{ orgId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();
  if (authUser.role !== "admin") return forbidden();

  const { orgId } = await params;
  const body = await request.json();

  // Admin can override the plan
  if (body.planId) {
    const billingOwnerUserId = await getOrganizationBillingOwnerId(orgId);
    if (billingOwnerUserId) {
      const sub = await db.query.subscription.findFirst({
        where: eq(subscription.userId, billingOwnerUserId),
      });
      if (sub) {
        await db
          .update(subscription)
          .set({ planId: body.planId, updatedAt: new Date() })
          .where(eq(subscription.userId, billingOwnerUserId));
      } else {
        await db.insert(subscription).values({
          id: randomUUID(),
          userId: billingOwnerUserId,
          planId: body.planId,
          status: "active",
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    await logActivity({
      userId: authUser.id,
      action: "org.plan_changed",
      resourceType: "organization",
      resourceId: orgId,
      details: { planId: body.planId },
    });
  }

  const org = await db.query.organization.findFirst({
    where: eq(organization.id, orgId),
  });

  return NextResponse.json(org);
}
