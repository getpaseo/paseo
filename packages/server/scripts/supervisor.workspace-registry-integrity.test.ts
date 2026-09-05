import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const supervisorEntrypointPath = fileURLToPath(
  new URL("./supervisor-entrypoint.ts", import.meta.url),
);

const tempHomes = new Set<string>();
const children = new Set<ChildProcess>();

function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function contentHash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function beforeImage(contents: string) {
  return { exists: true as const, contents, contentHash: contentHash(contents) };
}

async function createPaseoHome(): Promise<string> {
  const paseoHome = await mkdtemp(path.join(tmpdir(), "paseo-supervisor-integrity-"));
  tempHomes.add(paseoHome);
  await mkdir(path.join(paseoHome, "projects"), { recursive: true });
  return paseoHome;
}

function startRealSupervisor(paseoHome: string): {
  child: ChildProcess;
  output: () => string;
} {
  const child = spawn(process.execPath, ["--import", "tsx", supervisorEntrypointPath, "--dev"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PASEO_HOME: paseoHome,
      PASEO_LISTEN: "127.0.0.1:0",
      PASEO_NODE_ENV: "test",
      PASEO_NODE_INSPECT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);

  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    output += chunk;
  });
  child.once("close", () => children.delete(child));

  return { child, output: () => output };
}

async function readLog(paseoHome: string): Promise<string> {
  return readFile(path.join(paseoHome, "daemon.log"), "utf8").catch(() => "");
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs = 20_000,
  diagnostics?: () => string | Promise<string>,
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      void (async () => {
        const details = await Promise.resolve(diagnostics?.() ?? "");
        reject(new Error(`Supervisor did not exit${details ? `\n${details}` : ""}`));
      })();
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function seedPreparedAuxiliaryConflict(paseoHome: string): Promise<{
  primaryPath: string;
  sidecarPath: string;
  transactionPath: string;
}> {
  const projectsPath = path.join(paseoHome, "projects");
  const primaryPath = path.join(projectsPath, "workspaces.json");
  const sidecarPath = path.join(projectsPath, "workspace-pin-groups.json");
  const backupPath = path.join(projectsPath, "workspace-pin-groups.backup.json");
  const markerPath = path.join(projectsPath, "workspace-pin-groups.expected.json");
  const transactionPath = path.join(projectsPath, "workspace-pin-groups.transaction.json");
  const primary = serializeJson([]);
  const marker = `${JSON.stringify({ formatVersion: 1 })}\n`;
  const beforeSidecar = serializeJson({
    groups: [{ id: "default", name: "Pinned", createdAt: "2026-09-01T00:00:00.000Z" }],
    memberships: {},
    formatVersion: 1,
    primaryContentHash: contentHash(primary),
  });
  const afterSidecarValue = {
    groups: [
      { id: "default", name: "Pinned", createdAt: "2026-09-01T00:00:00.000Z" },
      { id: "pgrp_focus", name: "Focus", createdAt: "2026-09-01T00:01:00.000Z" },
    ],
    memberships: {},
    formatVersion: 1,
    primaryContentHash: contentHash(primary),
  };
  const afterSidecar = serializeJson(afterSidecarValue);
  const conflictingSidecar = serializeJson({
    ...afterSidecarValue,
    groups: [
      ...afterSidecarValue.groups,
      { id: "pgrp_other", name: "Other", createdAt: "2026-09-01T00:02:00.000Z" },
    ],
  });

  await Promise.all([
    writeFile(primaryPath, primary),
    writeFile(sidecarPath, conflictingSidecar),
    writeFile(backupPath, beforeSidecar),
    writeFile(markerPath, marker),
    writeFile(
      transactionPath,
      serializeJson({
        formatVersion: 1,
        phase: "prepared",
        beforeWorkspaces: beforeImage(primary),
        afterWorkspaces: [],
        afterWorkspacesContentHash: contentHash(primary),
        beforePinGroups: beforeImage(beforeSidecar),
        afterPinGroups: afterSidecarValue,
        afterPinGroupsContentHash: contentHash(afterSidecar),
        beforePinGroupsBackup: beforeImage(beforeSidecar),
        afterPinGroupsBackupContentHash: contentHash(afterSidecar),
        beforeMarker: beforeImage(marker),
        afterMarkerContentHash: contentHash(marker),
      }),
    ),
  ]);

  return { primaryPath, sidecarPath, transactionPath };
}

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all([...tempHomes].map((paseoHome) => rm(paseoHome, { recursive: true })));
  children.clear();
  tempHomes.clear();
});

describe("real supervisor workspace registry integrity handling", () => {
  test("does not restart the real daemon worker after an integrity bootstrap failure", async () => {
    const paseoHome = await createPaseoHome();
    const { primaryPath, sidecarPath, transactionPath } =
      await seedPreparedAuxiliaryConflict(paseoHome);
    const { child, output } = startRealSupervisor(paseoHome);

    expect(
      await waitForExit(child, 20_000, async () => `${output()}\n${await readLog(paseoHome)}`),
    ).toBe(0);

    const log = await readLog(paseoHome);
    expect(log.match(/"msg":"Spawning worker"/g)).toHaveLength(1);
    const combinedOutput = `${log}\n${output()}`;
    expect(combinedOutput).toContain("WorkspaceRegistryIntegrityError");
    expect(combinedOutput).toContain("ambiguous pin-group sidecar state");
    expect(combinedOutput).toContain("Recover only as a complete snapshot");
    expect(combinedOutput).toContain(primaryPath);
    expect(combinedOutput).toContain(sidecarPath);
    expect(combinedOutput).toContain(transactionPath);
    expect(log).toContain('"reason":"workspace_registry_integrity_failure"');
    expect(existsSync(path.join(paseoHome, "paseo.pid"))).toBe(false);
  }, 30_000);

  test("restarts the real daemon worker after an ordinary bootstrap failure", async () => {
    const paseoHome = await createPaseoHome();
    await writeFile(path.join(paseoHome, "projects", "workspaces.json"), "CORRUPT");
    const { child, output } = startRealSupervisor(paseoHome);

    await waitFor(
      async () => ((await readLog(paseoHome)).match(/"msg":"Spawning worker"/g)?.length ?? 0) >= 2,
      "the ordinary bootstrap failure to spawn a second worker",
    );
    child.kill("SIGTERM");
    expect(await waitForExit(child)).toBe(0);

    const log = await readLog(paseoHome);
    expect(log.match(/"msg":"Spawning worker"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(log).toContain("Restarting worker");
    expect(`${log}\n${output()}`).toContain("Unexpected token");
    expect(log).not.toContain('"reason":"workspace_registry_integrity_failure"');
    expect(existsSync(path.join(paseoHome, "paseo.pid"))).toBe(false);
  }, 30_000);
});
