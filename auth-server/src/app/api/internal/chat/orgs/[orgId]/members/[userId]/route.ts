import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getOrgRole } from "@/lib/chat/authz";
import { requireInternalSecret } from "@/lib/chat/internal-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; userId: string }> },
) {
  const forbidden = requireInternalSecret(request);
  if (forbidden) return forbidden;
  const { orgId, userId } = await params;
  const role = await getOrgRole(db, orgId, userId);
  if (!role) {
    return NextResponse.json({ member: false }, { status: 404 });
  }
  return NextResponse.json({ member: true, role });
}
