import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organization, member } from "@/db/schema";
import { eq } from "drizzle-orm";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { checkOrgLimit, getUserPlanSummary } from "@/lib/feature-flags";
import { randomUUID } from "crypto";

/**
 * GET /api/organizations - List user's organizations
 */
export async function GET(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) return unauthorized();

  const memberships = await db.query.member.findMany({
    where: eq(member.userId, user.id),
  });
  const userPlan = await getUserPlanSummary(user.id);

  const orgs = await Promise.all(
    memberships.map(async (m) => {
      const org = await db.query.organization.findFirst({
        where: eq(organization.id, m.organizationId),
      });
      const memberCount = (
        await db.query.member.findMany({
          where: eq(member.organizationId, m.organizationId),
        })
      ).length;

      return {
        ...org,
        role: m.role,
        memberCount,
        planId: userPlan.planId,
        subscriptionStatus: userPlan.subscriptionStatus,
      };
    }),
  );

  return NextResponse.json({ organizations: orgs });
}

/**
 * POST /api/organizations - Create organization
 */
export async function POST(request: NextRequest) {
  const user = await authenticateRequest(request);
  if (!user) return unauthorized();

  const body = await request.json();
  const { name, slug, logo } = body as { name?: string; slug?: string; logo?: string };

  if (!name || !slug) {
    return NextResponse.json({ error: "Name and slug are required" }, { status: 400 });
  }

  const normalizedLogo = typeof logo === "string" ? logo.trim() : "";
  if (normalizedLogo && !isValidLogoDataUrl(normalizedLogo)) {
    return NextResponse.json(
      { error: "Logo must be a data URL (≤256KB, image/*)" },
      { status: 400 },
    );
  }

  // Check org limit
  const limit = await checkOrgLimit(user.id);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: `Organization limit reached (${limit.current}/${limit.limit}). Upgrade your plan.`,
      },
      { status: 403 },
    );
  }
  // Check slug uniqueness
  const existing = await db.query.organization.findFirst({
    where: eq(organization.slug, slug),
  });
  if (existing) {
    return NextResponse.json({ error: "Slug already taken" }, { status: 409 });
  }

  const orgId = randomUUID();

  await db.insert(organization).values({
    id: orgId,
    name,
    slug,
    logo: normalizedLogo || null,
    createdAt: new Date(),
  });

  // Add creator as owner
  await db.insert(member).values({
    id: randomUUID(),
    organizationId: orgId,
    userId: user.id,
    role: "owner",
    createdAt: new Date(),
  });

  return NextResponse.json(
    { id: orgId, name, slug, logo: normalizedLogo || null, role: "owner" },
    { status: 201 },
  );
}

// ~256KB cap — enough headroom for a 256x256 webp/jpeg logo even if the
// client encodes inefficiently. Keeps the DB row reasonably small since
// logos ship inline on every /api/organizations response.
const LOGO_DATA_URL_MAX_BYTES = 256 * 1024;
const LOGO_DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

function isValidLogoDataUrl(value: string): boolean {
  if (value.length > LOGO_DATA_URL_MAX_BYTES) return false;
  return LOGO_DATA_URL_PATTERN.test(value);
}
