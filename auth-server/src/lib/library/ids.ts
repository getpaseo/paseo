import { randomUUID } from "node:crypto";

export const newLibraryEntryId = () => `lib_${randomUUID()}`;

/**
 * Slugify a user-supplied name for use as a library entry's `name` field.
 * Lowercase ASCII + digits + hyphens, max 80 chars. Returns null when nothing
 * useful is left (caller should respond 400).
 */
export function slugifyLibraryName(raw: string): string | null {
  const s = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return s.length === 0 ? null : s;
}
