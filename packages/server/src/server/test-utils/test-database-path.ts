import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let directory: string | undefined;
let count = 0;

/** A path for a test database that no other test uses, in a directory removed at process exit. */
export function nextTestDatabasePath(): string {
  if (!directory) {
    const created = mkdtempSync(path.join(tmpdir(), "paseo-database-"));
    directory = created;
    process.once("exit", () => rmSync(created, { recursive: true, force: true }));
  }
  count += 1;
  return path.join(directory, `test-${count}.db`);
}
