import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { catalogIconCache } from "@/db/schema";
import type { DbLike } from "@/lib/chat/authz";

/**
 * Hash a source URL for use as the cache key + public URL path. Using SHA-256
 * hex means the client can compute the cache URL before the server has
 * fetched the icon.
 */
export function hashIconUrl(sourceUrl: string): string {
  return createHash("sha256").update(sourceUrl).digest("hex");
}

export async function getOrFetchIcon(
  db: DbLike,
  sourceUrl: string,
): Promise<{ mimeType: string; bytes: Buffer } | null> {
  const hash = hashIconUrl(sourceUrl);
  const rows = await db
    .select()
    .from(catalogIconCache)
    .where(eq(catalogIconCache.hash, hash))
    .limit(1);
  const cached = rows[0];
  if (cached) {
    return {
      mimeType: cached.mimeType,
      bytes: Buffer.from(cached.bytes, "base64"),
    };
  }
  try {
    const res = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "image/*" },
    });
    if (!res.ok) return null;
    const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/png";
    const ab = await res.arrayBuffer();
    // Cap at ~1MB to keep the table small.
    if (ab.byteLength > 1_000_000) return null;
    const bytes = Buffer.from(ab);
    await db
      .insert(catalogIconCache)
      .values({
        hash,
        sourceUrl,
        mimeType,
        bytes: bytes.toString("base64"),
      })
      .onConflictDoNothing();
    return { mimeType, bytes };
  } catch {
    return null;
  }
}
