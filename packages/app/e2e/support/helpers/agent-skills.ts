import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Dialog, type Page } from "@playwright/test";
import type { DaemonClient as InternalDaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentSkillSelection } from "@getpaseo/protocol/messages";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { gotoAppShell, openSettings } from "./app";
import { connectDaemonClient } from "./daemon-client-loader";
import { startIsolatedHostDaemon, type IsolatedHostDaemon } from "./isolated-host-daemon";
import {
  addDirectHostFromSettings,
  goBackInSettings,
  openCompactSettings,
  openHostSection,
  selectSettingsHost,
} from "./settings";

type AgentSkillsClient = Pick<
  InternalDaemonClient,
  "close" | "connect" | "getAgentSkillsStatus" | "saveAgentSkillsSelection"
>;

export type SkillTargetName = "agents" | "claude" | "codex";

export interface AgentSkillsSandbox {
  available: string[];
  client: AgentSkillsClient;
  daemon: IsolatedHostDaemon;
  home: string;
  targets: Record<SkillTargetName, string>;
  blockAgentsDirectory(): Promise<void>;
  unblockAgentsDirectory(): Promise<void>;
  close(): Promise<void>;
  getStatus(): ReturnType<AgentSkillsClient["getAgentSkillsStatus"]>;
  install(selection: AgentSkillSelection): Promise<void>;
  keepSkillOnlyIn(skill: string, target: SkillTargetName): Promise<void>;
  placeSkillOnDisk(
    skill: string,
    target: SkillTargetName,
    files?: Record<string, string>,
  ): Promise<void>;
}

export async function startAgentSkillsSandbox(): Promise<AgentSkillsSandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-agent-skills-e2e-"));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const daemon = await startIsolatedHostDaemon(`agent-skills-${randomUUID()}`, {
    environment: {
      HOME: home,
      NODE_ENV: "development",
      CLAUDE_CONFIG_DIR: path.join(root, "ignored-claude-config"),
      CODEX_HOME: path.join(root, "ignored-codex-home"),
    },
  });
  const client = await connectDaemonClient<AgentSkillsClient>({
    clientIdPrefix: "app-e2e-agent-skills",
    port: daemon.port,
  });
  const available = (await client.getAgentSkillsStatus()).available;
  const targets = {
    agents: path.join(home, ".agents", "skills"),
    claude: path.join(home, ".claude", "skills"),
    codex: path.join(home, ".codex", "skills"),
  };

  return {
    available,
    client,
    daemon,
    home,
    targets,
    blockAgentsDirectory: async () => {
      await mkdir(path.dirname(targets.agents), { recursive: true });
      await writeFile(targets.agents, "not a directory", "utf8");
    },
    unblockAgentsDirectory: async () => {
      await rm(targets.agents, { force: true });
      await mkdir(targets.agents, { recursive: true });
    },
    install: async (selection) => {
      const result = await client.saveAgentSkillsSelection(selection, available);
      if (result.confirmationRequired) {
        throw new Error(`Unexpected removal confirmation: ${result.confirmationRequired.removals}`);
      }
    },
    keepSkillOnlyIn: async (skill, target) => {
      for (const [name, directory] of Object.entries(targets)) {
        if (name === target) continue;
        await rm(path.join(directory, skill), { recursive: true, force: true });
      }
    },
    placeSkillOnDisk: async (skill, target, files = { "SKILL.md": `# ${skill}\n` }) => {
      const directory = path.join(targets[target], skill);
      for (const [relativePath, contents] of Object.entries(files)) {
        const file = path.join(directory, relativePath);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, contents, "utf8");
      }
    },
    close: async () => {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
    getStatus: async () => {
      try {
        return await client.getAgentSkillsStatus();
      } catch {
        await client.connect();
        return client.getAgentSkillsStatus();
      }
    },
  };
}

export async function openAgentSkillsSettings(
  page: Page,
  sandbox: AgentSkillsSandbox,
  options: { compact?: boolean } = {},
): Promise<void> {
  await gotoAppShell(page);
  if (options.compact) {
    await openCompactSettings(page, buildOpenProjectRoute());
  } else {
    await openSettings(page);
  }
  await addDirectHostFromSettings(page, {
    host: "127.0.0.1",
    port: sandbox.daemon.port,
  });
  if (options.compact) await goBackInSettings(page);
  await selectSettingsHost(page, sandbox.daemon.serverId);
  await openHostSection(page, sandbox.daemon.serverId, "agents");
  await expect(page.getByTestId("host-agent-skills-card")).toBeVisible();
}

export async function openSkillSelection(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Choose skills", exact: true }).click();
  await expectSkillSelectionOpen(page);
}

export async function expectSkillSelectionOpen(page: Page): Promise<void> {
  await expect(page.getByRole("switch", { name: "All skills", exact: true })).toBeVisible();
}

export async function chooseCustomSkills(page: Page, selected: string[]): Promise<void> {
  const all = page.getByRole("switch", { name: "All skills", exact: true });
  await expect(all).toBeChecked();
  await all.click();
  const keep = new Set(selected);
  for (const name of await listSkillChoices(page)) {
    if (!keep.has(name)) await page.getByRole("checkbox", { name, exact: true }).click();
  }
  await expectSkillChoices(page, selected);
}

export async function chooseAllSkills(page: Page): Promise<void> {
  const all = page.getByRole("switch", { name: "All skills", exact: true });
  await expect(all).not.toBeChecked();
  await all.click();
  await expect(all).toBeChecked();
}

export async function saveSkillSelection(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Save", exact: true }).click();
}

export async function cancelSkillSelection(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("switch", { name: "All skills", exact: true })).toHaveCount(0);
}

export async function toggleSkill(page: Page, name: string): Promise<void> {
  await page.getByRole("checkbox", { name, exact: true }).click();
}

export function answerNextRemovalWarning(
  page: Page,
  answer: "accept" | "dismiss",
): Promise<Dialog> {
  return new Promise((resolve) => {
    page.once("dialog", (dialog) => {
      resolve(dialog);
      void (answer === "accept" ? dialog.accept() : dialog.dismiss());
    });
  });
}

export async function expectInstalledSkills(
  sandbox: AgentSkillsSandbox,
  expected: string[],
): Promise<void> {
  for (const directory of Object.values(sandbox.targets)) {
    await expect.poll(() => readInstalledSkills(directory)).toEqual([...expected].sort());
  }
}

export async function expectSavedSelection(
  sandbox: AgentSkillsSandbox,
  expected: AgentSkillSelection,
): Promise<void> {
  await expect.poll(async () => (await sandbox.getStatus()).selection).toEqual(expected);
}

export async function expectSkillFile(
  sandbox: AgentSkillsSandbox,
  target: SkillTargetName,
  skill: string,
  relativePath: string,
): Promise<void> {
  await expect
    .poll(() => readFile(path.join(sandbox.targets[target], skill, relativePath), "utf8"))
    .not.toBe("");
}

export async function expectSkillChoices(page: Page, selected: string[]): Promise<void> {
  const expected = new Set(selected);
  for (const name of await listSkillChoices(page)) {
    await expect(page.getByRole("checkbox", { name, exact: true })).toBeChecked({
      checked: expected.has(name),
    });
  }
}

async function listSkillChoices(page: Page): Promise<string[]> {
  return page
    .getByRole("checkbox")
    .evaluateAll((elements) =>
      elements
        .map((element) => element.getAttribute("aria-label") ?? "")
        .filter((name) => name.length > 0),
    );
}

async function readInstalledSkills(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
