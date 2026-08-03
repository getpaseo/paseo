import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

import { getOrCreateCliClientId } from "./client-id.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("getOrCreateCliClientId", () => {
  test("reuses one identifier for concurrent connections in this process", async () => {
    const [first, second] = await Promise.all([getOrCreateCliClientId(), getOrCreateCliClientId()]);

    expect(first).toMatch(/^cid_[0-9a-f]{32}$/);
    expect(second).toBe(first);
  });

  test("gives separate OS processes distinct identifiers and ignores a stale persisted id", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-cli-client-id-"));
    temporaryDirectories.push(paseoHome);
    const staleClientId = "cid_stale_cross_process_identity";
    await writeFile(join(paseoHome, "cli-client-id"), staleClientId, { mode: 0o600 });

    const moduleUrl = pathToFileURL(join(import.meta.dirname, "client-id.ts")).href;
    const readClientId = [
      `import { getOrCreateCliClientId } from ${JSON.stringify(moduleUrl)};`,
      "process.stdout.write(await getOrCreateCliClientId());",
    ].join("\n");
    const childOptions = {
      env: { ...process.env, PASEO_HOME: paseoHome },
      encoding: "utf8" as const,
    };

    const [first, second] = await Promise.all([
      execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", readClientId],
        childOptions,
      ),
      execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", readClientId],
        childOptions,
      ),
    ]);

    expect(first.stdout).toMatch(/^cid_[0-9a-f]{32}$/);
    expect(second.stdout).toMatch(/^cid_[0-9a-f]{32}$/);
    expect(first.stdout).not.toBe(staleClientId);
    expect(second.stdout).not.toBe(staleClientId);
    expect(second.stdout).not.toBe(first.stdout);
  });
});
