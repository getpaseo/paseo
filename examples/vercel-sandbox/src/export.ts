import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  createReadStream,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import type { Sandbox } from "@vercel/sandbox";
import type { SessionState } from "./types.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export async function exportWorkspace(
  sandbox: Sandbox,
  state: SessionState,
  outputPath: string,
): Promise<void> {
  const tmp = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "paseo-export-"));
  const remoteTar = "/tmp/paseo-export.tar";
  const localTar = join(tmp, "repo.tar");
  try {
    const result = await sandbox.runCommand("bash", [
      "-lc",
      `cd ${shellQuote(state.workspacePath)} && tar cf ${remoteTar} .`,
    ]);
    if (result.exitCode !== 0) {
      const stderr = await result.stderr();
      throw new Error(`export tar failed: exit ${result.exitCode}\n${stderr}`);
    }

    let downloadError: unknown;
    try {
      await sandbox.downloadFile({ path: remoteTar }, { path: localTar });
    } catch (error) {
      downloadError = error;
    }
    const cleanup = await sandbox.runCommand("rm", ["-f", remoteTar]);
    if (cleanup.exitCode !== 0) {
      const stderr = await cleanup.stderr();
      throw new Error(`export cleanup failed: exit ${cleanup.exitCode}\n${stderr}`);
    }
    if (downloadError) throw downloadError;

    mkdirSync(dirname(outputPath), { recursive: true });
    mkdirSync(outputPath);
    const extraction = spawnSync("tar", ["-xf", localTar, "-C", outputPath], { stdio: "inherit" });
    if (extraction.error || extraction.status !== 0) {
      throw new Error(
        `export extraction failed: ${extraction.error ?? `exit ${extraction.status}`}`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function writeFileHashManifest(
  outputPath: string,
  localPath: string,
): Promise<Record<string, string>> {
  const manifest: Record<string, string> = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = readdirSync(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = join(directory, entry.name);
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(file, relative);
      else if (entry.isFile()) {
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(file)) digest.update(chunk);
        manifest[relative] = digest.digest("hex");
      }
    }
  }
  await visit(outputPath, ".");
  writeFileSync(localPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return manifest;
}
