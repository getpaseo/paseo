import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { load } from "js-yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const workflow = load(
  readFileSync(path.join(root, ".github/workflows/desktop-release.yml"), "utf8"),
);

// Run the actual finalization shell with fixture manifests and a local gh stub.
// No GitHub requests or uploads are made by these tests.
function finalize({ omitArm64 = false, linuxResult = "success" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "paseo-linux-release-"));
  try {
    cpSync(path.join(root, "scripts"), path.join(dir, "scripts"), { recursive: true });
    symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"));
    const fixtures = [
      ["mac-manifest-x64", "latest-mac.yml", "Paseo-x64.zip"],
      ["mac-manifest-arm64", "latest-mac.yml", "Paseo-arm64.zip"],
      ["linux-manifest-x64", "latest-linux.yml", "Paseo-x86_64.AppImage"],
      ["linux-manifest-arm64", "latest-linux-arm64.yml", "Paseo-arm64.AppImage"],
      ["windows-manifest", "latest.yml", "Paseo-Setup-x64.exe"],
    ];
    for (const [folder, name, asset] of fixtures) {
      if (omitArm64 && folder === "linux-manifest-arm64") continue;
      const destination = path.join(dir, "release-manifests", folder);
      mkdirSync(destination, { recursive: true });
      writeFileSync(
        path.join(destination, name),
        `version: 0.11.2\nfiles:\n  - url: ${asset}\n    sha512: fixture\npath: ${asset}\nsha512: fixture\n`,
      );
    }
    mkdirSync(path.join(dir, "bin"));
    const calls = path.join(dir, "gh-calls");
    writeFileSync(path.join(dir, "bin/gh"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_CALLS"\n', {
      mode: 0o755,
    });
    let script = workflow.jobs["finalize-rollout"].steps.find(
      (step) => step.name === "Assemble manifests and publish release",
    ).run;
    script = script.replace(/^.*release_lookup=.*$/m, 'release_lookup="fixture-release"');
    script = script.replaceAll("${{ github.repository }}", "getpaseo/paseo");
    for (const platform of ["macos", "linux", "windows"]) {
      script = script.replaceAll(
        `\${{ needs.publish-${platform}.result }}`,
        platform === "linux" ? linuxResult : "success",
      );
    }
    const result = spawnSync("bash", ["-c", script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}/bin:${process.env.PATH}`,
        GH_CALLS: calls,
        RELEASE_CHANNEL: "latest",
        RELEASE_TAG: "v0.11.2",
        ROLLOUT_HOURS: "36",
        IS_PRERELEASE: "false",
      },
    });
    const ghCalls = readFileSync(calls, "utf8");
    const manifests =
      result.status === 0
        ? ["latest-linux.yml", "latest-linux-arm64.yml"].map((name) =>
            load(readFileSync(path.join(dir, "release-manifests/final", name), "utf8")),
          )
        : [];
    return { result, ghCalls, manifests };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Linux builds and smoke checks run on native x64 and ARM64 hosts", () => {
  const job = workflow.jobs["publish-linux"];
  assert.deepEqual(
    job.strategy.matrix.include.map((entry) => entry.electron_arch),
    ["x64", "arm64"],
  );
  assert.equal(job["runs-on"], "${{ matrix.runner }}");
  assert.equal(job.strategy.matrix.include[1].runner, "ubuntu-22.04-arm");
  const build = job.steps.find((step) => step.name === "Build desktop release");
  assert.match(build.run, /--linux --\$\{\{ matrix.electron_arch \}\}/);
  assert.equal(build.env.PASEO_DESKTOP_SMOKE, "1");
});

test("finalization publishes separate, stamped Linux update manifests", () => {
  const { result, ghCalls, manifests } = finalize();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(
    manifests.map((manifest) => manifest.files[0].url),
    ["Paseo-x86_64.AppImage", "Paseo-arm64.AppImage"],
  );
  assert.equal(manifests[0].releaseDate, manifests[1].releaseDate);
  assert.ok(manifests.every((manifest) => manifest.rolloutHours === 36));
  assert.match(ghCalls, /release edit .*--draft=false/);
});

for (const [name, options] of [
  ["missing ARM64 manifest", { omitArm64: true }],
  ["failed Linux build", { linuxResult: "failure" }],
]) {
  test(`finalization keeps the release in draft with a ${name}`, () => {
    const { result, ghCalls } = finalize(options);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(ghCalls, /--draft=false/);
  });
}
