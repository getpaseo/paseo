import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { planFeature } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { authenticateRequest, unauthorized, forbidden } from "@/lib/api-auth";
import { randomUUID } from "crypto";
import { logActivity } from "@/lib/activity";

type Params = { params: Promise<{ planId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();
  if (authUser.role !== "admin") return forbidden();

  const { planId } = await params;

  const features = await db.query.planFeature.findMany({
    where: eq(planFeature.planId, planId),
  });

  return NextResponse.json({ features });
}

export async function POST(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();
  if (authUser.role !== "admin") return forbidden();

  const { planId } = await params;
  const body = await request.json();
  const { featureKey, value, description } = body;

  if (!featureKey || value === undefined) {
    return NextResponse.json({ error: "featureKey and value required" }, { status: 400 });
  }

  const id = randomUUID();
  await db.insert(planFeature).values({
    id,
    planId,
    featureKey,
    value: String(value),
    description: description || null,
  });

  await logActivity({
    userId: authUser.id,
    action: "plan.feature_added",
    resourceType: "plan",
    resourceId: planId,
    details: { featureKey, value },
  });

  return NextResponse.json({ id, featureKey, value }, { status: 201 });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();
  if (authUser.role !== "admin") return forbidden();

  const { planId } = await params;
  const body = await request.json();
  const { featureKey, value, description } = body;

  if (!featureKey) {
    return NextResponse.json({ error: "featureKey required" }, { status: 400 });
  }

  const existing = await db.query.planFeature.findFirst({
    where: and(eq(planFeature.planId, planId), eq(planFeature.featureKey, featureKey)),
  });

  if (!existing) {
    return NextResponse.json({ error: "Feature not found" }, { status: 404 });
  }

  const updates: Record<string, any> = {};
  if (value !== undefined) updates.value = String(value);
  if (description !== undefined) updates.description = description;

  await db.update(planFeature).set(updates).where(eq(planFeature.id, existing.id));

  await logActivity({
    userId: authUser.id,
    action: "plan.feature_updated",
    resourceType: "plan",
    resourceId: planId,
    details: { featureKey, value },
  });

  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();
  if (authUser.role !== "admin") return forbidden();

  const { planId } = await params;
  const { searchParams } = request.nextUrl;
  const featureKey = searchParams.get("featureKey");

  if (!featureKey) {
    return NextResponse.json({ error: "featureKey required" }, { status: 400 });
  }

  await db
    .delete(planFeature)
    .where(and(eq(planFeature.planId, planId), eq(planFeature.featureKey, featureKey)));

  return NextResponse.json({ success: true });
}
