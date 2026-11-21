import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedMockAgentWorkspace, type MockAgentWorkspace } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";

const PLUGIN_ID = "agent-timeline-scope-e2e";
const SCREEN_TITLE = "Embeds";
const PHONE = { width: 390, height: 844 };

interface EmbedComposer {
  controls?: "all" | "none" | Record<string, "shown" | "hidden">;
  items?: "all" | "none" | string[];
}

/**
 * A screen with one `AgentTimeline` per agent under a header of its own, plus a client slash
 * command and two composer items, so the embed's scope has something to hide.
 */
function pluginSource(input: { agentIds: string[]; composer: EmbedComposer }): string {
  return `import { useCallback } from "react";
import { Text, View } from "react-native";
import { AgentTimeline, SidebarRow, Toggle } from "@getpaseo/plugin/client/ui";
import { useState } from "react";

const AGENT_IDS = ${JSON.stringify(input.agentIds)};
const COMPOSER = ${JSON.stringify(input.composer)};

function Embeds() {
  return (
    <View style={{ flex: 1 }}>
      <Text testID="plugin-header" style={{ padding: 8 }}>Embedded agents</Text>
      <View style={{ flex: 1, flexDirection: "row" }}>
        {AGENT_IDS.map((agentId) => (
          <View key={agentId} style={{ flex: 1, minWidth: 0 }}>
            <AgentTimeline agentId={agentId} composer={COMPOSER} testID={"embed-" + agentId} />
          </View>
        ))}
      </View>
    </View>
  );
}

function EmbedsItem({ currentScreen, openScreen }) {
  const open = useCallback(() => openScreen({ screenId: "main" }), [openScreen]);
  return <SidebarRow icon="Bot" active={currentScreen?.screenId === "main"} onPress={open} />;
}

function Flag({ title }) {
  const [value, setValue] = useState(false);
  return <Toggle title={title} icon="Flag" value={value} onValueChange={({ value: next }) => setValue(next)} />;
}

function Alpha() {
  return <Flag title="Alpha flag" />;
}

function Beta() {
  return <Flag title="Beta flag" />;
}

export default function contribute(plugin) {
  plugin.addScreen({ id: "main", title: "${SCREEN_TITLE}", Component: Embeds });
  plugin.addSidebarHeaderItem({ id: "main", title: "${SCREEN_TITLE}", Component: EmbedsItem });
  plugin.addComposerItem({ id: "alpha", Component: Alpha });
  plugin.addComposerItem({ id: "beta", Component: Beta });
  plugin.addSlashCommand({
    name: "stamp",
    context: "agent",
    description: "Stamp the agent",
    argumentHint: "",
    onSubmit() {},
  });
  return () => {};
}`;
}

interface Scenario {
  agents: MockAgentWorkspace[];
  embed(agentId: string): ReturnType<Page["getByTestId"]>;
}

async function withEmbeds(
  page: Page,
  input: { agents: { title: string; model: string; prompt: string }[]; composer: EmbedComposer },
  run: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  const agents: MockAgentWorkspace[] = [];
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-agent-timeline-scope-"));
  try {
    for (const agent of input.agents) {
      agents.push(
        await seedMockAgentWorkspace({
          repoPrefix: "agent-timeline-scope-",
          title: agent.title,
          model: agent.model,
          initialPrompt: agent.prompt,
        }),
      );
    }
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(
      path.join(directory, "index.client.tsx"),
      pluginSource({ agentIds: agents.map((agent) => agent.agentId), composer: input.composer }),
    );
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await gotoAppShell(page);
    await page.getByRole("button", { name: SCREEN_TITLE, exact: true }).click();
    const embed = (agentId: string) => page.getByTestId(`embed-${agentId}`);
    for (const agent of agents) {
      await expect(embed(agent.agentId).getByTestId("user-message").first()).toBeVisible({
        timeout: 30_000,
      });
    }
    await run({ agents, embed });
  } finally {
    await client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await client
      .patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled ?? false })
      .catch(() => undefined);
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    for (const agent of agents) await agent.cleanup();
  }
}

async function agentStatus(agent: MockAgentWorkspace): Promise<string | null> {
  const fetched = await agent.client.fetchAgent({ agentId: agent.agentId });
  return fetched?.agent.status ?? null;
}

/** Clicks land on text, not on a field, so Escape routes as the interrupt shortcut. */
async function expectEscapeInterruptsOnlyTheFocusedEmbed(
  page: Page,
  input: { left: MockAgentWorkspace; right: MockAgentWorkspace; embed: Scenario["embed"] },
): Promise<void> {
  const { left, right, embed } = input;
  await test.step("Escape after a click outside the embeds interrupts neither", async () => {
    await page.getByTestId("plugin-header").click();
    await page.keyboard.press("Escape");
  });
  await test.step("Escape after a click in the left embed interrupts only it", async () => {
    await embed(left.agentId).getByTestId("user-message").first().click();
    await page.keyboard.press("Escape");
    await expect.poll(() => agentStatus(left), { timeout: 15_000 }).toBe("idle");
    // Interrupts go out in order, so a stray one from the first Escape has landed by now.
    expect(await agentStatus(right)).toBe("running");
  });
  await test.step("Escape after a click in the right embed interrupts it", async () => {
    await embed(right.agentId).getByTestId("user-message").first().click();
    await page.keyboard.press("Escape");
    await expect.poll(() => agentStatus(right), { timeout: 15_000 }).toBe("idle");
  });
}

