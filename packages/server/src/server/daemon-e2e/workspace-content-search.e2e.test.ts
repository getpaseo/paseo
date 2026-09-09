import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

test("real client searches saved contents, cancels host work and can search again", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "paseo-content-rpc-"));
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  try {
    await writeFile(path.join(cwd, "a.ts"), "const original = 'NEEDLE';\n");
    await client.connect();
    await client.fetchAgents();
    const result = await client.searchWorkspaceContent({ cwd, query: "needle" });
    expect(
      result.status === "ok" && result.matches.map((match) => [match.path, match.text]),
    ).toEqual([["a.ts", "NEEDLE"]]);
    const controller = new AbortController();
    const searching = client.searchWorkspaceContent(
      { cwd, query: "absent" },
      { signal: controller.signal },
    );
    controller.abort();
    expect(await searching).toMatchObject({ status: "error", code: "cancelled" });
    expect(await client.searchWorkspaceContent({ cwd, query: "missing" })).toEqual({
      status: "ok",
      matches: [],
      limited: false,
    });
    const preview = await client.readFile(cwd, "a.ts", undefined, 1_048_576);
    expect(new TextDecoder().decode(preview.bytes)).toBe("const original = 'NEEDLE';\n");
  } finally {
    await client.close();
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);
