import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { gotoAppShell } from "./app";
import { getE2EDaemonPort } from "./daemon-port";
import { waitForConnectedHost } from "./hosts";
import {
  assertNewWorkspaceSidebarAndHeader,
  connectNewWorkspaceDaemonClient,
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
  submitNewWorkspaceEmpty,
} from "./new-workspace";
import { connectSeedClient } from "./seed-client";
import { getServerId } from "./server-id";
import { createTempDirectory, createTempGitRepo } from "./workspace";

export interface SeededRuntimeProject {
  projectId: string;
  projectKey: string;
  projectDisplayName: string;
  sourceDirectory: string;
  cleanup(): Promise<void>;
}

const SETUP_MARKER = "runtime-user-setup-ran.txt";

export async function seedGitProjectForRuntime(
  options?: Parameters<typeof createTempGitRepo>[1],
): Promise<SeededRuntimeProject> {
  const repo = await createTempGitRepo("runtime-selector-", {
    ...options,
    paseoConfig: options?.paseoConfig ?? {
      worktree: { setup: [`printf setup > ${SETUP_MARKER}`] },
    },
  });
  return seedRuntimeProject(repo);
}

async function readProbeRecords(projectId: string): Promise<Array<{ workspaceId: string }>> {
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("E2E_PASEO_HOME is not set");
  const records = JSON.parse(
    await readFile(path.join(paseoHome, "projects", "provider-probes.json"), "utf8"),
  ) as Array<{ workspaceId: string; projectId: string }>;
  return records.filter((record) => record.projectId === projectId);
}

async function markerExists(root: string): Promise<boolean> {
  return access(path.join(root, SETUP_MARKER)).then(
    () => true,
    () => false,
  );
}

export async function expectProbeSkippedProjectSetup(project: SeededRuntimeProject): Promise<void> {
  expect(await markerExists(project.sourceDirectory)).toBe(false);
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("E2E_PASEO_HOME is not set");
  const probeIds = new Set(
    (await readProbeRecords(project.projectId)).map((record) => record.workspaceId),
  );
  const stateDirectory = path.join(paseoHome, "fixture-runtime");
  const stateFiles = await readdir(stateDirectory);
  const states = await Promise.all(
    stateFiles.map(
      async (file) =>
        JSON.parse(await readFile(path.join(stateDirectory, file), "utf8")) as {
          workspaceId: string;
          root: string;
        },
    ),
  );
  const probe = states.find((state) => probeIds.has(state.workspaceId));
  expect(probe, "fixture probe runtime state").toBeDefined();
  expect(await markerExists(probe!.root)).toBe(false);
}

export async function expectUserWorkspaceRanProjectSetup(
  project: SeededRuntimeProject,
): Promise<void> {
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("E2E_PASEO_HOME is not set");
  const records = JSON.parse(
    await readFile(path.join(paseoHome, "projects", "workspaces.json"), "utf8"),
  ) as Array<{ projectId: string; workspaceId: string; runtime?: { runtimeId: string } }>;
  const workspace = records.find(
    (record) => record.projectId === project.projectId && record.runtime?.runtimeId === "fixture",
  );
  expect(workspace, "fixture user workspace record").toBeDefined();
  const stateFiles = await readdir(path.join(paseoHome, "fixture-runtime"));
  const states = await Promise.all(
    stateFiles.map(
      async (file) =>
        JSON.parse(await readFile(path.join(paseoHome, "fixture-runtime", file), "utf8")) as {
          workspaceId: string;
          root: string;
        },
    ),
  );
  const state = states.find((candidate) => candidate.workspaceId === workspace!.workspaceId);
  expect(state, "fixture user runtime state").toBeDefined();
  await expect.poll(() => markerExists(state!.root), { timeout: 30_000 }).toBe(true);
}

