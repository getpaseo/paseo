import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { libraryErrorResponse } from "@/lib/library/http";
import { deleteEntry, getEntry, updateEntry } from "@/lib/library/entries";
import type { LibraryPayload, LibraryVisibility } from "@/lib/library/types";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ entryId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { entryId } = await params;
  try {
    const entry = await getEntry(db, me.id, entryId);
    return NextResponse.json({ entry });
  } catch (err) {
    return libraryErrorResponse(err);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ entryId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { entryId } = await params;
  let body: {
    displayName?: string;
    description?: string | null;
    payload?: LibraryPayload;
    iconUrl?: string | null;
    visibility?: LibraryVisibility;
  } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const entry = await updateEntry(db, me.id, entryId, body);
    return NextResponse.json({ entry });
  } catch (err) {
    return libraryErrorResponse(err);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ entryId: string }> },
) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const { entryId } = await params;
  try {
    await deleteEntry(db, me.id, entryId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return libraryErrorResponse(err);
  }
}
