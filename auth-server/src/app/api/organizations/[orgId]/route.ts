import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organization, member } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { authenticateRequest, unauthorized, forbidden } from "@/lib/api-auth";
import { getOrgFeatures } from "@/lib/feature-flags";
import { getOrganizationBillingSummary } from "@/lib/billing";

type Params = { params: Promise<{ orgId: string }> };

/**
 * GET /api/organizations/:orgId - Get organization details
 */
export async function GET(request: NextRequest, { params }: Params) {
  const user = await authenticateRequest(request);
  if (!user) return unauthorized();

  const { orgId } = await params;

  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, user.id)),
  });
  if (!membership) return forbidden();

  const org = await db.query.organization.findFirst({
    where: eq(organization.id, orgId),
  });
  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const members = await db.query.member.findMany({
    where: eq(member.organizationId, orgId),
  });

  const features = await getOrgFeatures(orgId);
  const billing = await getOrganizationBillingSummary(orgId);

  return NextResponse.json({
    ...org,
    role: membership.role,
    memberCount: members.length,
    planId: billing.planId,
    subscriptionStatus: billing.subscriptionStatus,
    features,
  });
}

/**
 * PATCH /api/organizations/:orgId - Update organization
 */
export async function PATCH(request: NextRequest, { params }: Params) {
  const user = await authenticateRequest(request);
  if (!user) return unauthorized();

  const { orgId } = await params;

  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, user.id)),
  });
  if (!membership || !["owner", "admin"].includes(membership.role)) return forbidden();

  const body = await request.json();
  const { name, slug, logo } = body;

  const updates: Record<string, string | null> = {};
  if (name) updates.name = name;
  if (slug) {
    const existing = await db.query.organization.findFirst({
      where: eq(organization.slug, slug),
    });
    if (existing && existing.id !== orgId) {
      return NextResponse.json({ error: "Slug already taken" }, { status: 409 });
    }
    updates.slug = slug;
  }
  if (logo !== undefined) updates.logo = logo;

  if (Object.keys(updates).length > 0) {
    await db.update(organization).set(updates).where(eq(organization.id, orgId));
  }

  const updated = await db.query.organization.findFirst({
    where: eq(organization.id, orgId),
  });

  return NextResponse.json(updated);
}

/**
 * DELETE /api/organizations/:orgId - Delete organization (owner only)
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  const user = await authenticateRequest(request);
  if (!user) return unauthorized();

  const { orgId } = await params;

  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, orgId), eq(member.userId, user.id)),
  });
  if (!membership || membership.role !== "owner") return forbidden();

  await db.delete(organization).where(eq(organization.id, orgId));

  return NextResponse.json({ success: true });
}