export async function expectProviderAvailable(page: Page, providerLabel: string): Promise<void> {
  const trigger = page.getByRole("button", { name: /Select model/ });
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Back", exact: true }).click();
  await page.getByText(providerLabel, { exact: true }).click();
  await expect(page.getByRole("button", { name: `Open ${providerLabel} settings` })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

export async function selectRuntimeProviderModel(
  page: Page,
  input: { provider: string; model: string },
): Promise<void> {
  const trigger = page.getByRole("button", { name: /Select model/ });
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.click();
  const dialog = page.getByRole("dialog").last();
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await dialog.getByText(input.provider, { exact: true }).click();
  const model = dialog.getByText(input.model, { exact: true });
  await expect(model).toBeVisible({ timeout: 30_000 });
  await model.click();
  await expect(trigger).toContainText(input.model);
}

export async function expectRuntimeProviderUnavailable(
  page: Page,
  providerLabel: string,
): Promise<void> {
  const trigger = page.getByRole("button", { name: /Select model/ });
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.click();
  const dialog = page.getByRole("dialog").last();
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  const providerId = providerLabel.toLowerCase().replaceAll(" ", "");
  const providerRow = dialog.getByTestId(`model-provider-${providerId}`);
  await expect(providerRow).toBeVisible({ timeout: 30_000 });
  await expect(providerRow).toHaveText(`${providerLabel}Error`);
  await page.keyboard.press("Escape");
}

export async function expectFixtureProviderUnavailable(page: Page): Promise<void> {
  const providerLabel = "Fixture Agent";
  const trigger = page.getByRole("button", { name: /Select model/ });
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Back", exact: true }).click();
  await page.getByText(providerLabel, { exact: true }).click();
  await expect(page.getByRole("button", { name: `Open ${providerLabel} settings` })).toBeVisible();
  await expect(page.getByText(/^Fixture Model/u)).not.toBeVisible();
  await page.keyboard.press("Escape");
}

export async function expectProbeFailureWithRetry(page: Page, message: string): Promise<void> {
  await expect(page.getByRole("alert")).toContainText(message, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Select model/ })).toBeDisabled();
  await expect(page.getByText("Fixture Agent", { exact: true })).not.toBeVisible();
}

export async function retryFailedProbe(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Retry", exact: true }).click();
}

export async function expectNoProbeInWorkspaceProjection(
  page: Page,
  project: SeededRuntimeProject,
): Promise<void> {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  try {
    const probeIds = new Set(
      (await readProbeRecords(project.projectId)).map((record) => record.workspaceId),
    );
    const workspaces = await client.fetchWorkspaces({ filter: { projectId: project.projectId } });
    expect(workspaces.entries.some((workspace) => probeIds.has(workspace.id))).toBe(false);
    for (const probeId of probeIds) {
      await expect(page.getByTestId(`sidebar-workspace-${probeId}`)).toHaveCount(0);
    }
  } finally {
    await client.close();
  }
}

export async function seedNonGitProjectForRuntime(): Promise<SeededRuntimeProject> {
  const directory = await createTempDirectory("runtime-selector-non-git-");
  return seedRuntimeProject(directory);
}

async function seedRuntimeProject(resource: {
  path: string;
  cleanup(): Promise<void>;
}): Promise<SeededRuntimeProject> {
  const client = await connectSeedClient();
  const added = await client.addProject(resource.path);
  if (added.error || !added.project) {
    await client.close();
    await resource.cleanup();
    throw new Error(added.error ?? "Runtime project was not added");
  }
  const listed = await client.listProjects();
  const project = listed.projects.find(
    (candidate) => candidate.projectId === added.project?.projectId,
  );
  if (!project?.projectKey) {
    await client.close();
    await resource.cleanup();
    throw new Error("Runtime project has no project key");
  }
  return {
    projectId: added.project.projectId,
    projectKey: project.projectKey,
    projectDisplayName: added.project.projectDisplayName,
    sourceDirectory: resource.path,
    cleanup: async () => {
      await client.removeProject(added.project!.projectId);
      await client.close();
      await resource.cleanup();
    },
  };
}

