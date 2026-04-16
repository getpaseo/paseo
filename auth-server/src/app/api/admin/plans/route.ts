import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { plan, planFeature } from "@/db/schema";
import { eq } from "drizzle-orm";
import { authenticateRequest, unauthorized, forbidden } from "@/lib/api-auth";
import { randomUUID } from "crypto";
import { logActivity } from "@/lib/activity";

export async function GET(request: NextRequest) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();
  if (authUser.role !== "admin") return forbidden();

  const plans = await db.query.plan.findMany();

  const plansWithFeatures = await Promise.all(
    plans.map(async (p) => {
      const features = await db.query.planFeature.findMany({
        where: eq(planFeature.planId, p.id),
      });
      return { ...p, features };
    }),
  );

  return NextResponse.json({ plans: plansWithFeatures });
}

export async function POST(request: NextRequest) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();
  if (authUser.role !== "admin") return forbidden();

  const body = await request.json();
  const { name, slug, stripePriceId, monthlyPriceCents, features } = body;

  if (!name || !slug) {
    return NextResponse.json({ error: "Name and slug required" }, { status: 400 });
  }

  const id = randomUUID();

  await db.insert(plan).values({
    id,
    name,
    slug,
    stripePriceId: stripePriceId || null,
    monthlyPriceCents: monthlyPriceCents || 0,
    createdAt: new Date(),
  });

  // Insert features if provided
  if (features && typeof features === "object") {
    for (const [key, value] of Object.entries(features)) {
      await db.insert(planFeature).values({
        id: randomUUID(),
        planId: id,
        featureKey: key,
        value: String(value),
      });
    }
  }

  await logActivity({
    userId: authUser.id,
    action: "plan.created",
    resourceType: "plan",
    resourceId: id,
    details: { name, slug },
  });

  return NextResponse.json({ id, name, slug }, { status: 201 });
}
