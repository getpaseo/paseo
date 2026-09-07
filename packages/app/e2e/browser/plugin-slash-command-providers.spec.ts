import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { composerLocator, expectComposerVisible } from "../support/helpers/composer";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const PLUGIN_ID = "command-directories-example";
const PLUGIN_DIRECTORY = path.resolve(__dirname, "../../../../plugin-examples/command-directories");

async function writeCommand(
  workspaceDirectory: string,
  name: string,
  contents: string,
): Promise<void> {
  const commandsDirectory = path.join(workspaceDirectory, ".commands");
  await mkdir(commandsDirectory, { recursive: true });
  await writeFile(path.join(commandsDirectory, `${name}.md`), contents);
}

test("dynamic plugin slash commands follow the active workspace", async ({ page }) => {
  const management = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await management.getDaemonConfig();
  const first = await seedMockAgentWorkspace({
    repoPrefix: "plugin-command-provider-first-",
    title: "First command workspace",
  });
  const second = await seedMockAgentWorkspace({
    repoPrefix: "plugin-command-provider-second-",
    title: "Second command workspace",
  });
  await writeCommand(
    first.cwd,
    "first-only",
    "---\ndescription: First workspace command\nargument-hint: [scope]\n---\nExpanded first command: $ARGUMENTS",
  );
  await writeCommand(
    second.cwd,
    "second-only",
    "---\ndescription: Second workspace command\n---\nExpanded second command",
  );

  try {
    await management.patchDaemonConfig({ pluginsEnabled: true });
    await management.installDirectoryPlugin(PLUGIN_DIRECTORY);

    await openAgentRoute(page, first);
    await expectComposerVisible(page);
    const input = composerLocator(page);
    await input.fill("/first-o");
    await expect(page.getByText("/first-only", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("/second-only", { exact: true })).toHaveCount(0);

    await input.fill("/first-only src");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Expanded first command: src", { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    await openAgentRoute(page, second);
    await expectComposerVisible(page);
    const secondInput = composerLocator(page);
    await secondInput.fill("/second-o");
    await expect(page.getByText("/second-only", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("/first-only", { exact: true })).toHaveCount(0);
  } finally {
    await management.removePlugin(PLUGIN_ID).catch(() => undefined);
    await management
      .patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await management.close().catch(() => undefined);
    await first.cleanup();
    await second.cleanup();
  }
});

test("a pending slash command provider leaves ready commands visible", async ({ page }) => {
  const pluginDirectory = await mkdtemp(
    path.join(tmpdir(), "paseo-plugin-command-provider-pending-"),
  );
  const management = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await management.getDaemonConfig();
  const session = await seedMockAgentWorkspace({
    repoPrefix: "plugin-command-provider-pending-",
    title: "Pending command provider workspace",
  });
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({ id: "command-provider-pending" }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.client.ts"),
    `export default function contribute(client) {
      client.addSlashCommand({
        name: "ready",
        description: "Ready command",
        argumentHint: "",
        context: "agent",
        async onSubmit() {},
      });
      client.addSlashCommandProvider({
        id: "pending",
        context: "agent",
        list() { return new Promise(() => {}); },
        async onSubmit() {},
      });
      return () => {};
    }`,
  );

  try {
    await management.patchDaemonConfig({ pluginsEnabled: true });
    await management.installDirectoryPlugin(pluginDirectory);
    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    const input = composerLocator(page);

    await input.fill("/cle");
    await expect(page.getByText("/clear", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });

    await input.fill("/rea");
    await expect(page.getByText("/ready", { exact: true }).first()).toBeVisible();
  } finally {
    await management.removePlugin("command-provider-pending").catch(() => undefined);
    await management
      .patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await management.close().catch(() => undefined);
    await session.cleanup();
    await rm(pluginDirectory, { recursive: true, force: true });
  }
});

test("dynamic plugin slash command failures stay visible in autocomplete", async ({ page }) => {
  const pluginDirectory = await mkdtemp(
    path.join(tmpdir(), "paseo-plugin-command-provider-error-"),
  );
  const management = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await management.getDaemonConfig();
  const session = await seedMockAgentWorkspace({
    repoPrefix: "plugin-command-provider-error-",
    title: "Command provider error workspace",
  });
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({ id: "command-provider-error" }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.client.ts"),
    `export default function contribute(client) {
      client.addSlashCommandProvider({
        id: "failure",
        context: "agent",
        async list() { throw new Error("Command catalog failed"); },
        async onSubmit() {},
      });
      return () => {};
    }`,
  );

  try {
    await management.patchDaemonConfig({ pluginsEnabled: true });
    await management.installDirectoryPlugin(pluginDirectory);
    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await composerLocator(page).fill("/catalog");
    await expect(page.getByText("Error: Command catalog failed", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await management.removePlugin("command-provider-error").catch(() => undefined);
    await management
      .patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await management.close().catch(() => undefined);
    await session.cleanup();
    await rm(pluginDirectory, { recursive: true, force: true });
  }
});
