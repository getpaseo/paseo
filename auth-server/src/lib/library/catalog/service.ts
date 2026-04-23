import { and, eq } from "drizzle-orm";
import { catalogCache } from "@/db/schema";
import type { DbLike } from "@/lib/chat/authz";
import { fetchGithubSkills } from "./github-skills";
import { fetchSkillsShSearch } from "./skills-sh";
import {
  enrichFromSmitheryDetail,
  fetchSmitheryCatalog,
  type FetchSmitheryParams,
} from "./smithery";
import type { CatalogItem, CatalogPage } from "./types";

/** Public alias so route handlers don't need to know the underlying source. */
export type FetchMcpParams = FetchSmitheryParams;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000; // 24h

interface CacheSpec {
  source: string;
  queryKey: string;
  ttlMs?: number;
}

async function readCache(db: DbLike, spec: CacheSpec): Promise<CatalogPage | null> {
  const rows = await db
    .select()
    .from(catalogCache)
    .where(and(eq(catalogCache.source, spec.source), eq(catalogCache.queryKey, spec.queryKey)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return row.data as unknown as CatalogPage;
}

async function writeCache(db: DbLike, spec: CacheSpec, data: CatalogPage): Promise<void> {
  const ttl = spec.ttlMs ?? DEFAULT_TTL_MS;
  const now = new Date();
  await db
    .insert(catalogCache)
    .values({
      source: spec.source,
      queryKey: spec.queryKey,
      data: data as unknown as Record<string, unknown>,
      fetchedAt: now,
      expiresAt: new Date(now.getTime() + ttl),
    })
    .onConflictDoUpdate({
      target: [catalogCache.source, catalogCache.queryKey],
      set: {
        data: data as unknown as Record<string, unknown>,
        fetchedAt: now,
        expiresAt: new Date(now.getTime() + ttl),
      },
    });
}

/**
 * Public MCP catalog — Smithery-backed. Each listing already carries real
 * icons + `verified` + `useCount`; connection details (env vars schema +
 * deployment URL / stdio install) are loaded lazily via `getMcpDetail`.
 *
 * Cached per (query, page) pair in Postgres for 24h (1h for searches).
 */
export async function getMcpCatalog(
  db: DbLike,
  params: FetchMcpParams & { refresh?: boolean },
): Promise<CatalogPage> {
  const queryKey = JSON.stringify({
    q: params.query ?? "",
    page: params.page ?? 1,
    n: params.pageSize ?? 50,
  });
  const spec: CacheSpec = {
    source: "smithery",
    queryKey,
    ttlMs: params.query ? 60 * 60_000 : DEFAULT_TTL_MS,
  };
  if (!params.refresh) {
    const cached = await readCache(db, spec);
    if (cached) return cached;
  }
  const page = await fetchSmitheryCatalog(params);
  await writeCache(db, spec, page);
  return page;
}

/**
 * Resolve a specific catalog item's install details (connection type, URL or
 * stdio command, required env vars). Called when the user opens the Add
 * modal — keeps the list endpoint cheap.
 */
export async function getMcpDetail(
  db: DbLike,
  id: string,
  opts: { refresh?: boolean } = {},
): Promise<CatalogItem | null> {
  const spec: CacheSpec = {
    source: "smithery-detail",
    queryKey: id,
    ttlMs: 6 * 60 * 60_000, // 6h — connection info changes rarely
  };
  if (!opts.refresh) {
    const cached = await readCache(db, spec);
    if (cached && cached.items.length > 0) return cached.items[0]!;
  }
  const stub: CatalogItem = {
    id,
    kind: "mcp",
    name: id.replace(/^smithery:/, ""),
    description: "",
    iconUrl: null,
    homepage: null,
    source: "smithery",
  };
  const enriched = await enrichFromSmitheryDetail(stub);
  await writeCache(db, spec, { items: [enriched], nextCursor: null, totalCount: 1 });
  return enriched;
}

/**
 * Skills catalog. Two paths:
 *  - No query → return the cached anthropic + openai/skills repos (the curated
 *    set; predictable Recommended list).
 *  - With query → call skills.sh `/api/search` (1000+ skills indexed across
 *    many repos) and merge with a substring filter over the GH list. skills.sh
 *    requires `q.length >= 2`, so for 1-char queries we fall back to filter.
 */
export async function getSkillsCatalog(
  db: DbLike,
  opts: { refresh?: boolean; query?: string } = {},
): Promise<CatalogPage> {
  const ghSpec: CacheSpec = { source: "github-skills", queryKey: "" };
  let ghPage: CatalogPage | null = null;
  if (!opts.refresh) ghPage = await readCache(db, ghSpec);
  if (!ghPage) {
    ghPage = await fetchGithubSkills();
    ghPage.items.sort((a, b) => {
      if (a.source === b.source) return a.name.localeCompare(b.name);
      return a.source === "anthropic-skills" ? -1 : 1;
    });
    await writeCache(db, ghSpec, ghPage);
  }

  const query = opts.query?.trim() ?? "";
  if (query.length < 2) {
    return ghPage;
  }

  const ghMatches = filterBySearch(ghPage.items, query);

  let shItems: CatalogItem[] = [];
  const shSpec: CacheSpec = {
    source: "skills-sh",
    queryKey: query.toLowerCase(),
    ttlMs: 60 * 60_000, // 1h
  };
  if (!opts.refresh) {
    const cached = await readCache(db, shSpec);
    if (cached) shItems = cached.items;
  }
  if (shItems.length === 0) {
    try {
      const shPage = await fetchSkillsShSearch(query);
      shItems = shPage.items;
      await writeCache(db, shSpec, shPage);
    } catch (err) {
      console.warn("[catalog] skills.sh search failed", err);
    }
  }

  // Dedupe by id while preserving GH-first ordering.
  const seen = new Set<string>();
  const merged: CatalogItem[] = [];
  for (const item of [...ghMatches, ...shItems]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return { items: merged, nextCursor: null, totalCount: merged.length };
}

export function filterBySearch(items: CatalogItem[], query: string): CatalogItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (i) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
  );
}
