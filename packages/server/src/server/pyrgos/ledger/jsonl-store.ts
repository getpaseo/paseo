import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { LedgerItemSchema, type LedgerItem, type LedgerStore } from "./ledger.js";

export function voiceFeedDir(env: NodeJS.ProcessEnv = process.env): string {
  const harness = env.ALCHEMIST_HARNESS;
  const base = harness ? join(harness, ".agents", "feedback") : join(tmpdir(), "pyrgos-feedback");
  return join(base, "voice");
}

export function ledgerFilePath({ dir, session }: { dir: string; session: string }): string {
  return join(dir, `${session}.ledger.jsonl`);
}

export function createJsonlLedgerStore(path: string): LedgerStore {
  mkdirSync(dirname(path), { recursive: true });
  return {
    append(item) {
      const lead = existsSync(path) && !readFileSync(path, "utf8").endsWith("\n") ? "\n" : "";
      appendFileSync(path, `${lead}${JSON.stringify(item)}\n`, "utf8");
    },
    load() {
      return readLedgerFile(path);
    },
  };
}

export function readLedgerFile(path: string): LedgerItem[] {
  if (!existsSync(path)) return [];
  const latest = new Map<string, LedgerItem>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = LedgerItemSchema.safeParse(row);
    if (parsed.success) latest.set(parsed.data.id, parsed.data);
  }
  return [...latest.values()];
}
