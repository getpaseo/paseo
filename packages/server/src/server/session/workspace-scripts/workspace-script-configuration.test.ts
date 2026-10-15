import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  readWorkspaceScriptConfiguration,
  writeWorkspaceScriptConfiguration,
} from "./workspace-script-configuration.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `paseo-${name}-`));
  roots.push(root);
  return root;
}

function config(root: string, value: unknown): void {
  writeFileSync(join(root, "paseo.json"), JSON.stringify(value, null, 2));
}

test("writes the selected service to project and workspace while preserving their other scripts", () => {
  const projectDirectory = directory("project-script-config");
  const workspaceDirectory = directory("workspace-script-config");
  config(projectDirectory, { scripts: { build: { command: "npm run build" } }, custom: true });
  config(workspaceDirectory, { scripts: { test: { command: "npm test" } } });
  const snapshot = readWorkspaceScriptConfiguration({ projectDirectory, workspaceDirectory });
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) return;

  const written = writeWorkspaceScriptConfiguration({
    projectDirectory,
    workspaceDirectory,
    scriptName: "dev",
    command: "npm run dev",
    port: 4321,
    projectRevision: snapshot.projectRevision,
    workspaceRevision: snapshot.workspaceRevision,
  });

  expect(written).toMatchObject({ ok: true, written: "both" });
  expect(JSON.parse(readFileSync(join(projectDirectory, "paseo.json"), "utf8"))).toEqual({
    scripts: {
      build: { command: "npm run build" },
      dev: { type: "service", command: "npm run dev", port: 4321 },
    },
    custom: true,
  });
  expect(JSON.parse(readFileSync(join(workspaceDirectory, "paseo.json"), "utf8"))).toEqual({
    scripts: {
      test: { command: "npm test" },
      dev: { type: "service", command: "npm run dev", port: 4321 },
    },
  });
});

test("writes a shared project and workspace config once", () => {
  const root = directory("shared-script-config");
  config(root, { scripts: { dev: { command: "vite", type: "service" } }, extra: 1 });
  const snapshot = readWorkspaceScriptConfiguration({
    projectDirectory: root,
    workspaceDirectory: root,
  });
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) return;
  const written = writeWorkspaceScriptConfiguration({
    projectDirectory: root,
    workspaceDirectory: root,
    scriptName: "dev",
    command: "vite --host",
    port: null,
    projectRevision: snapshot.projectRevision,
    workspaceRevision: snapshot.workspaceRevision,
  });
  expect(written).toMatchObject({ ok: true, written: "both" });
  expect(JSON.parse(readFileSync(join(root, "paseo.json"), "utf8"))).toEqual({
    scripts: { dev: { command: "vite --host", type: "service" } },
    extra: 1,
  });
});

test("rejects a stale revision and never replaces an ordinary script", () => {
  const projectDirectory = directory("stale-script-config");
  const workspaceDirectory = directory("collision-script-config");
  config(projectDirectory, { scripts: {} });
  config(workspaceDirectory, { scripts: { dev: { command: "echo ordinary" } } });
  const snapshot = readWorkspaceScriptConfiguration({ projectDirectory, workspaceDirectory });
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) return;
  writeFileSync(
    join(workspaceDirectory, "paseo.json"),
    JSON.stringify({ scripts: { dev: { command: "changed" } } }),
  );
  const stale = writeWorkspaceScriptConfiguration({
    projectDirectory,
    workspaceDirectory,
    scriptName: "server",
    command: "npm run dev",
    port: null,
    projectRevision: snapshot.projectRevision,
    workspaceRevision: snapshot.workspaceRevision,
  });
  expect(stale).toMatchObject({ ok: false, error: "stale_revision", written: "none" });

  const fresh = readWorkspaceScriptConfiguration({ projectDirectory, workspaceDirectory });
  expect(fresh.ok).toBe(true);
  if (!fresh.ok) return;
  const collision = writeWorkspaceScriptConfiguration({
    projectDirectory,
    workspaceDirectory,
    scriptName: "dev",
    command: "npm run dev",
    port: null,
    projectRevision: fresh.projectRevision,
    workspaceRevision: fresh.workspaceRevision,
  });
  expect(collision).toMatchObject({ ok: false, error: "collision", written: "none" });
  expect(
    JSON.parse(readFileSync(join(workspaceDirectory, "paseo.json"), "utf8")).scripts.dev.command,
  ).toBe("changed");
});

test("reports a partial save when the workspace file cannot be written after the project save", () => {
  const projectDirectory = directory("partial-project-config");
  const missingWorkspaceDirectory = join(directory("partial-parent"), "missing-workspace");
  mkdirSync(projectDirectory, { recursive: true });
  config(projectDirectory, { scripts: {} });
  const snapshot = readWorkspaceScriptConfiguration({
    projectDirectory,
    workspaceDirectory: missingWorkspaceDirectory,
  });
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) return;
  const result = writeWorkspaceScriptConfiguration({
    projectDirectory,
    workspaceDirectory: missingWorkspaceDirectory,
    scriptName: "dev",
    command: "npm run dev",
    port: null,
    projectRevision: snapshot.projectRevision,
    workspaceRevision: snapshot.workspaceRevision,
  });
  expect(result).toMatchObject({ ok: false, written: "project", error: "workspace_write_failed" });
  expect(
    JSON.parse(readFileSync(join(projectDirectory, "paseo.json"), "utf8")).scripts.dev.type,
  ).toBe("service");
});
