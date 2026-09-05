import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const EXPECTED_CASE_IDS = [
  "compiler.target-bounded-bundles",
  "runtime.compiles-loads-and-publishes-tool",
  "host.delivery.targets-live-caller-and-is-idempotent",
  "host.child.create-inherits-live-caller-authority-after-mutation",
  "host.unauthorized-or-stale-selector-rejected",
  "delivery.reconnects-stable-installation-and-tombstones",
  "installation.replacement-fences-stale-generation-and-nonce",
];
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const buildScript = path.join(scriptDirectory, "build-plugin-host-conformance.mjs");

describe("plugin host authority conformance executable", () => {
  test("builds a fresh source bundle and emits every literal production-path case", () => {
    const outputDirectory = mkdtempSync(path.join(tmpdir(), "paseo-plugin-host-build-"));
    try {
      const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim();
      const buildOutput = execFileSync(
        process.execPath,
        [buildScript, "--out-dir", outputDirectory, ...(dirty ? ["--allow-dirty"] : [])],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const build = JSON.parse(buildOutput.trim());
      const manifest = JSON.parse(readFileSync(build.manifest, "utf8"));
      const runtime = JSON.parse(
        execFileSync(process.execPath, [build.artifact, "--json"], {
          cwd: repositoryRoot,
          encoding: "utf8",
        }),
      );
      expect(manifest.caseIds).toEqual(EXPECTED_CASE_IDS);
      expect(Object.keys(manifest.sourceInputs).length).toBeGreaterThan(0);
      expect(
        Object.keys(manifest.sourceInputs).some((input) =>
          input.endsWith("plugin-host-authority-conformance.ts"),
        ),
      ).toBe(true);
      expect(Object.keys(manifest.sourceInputs)).toEqual(
        expect.arrayContaining([
          "packages/server/src/server/plugins/compiler.ts",
          "packages/server/src/server/plugins/runtime.ts",
          "packages/server/src/server/session.ts",
          "packages/server/src/server/websocket-server.ts",
          "packages/server/src/server/deliveries/delivery-ledger.ts",
        ]),
      );
      expect(runtime.sourceCommit).toBe(manifest.sourceCommit);
      expect(runtime.caseIds).toEqual(EXPECTED_CASE_IDS);
      expect(runtime.cases.map((result) => result.case)).toEqual(EXPECTED_CASE_IDS);
      expect(runtime.cases.map((result) => result.ok)).toEqual(EXPECTED_CASE_IDS.map(() => true));
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, 120_000);
});
