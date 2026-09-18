import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyExport, hash } from "../scripts/live-support.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { exportWorkspace, writeFileHashManifest } = await import("../dist/export.js");

test("export extracts special-character destinations without shell interpretation", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-export-test-"));
  const source = join(root, "source");
  const outputPath = join(root, "export $(printf should-not-run) 'quoted'");
  mkdirSync(source, { recursive: true });
  const textPath = join(source, "notes $(printf no-shell) 'x'.txt");
  writeFileSync(textPath, "special path contents");
  const binaryPath = join(source, "binary.bin");
  const binary = Buffer.from([0, 1, 2, 253, 254, 255]);
  writeFileSync(binaryPath, binary);
  const remoteTar = join(root, "remote.tar");

  let localTempParent;
  let remoteCleanup = false;
  const sandbox = {
    async runCommand(cmd, args = []) {
      if (cmd === "bash" && args.at(-1)?.includes("tar cf")) {
        spawnSync("tar", ["-cf", remoteTar, "-C", source, "."]);
        return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
      }
      if (cmd === "rm" && args.includes("/tmp/paseo-export.tar")) {
        remoteCleanup = true;
        return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
      }
      return {
        exitCode: 1,
        stdout: async () => "",
        stderr: async () => `unexpected ${cmd} ${args.join(" ")}`,
      };
    },
    async downloadFile(remote, local) {
      localTempParent = join(local.path, "..");
      const listing = spawnSync("tar", ["-tf", remoteTar]);
      assert.equal(listing.status, 0);
      const copy = spawnSync("cp", [remoteTar, local.path]);
      assert.equal(copy.status, 0);
    },
  };

  await exportWorkspace(sandbox, { workspacePath: source }, outputPath);

  assert.equal(
    readFileSync(join(outputPath, "notes $(printf no-shell) 'x'.txt"), "utf8"),
    "special path contents",
  );
  assert.deepEqual(readFileSync(join(outputPath, "binary.bin")), binary);
  assert.equal(remoteCleanup, true);
  assert.equal(existsSync(localTempParent), false);
});

test("export preserves a genuine workspace manifest.json beside the generated sidecar", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-export-manifest-"));
  try {
    const source = join(root, "source"),
      output = join(root, "export");
    mkdirSync(source);
    const original = '{"application":"genuine workspace manifest"}\n';
    writeFileSync(join(source, "manifest.json"), original);
    writeFileSync(join(source, "notes.txt"), "notes");
    const tar = join(root, "remote.tar");
    const manifest = { "./manifest.json": hash(original), "./notes.txt": hash("notes") };
    const sandbox = {
      async runCommand(cmd, args) {
        if (cmd === "rm") return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
        if (args.at(-1).includes("tar cf")) {
          const result = spawnSync("tar", ["-cf", tar, "-C", source, "."]);
          assert.equal(result.status, 0);
          return { exitCode: 0, stdout: async () => "", stderr: async () => "" };
        }
        assert.ok(args.at(-1).includes("sha256sum"));
        return {
          exitCode: 0,
          stdout: async () =>
            Object.entries(manifest)
              .map(([path, digest]) => `${digest}  ${path}\n`)
              .join(""),
          stderr: async () => "",
        };
      },
      async downloadFile(_remote, local) {
        writeFileSync(local.path, readFileSync(tar));
      },
    };
    await exportWorkspace(sandbox, { workspacePath: source }, output);
    const sidecar = `${output}.manifest.json`;
    await writeFileHashManifest(output, sidecar);
    assert.equal(readFileSync(join(output, "manifest.json"), "utf8"), original);
    assert.deepEqual(JSON.parse(readFileSync(sidecar, "utf8")), manifest);
    assert.equal(verifyExport(output, manifest).files, 2);
    writeFileSync(join(output, "manifest.json"), "corrupted");
    assert.throws(() => verifyExport(output, manifest), /export hash mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI rejects an existing sidecar before session lookup or exporting files", () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-export-collision-"));
  try {
    const output = join(root, "export"),
      sidecar = `${output}.manifest.json`;
    writeFileSync(sidecar, "keep this sidecar");
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
        "export",
        randomUUID(),
        "--output",
        output,
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, PASEO_SANDBOX_STATE_DIR: join(root, "state") },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manifest sidecar exists:/);
    assert.equal(existsSync(output), false);
    assert.equal(readFileSync(sidecar, "utf8"), "keep this sidecar");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hash manifest exclusive write preserves a sidecar created after preflight", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-export-race-"));
  try {
    const sidecar = join(root, "export.manifest.json");
    const output = join(root, "export");
    mkdirSync(output);
    writeFileSync(join(output, "file.txt"), "data");
    writeFileSync(sidecar, "created concurrently");
    await assert.rejects(writeFileHashManifest(output, sidecar), { code: "EEXIST" });
    assert.equal(readFileSync(sidecar, "utf8"), "created concurrently");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("export preserves a destination created after preflight", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-export-directory-race-"));
  try {
    const source = join(root, "source"),
      output = join(root, "export"),
      archive = join(root, "remote.tar");
    mkdirSync(source);
    writeFileSync(join(source, "notes.txt"), "archive contents");
    assert.equal(spawnSync("tar", ["-cf", archive, "-C", source, "."]).status, 0);
    const sandbox = {
      async runCommand() {
        return { exitCode: 0, stderr: async () => "" };
      },
      async downloadFile(_remote, local) {
        writeFileSync(local.path, readFileSync(archive));
        mkdirSync(output);
        writeFileSync(join(output, "notes.txt"), "created concurrently");
      },
    };
    await assert.rejects(exportWorkspace(sandbox, { workspacePath: source }, output), {
      code: "EEXIST",
    });
    assert.equal(readFileSync(join(output, "notes.txt"), "utf8"), "created concurrently");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest describes exported bytes when the remote workspace changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "paseo-export-changed-"));
  try {
    const output = join(root, "export");
    mkdirSync(output);
    writeFileSync(join(output, "file.txt"), "archived bytes");
    const remote = join(root, "remote");
    mkdirSync(remote);
    writeFileSync(join(remote, "file.txt"), "later remote bytes");
    const manifest = await writeFileHashManifest(output, `${output}.manifest.json`);
    assert.equal(manifest["./file.txt"], hash("archived bytes"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
