import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
  "installation.replacement-fences-stale-generation-through-session",
  "installation.replacement-fences-stale-nonce-through-session",
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

function isolatedRun(artifact, args) {
  return JSON.parse(
    execFileSync(artifact, args, {
      cwd: "/",
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    }),
  );
}

describe("plugin host authority conformance executable", () => {
  test("builds a fresh source bundle and emits every literal production-path case", () => {
    const outputDirectory = mkdtempSync(path.join(tmpdir(), "paseo-plugin-host-build-"));
    try {
      const buildOutput = execFileSync(
        process.execPath,
        [buildScript, "--out-dir", outputDirectory, "--developer-allow-dirty"],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const build = JSON.parse(buildOutput.trim());
      const manifest = JSON.parse(readFileSync(build.manifest, "utf8"));
      const artifact = readFileSync(build.artifact, "utf8");
      expect(artifact.startsWith("#!/usr/bin/env node\n")).toBe(true);
      expect(statSync(build.artifact).mode & 0o777).toBe(0o755);
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
      expect(manifest.package).toBe("plugin-host-conformance.tgz");
      expect(manifest.artifactSha256).toBe(createHash("sha256").update(artifact).digest("hex"));
      expect(Object.keys(manifest.runtimeDependencies).sort()).toEqual(
        ["@babel/parser", `@esbuild/${process.platform}-${process.arch}`, "esbuild", "zod"].sort(),
      );
      const extractedDirectory = mkdtempSync(path.join(tmpdir(), "paseo-plugin-host-package-"));
      try {
        execFileSync("tar", ["-xzf", build.package, "-C", extractedDirectory], {
          cwd: "/",
        });
        const extractedArtifact = path.join(extractedDirectory, manifest.artifact);
        const extractedPackageMetadata = JSON.parse(
          readFileSync(path.join(extractedDirectory, "package.json"), "utf8"),
        );
        expect(extractedPackageMetadata.bin).toEqual({
          "plugin-host-conformance": `./${manifest.artifact}`,
        });
        expect(statSync(extractedArtifact).mode & 0o777).toBe(0o755);
        for (const [packageSpecifier, dependency] of Object.entries(manifest.runtimeDependencies)) {
          for (const [relative, expectedHash] of Object.entries(dependency.files)) {
            const actualHash = createHash("sha256")
              .update(
                readFileSync(
                  path.join(extractedDirectory, "node_modules", packageSpecifier, relative),
                ),
              )
              .digest("hex");
            expect(actualHash).toBe(expectedHash);
          }
        }
        const isolatedRuntime = isolatedRun(extractedArtifact, ["--json"]);
        const verifiedRuntime = isolatedRun(extractedArtifact, [
          "--verify-source",
          repositoryRoot,
          "--json",
        ]);
        expect(Object.keys(isolatedRuntime).sort()).toEqual(["caseIds", "cases", "sourceCommit"]);
        expect(isolatedRuntime.caseIds).toEqual(EXPECTED_CASE_IDS);
        expect(isolatedRuntime.cases.map((result) => result.case)).toEqual(EXPECTED_CASE_IDS);
        expect(isolatedRuntime.cases.map((result) => result.ok)).toEqual(
          EXPECTED_CASE_IDS.map(() => true),
        );
        expect(
          isolatedRuntime.cases.find(
            (result) =>
              result.case === "host.child.create-inherits-live-caller-authority-after-mutation",
          ),
        ).toMatchObject({
          details: {
            childLabels: {
              purpose: "conformance",
              "paseo.parent-agent-id": "00000000-0000-4000-8000-000000000001",
            },
            childLabelCount: 128,
          },
        });
        expect(verifiedRuntime.cases.map((result) => result.ok)).toEqual(
          EXPECTED_CASE_IDS.map(() => true),
        );
      } finally {
        rmSync(extractedDirectory, { recursive: true, force: true });
      }
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
