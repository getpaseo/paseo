import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { libraryErrorResponse } from "@/lib/library/http";
import { setActivation } from "@/lib/library/entries";
import type { LibrarySyncTarget } from "@/lib/library/types";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ entryId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { entryId } = await params;
  let body: { active?: boolean; syncTargets?: LibrarySyncTarget[] } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const entry = await setActivation(db, me.id, entryId, body);
    return NextResponse.json({ entry });
  } catch (err) {
    return libraryErrorResponse(err);
  }
}