test('controls: "none" sends a plugin slash command to the agent as typed', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await withEmbeds(
    page,
    {
      agents: [{ title: "Slash agent", model: "e2e-fast-stream", prompt: "Say hello." }],
      composer: { controls: "none" },
    },
    async ({ agents: [agent], embed }) => {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      const box = embed(agent.agentId).getByRole("textbox", { name: "Message agent..." });
      await box.fill("/stamp the invoices");
      await box.press("Enter");
      await expect(embed(agent.agentId).getByTestId("user-message").last()).toContainText(
        "/stamp the invoices",
      );
    },
  );
});

test("Escape interrupts only the embed that has focus", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await withEmbeds(
    page,
    {
      agents: [
        { title: "Left agent", model: "one-minute-stream", prompt: "Keep running left." },
        { title: "Right agent", model: "one-minute-stream", prompt: "Keep running right." },
      ],
      composer: { controls: "none" },
    },
    async ({ agents: [left, right], embed }) => {
      await expect.poll(() => agentStatus(left), { timeout: 15_000 }).toBe("running");
      await expect.poll(() => agentStatus(right), { timeout: 15_000 }).toBe("running");

      await expectEscapeInterruptsOnlyTheFocusedEmbed(page, { left, right, embed });
    },
  );
});

test("a phone-width embed without the model picker keeps its other controls", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await withEmbeds(
    page,
    {
      agents: [{ title: "Compact agent", model: "e2e-fast-stream", prompt: "Say hello." }],
      composer: { controls: { model: "hidden" } },
    },
    async ({ agents: [agent], embed }) => {
      await page.setViewportSize(PHONE);
      const toolbar = embed(agent.agentId).getByTestId("agent-controls-toolbar");
      await expect(toolbar).toBeVisible();
      await toolbar.getByRole("button", { name: "Open agent features", exact: true }).click();
      // The phone sheet lands at the app root, outside the embed.
      const sheet = page.getByTestId("agent-controls-combined-sheet-controls");
      await expect(page.getByTestId("agent-controls-model")).toHaveCount(0);
      await expect(sheet.getByRole("button", { name: /agent mode/i })).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Alpha flag", exact: true })).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Beta flag", exact: true })).toBeVisible();
    },
  );
});

test("a phone-width embed's control sheet shows only the items the plugin named", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await withEmbeds(
    page,
    {
      agents: [{ title: "Items agent", model: "e2e-fast-stream", prompt: "Say hello." }],
      composer: { items: ["alpha"] },
    },
    async ({ agents: [agent], embed }) => {
      await page.setViewportSize(PHONE);
      const toolbar = embed(agent.agentId).getByTestId("agent-controls-toolbar");
      await toolbar.getByRole("button", { name: /^Select model/ }).click();
      const list = page.getByTestId("agent-controls-settings-list");
      await expect(list.getByRole("button", { name: "Alpha flag", exact: true })).toBeVisible();
      await expect(list.getByRole("button", { name: "Beta flag", exact: true })).toHaveCount(0);
    },
  );
});

/** Picks the embed's current mode again from its picker, which draws at the overlay root. */
async function pickCurrentMode(page: Page, embed: ReturnType<Page["getByTestId"]>): Promise<void> {
  const trigger = embed.getByRole("button", { name: /^Select agent mode \(/ });
  const label = /^Select agent mode \((.+)\)$/.exec(
    (await trigger.getAttribute("aria-label")) ?? "",
  )?.[1];
  expect(label).toBeTruthy();
  await trigger.click();
  const popup = page.getByTestId("combobox-desktop-container").last();
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await popup.getByRole("button", { name: label, exact: true }).click();
  await expect(page.getByTestId("combobox-desktop-container")).toHaveCount(0);
}

test("a full-composer embed applies a slash suggestion picked with the pointer", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await withEmbeds(
    page,
    {
      agents: [{ title: "Suggestion agent", model: "e2e-fast-stream", prompt: "Say hello." }],
      composer: {},
    },
    async ({ agents: [agent], embed }) => {
      await agent.client.waitForFinish(agent.agentId, 30_000);
      const box = embed(agent.agentId).getByRole("textbox", { name: "Message agent..." });
      await box.click();
      await box.pressSequentially("/sta");
      // The list draws in the floating-panel portal, outside the embed's own nodes.
      const suggestion = page
        .getByTestId("composer-autocomplete-popover")
        .getByText("/stamp", { exact: true });
      await expect(suggestion).toBeVisible({ timeout: 30_000 });
      await suggestion.click();
      await expect(box).toHaveValue(/^\/stamp\s*$/);
    },
  );
});

test("a portaled mode picker keeps its embed focused for Escape", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await withEmbeds(
    page,
    {
      agents: [
        { title: "Left agent", model: "one-minute-stream", prompt: "Keep running left." },
        { title: "Right agent", model: "one-minute-stream", prompt: "Keep running right." },
      ],
      composer: {},
    },
    async ({ agents: [left, right], embed }) => {
      await expect.poll(() => agentStatus(left), { timeout: 15_000 }).toBe("running");
      await expect.poll(() => agentStatus(right), { timeout: 15_000 }).toBe("running");

      await pickCurrentMode(page, embed(left.agentId));
      await page.keyboard.press("Escape");
      await expect.poll(() => agentStatus(left), { timeout: 15_000 }).toBe("idle");
      expect(await agentStatus(right)).toBe("running");
    },
  );
});
