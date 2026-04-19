import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projectRegistry } from "@/db/schema";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";

type Params = { params: Promise<{ id: string }> };

/**
 * DELETE /api/projects/:id — Remove a project from the org registry.
 *
 * Only the owner (user that first registered it) can delete. Deletion removes
 * the online index entry only; each daemon keeps its local copy intact.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  const authUser = await authenticateRequest(request);
  if (!authUser) return unauthorized();

  const { id } = await params;
  const row = await db.query.projectRegistry.findFirst({
    where: eq(projectRegistry.id, id),
  });
  if (!row) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (row.ownerId !== authUser.id) {
    return NextResponse.json({ error: "Only the owner can remove this project" }, { status: 403 });
  }

  await db.delete(projectRegistry).where(eq(projectRegistry.id, id));
  return NextResponse.json({ success: true });
}
