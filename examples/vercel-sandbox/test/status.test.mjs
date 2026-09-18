import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
test("routine status redacts pairing and default connect instructions keep it out of argv", () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-status-"));
  try {
    const id = randomUUID(),
      secret = "https://app.paseo.sh/#offer=synthetic-private-offer";
    mkdirSync(join(dir, "sessions"));
    writeFileSync(
      join(dir, "sessions", id + ".json"),
      JSON.stringify({
        id,
        name: "test",
        phase: "ready",
        pairingUrl: secret,
        logs: [secret],
        lastError: secret,
        sessionIds: [],
        snapshotIds: [],
        snapshots: [],
      }),
    );
    const run = (args) =>
      execFileSync(process.execPath, ["dist/cli.js", ...args], {
        encoding: "utf8",
        env: { ...process.env, PASEO_SANDBOX_STATE_DIR: dir },
      });
    const status = run(["status", id]);
    assert.ok(!status.includes(secret) && !status.includes("#offer="));
    assert.equal(JSON.parse(status).hasPairing, true);
    const connect = run(["connect", id]);
    assert.ok(!connect.includes(secret));
    assert.match(connect, /PASEO_HOST=.*connect.*--url/);
    assert.equal(run(["connect", id, "--url"]).trim(), secret);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
