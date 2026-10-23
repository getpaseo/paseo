import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseLedgerRows, type ActionItem } from "../shared/ledger-view";

const LEDGER_SUFFIX = ".ledger.jsonl";

function voiceDir(): string {
  const harness = process.env.ALCHEMIST_HARNESS;
  const base = harness ? join(harness, ".agents", "feedback") : join(tmpdir(), "pyrgos-feedback");
  return join(base, "voice");
}

async function newestLedgerFile(dir: string): Promise<string | null> {
  const names = await readdir(dir).catch(() => []);
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(LEDGER_SUFFIX))
      .map(async (name) => ({
        path: join(dir, name),
        mtime: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? null,
      })),
  ).then((all) =>
    all.filter((file): file is { path: string; mtime: number } => file.mtime !== null),
  );
  return files.toSorted((a, b) => b.mtime - a.mtime)[0]?.path ?? null;
}

export async function listActionItems(): Promise<{ session: string | null; items: ActionItem[] }> {
  const path = process.env.PYRGOS_LEDGER_FILE ?? (await newestLedgerFile(voiceDir()));
  if (!path) return { session: null, items: [] };
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return { session: basename(path, LEDGER_SUFFIX), items: parseLedgerRows(text) };
}