export async function gotoNewWorkspaceForRuntime(
  page: Page,
  project: SeededRuntimeProject,
): Promise<void> {
  await gotoAppShell(page);
  await waitForConnectedHost(page, {
    serverId: getServerId(),
    endpoint: `localhost:${getE2EDaemonPort()}`,
  });
  await openGlobalNewWorkspaceComposer(page);
  await selectNewWorkspaceProject(page, project);
  await expect(page.getByRole("button", { name: "Runtime", exact: true })).toContainText("Local");
}

export async function expectRuntimeChoices(page: Page, labels: readonly string[]): Promise<void> {
  await page.getByRole("button", { name: "Runtime", exact: true }).click();
  const dialog = page.getByRole("dialog").last();
  for (const label of labels) {
    await expect(dialog.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  await expect(dialog.getByRole("button")).toHaveCount(labels.length);
  await page.keyboard.press("Escape");
}

export async function expectRuntimeSelected(page: Page, label: string): Promise<void> {
  await expect(page.getByRole("button", { name: "Runtime", exact: true })).toContainText(label);
}

export async function selectRuntime(page: Page, label: string): Promise<void> {
  const trigger = page.getByRole("button", { name: "Runtime", exact: true });
  await trigger.click();
  await page.getByRole("dialog").last().getByRole("button", { name: label, exact: true }).click();
  await expect(trigger).toContainText(label);
}

export async function createWorkspaceInSelectedRuntime(page: Page): Promise<void> {
  await submitNewWorkspaceEmpty(page);
}

export async function expectWorkspaceOpenInRuntime(
  page: Page,
  project: SeededRuntimeProject,
  runtimeId: string,
): Promise<string> {
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  try {
    const workspace = await assertNewWorkspaceSidebarAndHeader(page, {
      serverId: getServerId(),
      client,
      previousWorkspaceId: "",
      projectDisplayName: project.projectDisplayName,
      timeoutMs: 120_000,
    });
    const paseoHome = process.env.E2E_PASEO_HOME;
    if (!paseoHome) throw new Error("E2E_PASEO_HOME is not set");
    const records = JSON.parse(
      await readFile(path.join(paseoHome, "projects", "workspaces.json"), "utf8"),
    ) as Array<{ workspaceId: string; runtime?: { runtimeId: string } }>;
    const record = records.find((candidate) => candidate.workspaceId === workspace.workspaceId);
    expect(record?.runtime).toEqual({ runtimeId });
    return workspace.workspaceId;
  } finally {
    await client.close();
  }
}

export async function expectSelectedHostRuntimePlacement(
  project: SeededRuntimeProject,
  runtimeId: "local" | "worktree",
  setupRan: boolean,
): Promise<void> {
  const paseoHome = process.env.E2E_PASEO_HOME;
  if (!paseoHome) throw new Error("E2E_PASEO_HOME is not set");
  const records = JSON.parse(
    await readFile(path.join(paseoHome, "projects", "workspaces.json"), "utf8"),
  ) as Array<{
    projectId: string;
    cwd: string;
    hostVisiblePath?: string | null;
    runtime?: { runtimeId: string };
  }>;
  const workspace = records.find(
    (record) => record.projectId === project.projectId && record.runtime?.runtimeId === runtimeId,
  );
  expect(workspace, `${runtimeId} selected workspace record`).toBeDefined();
  expect(workspace?.hostVisiblePath).toBe(workspace?.cwd);
  if (setupRan) {
    await expect.poll(() => markerExists(workspace!.cwd), { timeout: 30_000 }).toBe(true);
  } else {
    expect(await markerExists(workspace!.cwd)).toBe(false);
  }
}

export async function expectHostWorkspaceAffordances(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Open workspace in VS Code" })).toBeVisible();
  await page.getByRole("button", { name: "Choose editor" }).click();
  await expect(page.getByText("VS Code", { exact: true })).toBeVisible();
  await expect(page.getByText("Finder", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
}
