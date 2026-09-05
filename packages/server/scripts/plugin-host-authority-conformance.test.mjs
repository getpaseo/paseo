import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const EXPECTED_CASE_IDS = [
  "compiler.target-bounded-bundles",
  "runtime.compiles-loads-and-publishes-tool",
  "host.delivery.targets-live-caller-and-is-idempotent",
  "host.worktree.create-remove-enforces-ownership-and-persists",
  "host.child.create-inherits-live-caller-authority-after-mutation",
  "host.unauthorized-or-stale-selector-rejected",
  "delivery.reconnects-stable-installation-and-tombstones",
  "installation.replacement-fences-stale-generation-and-nonce-through-session",
];
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const buildScript = path.join(scriptDirectory, "build-plugin-host-conformance.mjs");

function trackedSourceInputs() {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter((relative) => /\.(?:[cm]?js|[cm]?ts|jsx?|tsx?|json)$/u.test(relative))
    .sort();
}

function independentlyHashedInputs(sourceInputs) {
  const actual = {};
  for (const relative of Object.keys(sourceInputs).sort()) {
    actual[relative] = createHash("sha256")
      .update(readFileSync(path.join(repositoryRoot, relative)))
      .digest("hex");
  }
  expect(sourceInputs).toEqual(actual);
  expect(Object.keys(sourceInputs)).toEqual(expect.arrayContaining(trackedSourceInputs()));
}

describe("plugin host authority conformance executable", () => {
  test("builds a fresh source bundle and emits every literal production-path case", () => {
    const outputDirectory = mkdtempSync(path.join(tmpdir(), "paseo-plugin-host-build-"));
    try {
      const buildOutput = execFileSync(
        process.execPath,
        [buildScript, "--out-dir", outputDirectory],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const build = JSON.parse(buildOutput.trim());
      const manifest = JSON.parse(readFileSync(build.manifest, "utf8"));
      const artifact = readFileSync(build.artifact, "utf8");
      const embeddedMatch = artifact.match(/const __PASEO_SOURCE_MANIFEST__ = (\{[\s\S]*?\});/u);
      expect(embeddedMatch).not.toBeNull();
      const embedded = JSON.parse(embeddedMatch[1]);
      const runtime = JSON.parse(
        execFileSync(
          process.execPath,
          [build.artifact, "--verify-source", repositoryRoot, "--json"],
          {
            cwd: repositoryRoot,
            encoding: "utf8",
          },
        ),
      );
      expect(manifest.caseIds).toEqual(EXPECTED_CASE_IDS);
      expect(embedded.formatVersion).toBe(1);
      expect(embedded.sourceCommit).toBe(manifest.sourceCommit);
      expect(embedded.sourceInputs).toEqual(manifest.sourceInputs);
      independentlyHashedInputs(embedded.sourceInputs);
      expect(runtime.caseIds).toEqual(EXPECTED_CASE_IDS);
      expect(runtime.cases.map((result) => result.case)).toEqual(EXPECTED_CASE_IDS);
      expect(runtime.cases.map((result) => result.ok)).toEqual(EXPECTED_CASE_IDS.map(() => true));
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, 120_000);
});
