import type { DatabaseSync } from "node:sqlite";

export interface LegacyImportResult {
  importedCount: number;
  skippedCount: number;
}

export function hasLegacyImportMarker(database: DatabaseSync, store: string): boolean {
  const row = database.prepare("SELECT 1 FROM legacy_imports WHERE store = ?").get(store) as
    | { 1: number }
    | undefined;
  return row !== undefined;
}

export function recordLegacyImportMarker(
  database: DatabaseSync,
  store: string,
  result: LegacyImportResult,
): void {
  database
    .prepare(
      `INSERT INTO legacy_imports (store, imported_at, imported_count, skipped_count)
       VALUES (?, ?, ?, ?)`,
    )
    .run(store, new Date().toISOString(), result.importedCount, result.skippedCount);
}
