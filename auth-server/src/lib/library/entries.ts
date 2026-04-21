import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { libraryActivation, libraryEntry } from "@/db/schema";
import type { DbLike } from "@/lib/chat/authz";
import { canReadScope, canWriteScope } from "./authz";
import { newLibraryEntryId, slugifyLibraryName } from "./ids";
import {
  TRANSPORT_BY_TARGET,
  type LibraryEntryRecord,
  type LibraryKind,
  type LibraryPayload,
  type LibraryScope,
  type LibrarySource,
  type LibrarySyncTarget,
  type LibraryVisibility,
  type McpPayload,
} from "./types";

export class LibraryError extends Error {
  constructor(
    public readonly code:
      | "bad_request"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "internal",
    message: string,
  ) {
    super(message);
    this.name = "LibraryError";
  }
}

interface CreateEntryInput {
  kind: LibraryKind;
  rawName: string;
  displayName?: string;
  description?: string | null;
  payload: LibraryPayload;
  iconUrl?: string | null;
  source?: LibrarySource;
  catalogId?: string | null;
  scope: LibraryScope;
  scopeId?: string | null;
  visibility?: LibraryVisibility;
}

export async function createEntry(
  db: DbLike,
  userId: string,
  input: CreateEntryInput,
): Promise<LibraryEntryRecord> {
  const name = slugifyLibraryName(input.rawName);
  if (!name) throw new LibraryError("bad_request", "name is required");

  if (input.scope !== "user" && !input.scopeId) {
    throw new LibraryError("bad_request", "scopeId is required for org/project scope");
  }
  if (input.scope === "user" && input.scopeId) {
    throw new LibraryError("bad_request", "scopeId must be omitted for user scope");
  }

  validatePayload(input.kind, input.payload);

  // Visibility is forced to private for user scope (the entry never leaves
  // its creator anyway).
  const visibility: LibraryVisibility =
    input.scope === "user" ? "private" : (input.visibility ?? "private");

  if (
    !(await canWriteScope(db, userId, input.scope, input.scopeId ?? null))
  ) {
    throw new LibraryError("forbidden", "Cannot write under this scope");
  }

  const id = newLibraryEntryId();
  try {
    const inserted = await db
      .insert(libraryEntry)
      .values({
        id,
        kind: input.kind,
        name,
        displayName: input.displayName?.trim() || name,
        description: input.description ?? null,
        payload: input.payload as unknown as Record<string, unknown>,
        iconUrl: input.iconUrl ?? null,
        source: input.source ?? "custom",
        catalogId: input.catalogId ?? null,
        scope: input.scope,
        scopeId: input.scopeId ?? null,
        visibility,
        createdBy: userId,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new LibraryError("internal", "Insert returned no row");

    // Creator implicitly activates their own entries (they almost always
    // want to use what they just added). They can opt out later.
    await db
      .insert(libraryActivation)
      .values({
        entryId: row.id,
        userId,
        active: true,
        syncTargets: defaultSyncTargetsFor(input.kind, input.payload),
      })
      .onConflictDoNothing();

    return rowToRecord(row, {
      active: true,
      syncTargets: defaultSyncTargetsFor(input.kind, input.payload),
      activatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("library_entry_scope_name_unique")) {
      throw new LibraryError(
        "conflict",
        `An entry named "${name}" already exists in this scope`,
      );
    }
    throw err;
  }
}

interface ListInput {
  kind?: LibraryKind;
  scope?: LibraryScope;
  scopeId?: string | null;
  /**
   * Org IDs the user belongs to. Used when listing user-visible entries
   * across "all my orgs". Caller fetches once and passes here so this module
   * stays decoupled from auth/org tables.
   */
  orgIds?: string[];
  /** Project IDs the user can access. */
  projectIds?: string[];
}

export async function listEntries(
  db: DbLike,
  userId: string,
  input: ListInput,
): Promise<LibraryEntryRecord[]> {
  const conditions = [isNull(libraryEntry.deletedAt)];

  if (input.kind) conditions.push(eq(libraryEntry.kind, input.kind));

  if (input.scope === "user") {
    conditions.push(eq(libraryEntry.scope, "user"));
    conditions.push(eq(libraryEntry.createdBy, userId));
  } else if (input.scope === "org") {
    if (!input.scopeId) throw new LibraryError("bad_request", "scopeId required");
    if (!(await canReadScope(db, userId, "org", input.scopeId))) {
      throw new LibraryError("forbidden", "Not a member of this org");
    }
    conditions.push(eq(libraryEntry.scope, "org"));
    conditions.push(eq(libraryEntry.scopeId, input.scopeId));
    // Hide private entries from non-creators.
    const visibilityClause = or(
      eq(libraryEntry.visibility, "shared"),
      eq(libraryEntry.createdBy, userId),
    );
    if (visibilityClause) conditions.push(visibilityClause);
  } else if (input.scope === "project") {
    if (!input.scopeId) throw new LibraryError("bad_request", "scopeId required");
    if (!(await canReadScope(db, userId, "project", input.scopeId))) {
      throw new LibraryError("forbidden", "Cannot access this project");
    }
    conditions.push(eq(libraryEntry.scope, "project"));
    conditions.push(eq(libraryEntry.scopeId, input.scopeId));
    const visibilityClause = or(
      eq(libraryEntry.visibility, "shared"),
      eq(libraryEntry.createdBy, userId),
    );
    if (visibilityClause) conditions.push(visibilityClause);
  } else {
    // No scope filter: union of (my user entries) ∪ (org entries I see) ∪
    // (project entries I see). We assemble by separate clauses inside an OR.
    const orgIds = input.orgIds ?? [];
    const projectIds = input.projectIds ?? [];
    const userClause = and(
      eq(libraryEntry.scope, "user"),
      eq(libraryEntry.createdBy, userId),
    );
    const orgClause = orgIds.length
      ? and(
          eq(libraryEntry.scope, "org"),
          inArray(libraryEntry.scopeId, orgIds),
          or(
            eq(libraryEntry.visibility, "shared"),
            eq(libraryEntry.createdBy, userId),
          ),
        )
      : null;
    const projectClause = projectIds.length
      ? and(
          eq(libraryEntry.scope, "project"),
          inArray(libraryEntry.scopeId, projectIds),
          or(
            eq(libraryEntry.visibility, "shared"),
            eq(libraryEntry.createdBy, userId),
          ),
        )
      : null;
    const combined = or(
      ...[userClause, orgClause, projectClause].filter(
        (c): c is NonNullable<typeof c> => c !== null && c !== undefined,
      ),
    );
    if (combined) conditions.push(combined);
  }

  const rows = await db
    .select()
    .from(libraryEntry)
    .where(and(...conditions))
    .orderBy(desc(libraryEntry.updatedAt));

  if (rows.length === 0) return [];

  // Hydrate per-user activation in one batch.
  const activations = await db
    .select()
    .from(libraryActivation)
    .where(
      and(
        eq(libraryActivation.userId, userId),
        inArray(
          libraryActivation.entryId,
          rows.map((r) => r.id),
        ),
      ),
    );
  const actByEntry = new Map(activations.map((a) => [a.entryId, a]));

  return rows.map((r) => {
    const a = actByEntry.get(r.id);
    return rowToRecord(
      r,
      a
        ? {
            active: a.active,
            syncTargets: (a.syncTargets as LibrarySyncTarget[]) ?? [],
            activatedAt: a.activatedAt.toISOString(),
            updatedAt: a.updatedAt.toISOString(),
          }
        : null,
    );
  });
}

export async function getEntry(
  db: DbLike,
  userId: string,
  entryId: string,
): Promise<LibraryEntryRecord> {
  const rows = await db
    .select()
    .from(libraryEntry)
    .where(and(eq(libraryEntry.id, entryId), isNull(libraryEntry.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new LibraryError("not_found", "Entry not found");

  if (!(await canReadScope(db, userId, row.scope as LibraryScope, row.scopeId))) {
    throw new LibraryError("forbidden", "Cannot read this entry");
  }
  if (row.visibility === "private" && row.createdBy !== userId) {
    throw new LibraryError("not_found", "Entry not found");
  }

  const actRows = await db
    .select()
    .from(libraryActivation)
    .where(
      and(
        eq(libraryActivation.entryId, entryId),
        eq(libraryActivation.userId, userId),
      ),
    )
    .limit(1);
  const a = actRows[0];
  return rowToRecord(
    row,
    a
      ? {
          active: a.active,
          syncTargets: (a.syncTargets as LibrarySyncTarget[]) ?? [],
          activatedAt: a.activatedAt.toISOString(),
          updatedAt: a.updatedAt.toISOString(),
        }
      : null,
  );
}

export async function updateEntry(
  db: DbLike,
  userId: string,
  entryId: string,
  patch: {
    displayName?: string;
    description?: string | null;
    payload?: LibraryPayload;
    iconUrl?: string | null;
    visibility?: LibraryVisibility;
  },
): Promise<LibraryEntryRecord> {
  const existing = await getEntry(db, userId, entryId);
  if (existing.createdBy !== userId) {
    throw new LibraryError("forbidden", "Only the creator can edit");
  }
  if (patch.payload) validatePayload(existing.kind, patch.payload);
  // Visibility cannot be set to "shared" on user-scope entries.
  if (
    patch.visibility === "shared" &&
    existing.scope === "user"
  ) {
    throw new LibraryError("bad_request", "user-scope entries are always private");
  }
  await db
    .update(libraryEntry)
    .set({
      displayName: patch.displayName?.trim() || existing.displayName,
      description: patch.description ?? existing.description,
      payload: (patch.payload ?? existing.payload) as unknown as Record<string, unknown>,
      iconUrl: patch.iconUrl ?? existing.iconUrl,
      visibility: patch.visibility ?? existing.visibility,
      updatedAt: new Date(),
    })
    .where(eq(libraryEntry.id, entryId));
  return getEntry(db, userId, entryId);
}

export async function deleteEntry(
  db: DbLike,
  userId: string,
  entryId: string,
): Promise<void> {
  const existing = await getEntry(db, userId, entryId);
  if (existing.createdBy !== userId) {
    throw new LibraryError("forbidden", "Only the creator can delete");
  }
  await db
    .update(libraryEntry)
    .set({ deletedAt: new Date() })
    .where(eq(libraryEntry.id, entryId));
}

export async function setActivation(
  db: DbLike,
  userId: string,
  entryId: string,
  patch: { active?: boolean; syncTargets?: LibrarySyncTarget[] },
): Promise<LibraryEntryRecord> {
  const entry = await getEntry(db, userId, entryId);
  if (patch.syncTargets) {
    validateSyncTargets(entry.kind, entry.payload, patch.syncTargets);
  }
  await db
    .insert(libraryActivation)
    .values({
      entryId,
      userId,
      active: patch.active ?? true,
      syncTargets: patch.syncTargets ?? [],
    })
    .onConflictDoUpdate({
      target: [libraryActivation.entryId, libraryActivation.userId],
      set: {
        active: patch.active ?? true,
        syncTargets: patch.syncTargets ?? [],
        updatedAt: new Date(),
      },
    });
  return getEntry(db, userId, entryId);
}

// ─── helpers ──────────────────────────────────────────────────────────────

function rowToRecord(
  row: typeof libraryEntry.$inferSelect,
  activation: LibraryEntryRecord["activation"],
): LibraryEntryRecord {
  return {
    id: row.id,
    kind: row.kind as LibraryKind,
    name: row.name,
    displayName: row.displayName,
    description: row.description,
    payload: row.payload as LibraryPayload,
    iconUrl: row.iconUrl,
    source: row.source as LibrarySource,
    catalogId: row.catalogId,
    scope: row.scope as LibraryScope,
    scopeId: row.scopeId,
    visibility: row.visibility as LibraryVisibility,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    activation,
  };
}

function validatePayload(kind: LibraryKind, payload: LibraryPayload): void {
  if (kind === "mcp") {
    const mcp = payload as McpPayload;
    if (mcp.transport === "stdio") {
      if (!mcp.command || typeof mcp.command !== "string") {
        throw new LibraryError("bad_request", "stdio MCP requires command");
      }
    } else if (mcp.transport === "http" || mcp.transport === "sse") {
      if (!mcp.url || typeof mcp.url !== "string") {
        throw new LibraryError("bad_request", "http/sse MCP requires url");
      }
    } else {
      throw new LibraryError(
        "bad_request",
        `Unknown MCP transport: ${(mcp as { transport?: unknown }).transport}`,
      );
    }
    return;
  }
  // skill
  const skill = payload as { instructionsInline?: string; instructionsUrl?: string };
  if (!skill.instructionsInline && !skill.instructionsUrl) {
    throw new LibraryError(
      "bad_request",
      "skill requires either instructionsInline or instructionsUrl",
    );
  }
}

function validateSyncTargets(
  kind: LibraryKind,
  payload: LibraryPayload,
  targets: LibrarySyncTarget[],
): void {
  // Skills don't sync to external CLI configs in v1 (they live in
  // ~/.agentskills/ which the daemon manages); reject any target.
  if (kind === "skill" && targets.length > 0) {
    throw new LibraryError(
      "bad_request",
      "Skills do not support sync targets in v1",
    );
  }
  if (kind !== "mcp") return;
  const mcp = payload as McpPayload;
  for (const t of targets) {
    if (!TRANSPORT_BY_TARGET[t]?.includes(mcp.transport)) {
      throw new LibraryError(
        "bad_request",
        `Sync target "${t}" does not support transport "${mcp.transport}"`,
      );
    }
  }
}

function defaultSyncTargetsFor(
  kind: LibraryKind,
  payload: LibraryPayload,
): LibrarySyncTarget[] {
  if (kind !== "mcp") return [];
  const mcp = payload as McpPayload;
  // Default to every target whose transport supports this MCP. Users can
  // narrow afterwards.
  return (Object.keys(TRANSPORT_BY_TARGET) as LibrarySyncTarget[]).filter(
    (t) => TRANSPORT_BY_TARGET[t].includes(mcp.transport),
  );
}
