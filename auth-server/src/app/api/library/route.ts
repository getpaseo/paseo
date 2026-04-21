import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { libraryErrorResponse } from "@/lib/library/http";
import { createEntry, listEntries } from "@/lib/library/entries";
import { loadVisibleScopes } from "@/lib/library/scope-context";
import type {
  LibraryKind,
  LibraryPayload,
  LibraryScope,
  LibraryVisibility,
} from "@/lib/library/types";

export async function GET(request: NextRequest) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  const url = new URL(request.url);
  const kind = (url.searchParams.get("kind") as LibraryKind | null) ?? undefined;
  const scope = (url.searchParams.get("scope") as LibraryScope | null) ?? undefined;
  const scopeId = url.searchParams.get("scopeId") ?? undefined;
  try {
    const { orgIds, projectIds } = scope ? { orgIds: [], projectIds: [] } : await loadVisibleScopes(db, me.id);
    const entries = await listEntries(db, me.id, {
      kind,
      scope,
      scopeId,
      orgIds,
      projectIds,
    });
    return NextResponse.json({ entries });
  } catch (err) {
    return libraryErrorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  const me = await authenticateRequest(request);
  if (!me) return unauthorized();
  let body: {
    kind?: LibraryKind;
    name?: string;
    displayName?: string;
    description?: string | null;
    payload?: LibraryPayload;
    iconUrl?: string | null;
    source?: "custom" | "catalog";
    catalogId?: string | null;
    scope?: LibraryScope;
    scopeId?: string | null;
    visibility?: LibraryVisibility;
  } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.kind || !body.name || !body.payload || !body.scope) {
    return NextResponse.json(
      { error: "kind, name, payload, scope are required" },
      { status: 400 },
    );
  }
  try {
    const entry = await createEntry(db, me.id, {
      kind: body.kind,
      rawName: body.name,
      displayName: body.displayName,
      description: body.description ?? null,
      payload: body.payload,
      iconUrl: body.iconUrl ?? null,
      source: body.source ?? "custom",
      catalogId: body.catalogId ?? null,
      scope: body.scope,
      scopeId: body.scopeId ?? null,
      visibility: body.visibility,
    });
    return NextResponse.json({ entry }, { status: 201 });
  } catch (err) {
    return libraryErrorResponse(err);
  }
}
