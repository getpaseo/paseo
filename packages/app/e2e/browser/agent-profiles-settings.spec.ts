import { expect, test as baseTest } from "../support/fixtures";
import type { Page, TestInfo } from "@playwright/test";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { AgentSettingsProfiles } from "@getpaseo/protocol/agent-settings-profile";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  submitMessage,
  attachFileFromMenu,
  removeAttachmentPill,
} from "../support/helpers/composer";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  createAgentProfile,
  createAgentProfileFromEmptyState,
  editAgentProfile,
  expectAgentProfile,
  expectAgentProfileForm,
  expectAgentProfileOrder,
  expectAgentProfileTagsGone,
  expectHostAgentProfiles,
  expectNoAgentProfiles,
  moveAgentProfileUp,
  openAgentProfileSettings,
  removeAgentProfile,
  stageLegacyFavoritesForHostMigration,
} from "../support/helpers/agent-profiles";

import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import {
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceHost,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import { forkMostRecentAssistantTurnToNewWorkspace } from "../support/helpers/assistant-fork";
import { awaitAssistantMessage } from "../support/helpers/agent-stream";
import { DraftStoreStateSchema } from "../../src/stores/draft-store/state";

const MOCK_PROVIDER_LABEL = "Mock Load Test";

interface ProfileHost {
  client: DaemonClient;
  onCleanup: (cleanup: () => Promise<void>) => void;
  seedWorkspace: typeof seedMockAgentWorkspace;
}

const test = baseTest.extend<{ profileHost: ProfileHost }>({
  profileHost: [
    async ({ e2eWorkerClient: _workerClient }, provide) => {
      const client = await connectDaemonClient<DaemonClient>({
        clientIdPrefix: "profile-settings",
      });
      const cleanups: (() => Promise<void>)[] = [() => client.close()];
      try {
        const previous = (await client.getDaemonConfig()).config;
        cleanups.push(() => restoreGeneralSettings(client, previous));
        await provide({
          client,
          onCleanup: (cleanup) => cleanups.push(cleanup),
          seedWorkspace: async (options) => {
            const workspace = await seedMockAgentWorkspace(options);
            cleanups.push(() => workspace.cleanup());
            return workspace;
          },
        });
      } finally {
        await cleanupProfileHost(cleanups);
      }
    },
    { auto: true },
  ],
});

async function cleanupProfileHost(cleanups: (() => Promise<void>)[]) {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Profile settings cleanup failed");
}

const CHAT_PROFILES: AgentSettingsProfiles = {
  activeProfileId: "coding",
  profiles: [
    {
      id: "coding",
      name: "Kodlama",
      settings: {
        appendSystemPrompt: "Write tested code.",
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        agentProfiles: [
          {
            id: "coding-preset",
            name: "Coding preset",
            provider: "mock",
            model: "e2e-fast-stream",
          },
        ],
      },
    },
    {
      id: "reverse",
      name: "Reverse engineering",
      settings: {
        appendSystemPrompt: "Analyze binaries.",
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        agentProfiles: [
          {
            id: "reverse-preset",
            name: "Binary analyst preset",
            provider: "mock",
            model: "one-minute-stream",
          },
        ],
      },
    },
    {
      id: "review",
      name: "Review",
      settings: {
        appendSystemPrompt: "Review the diff.",
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
      },
    },
  ],
};

async function seedProfileChat(profileHost: ProfileHost) {
  await profileHost.client.patchDaemonConfig({ agentSettingsProfiles: CHAT_PROFILES });
  return profileHost.seedWorkspace({
    repoPrefix: "profile-chats-",
    title: "Default coding chat",
    initialPrompt: "emit 1 coalesced agent stream updates for profile tests.",
  });
}

async function createRemoteProfileHost(profileHost: ProfileHost) {
  const daemon = await startIsolatedHostDaemon("profile-settings-remote");
  profileHost.onCleanup(() => daemon.close());
  const client = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "remote-profiles",
    port: daemon.port,
  });
  profileHost.onCleanup(() => client.close());
  await client.patchDaemonConfig({
    agentSettingsProfiles: {
      activeProfileId: "remote-review",
      profiles: [
        {
          id: "remote-review",
          name: "Remote reviewer",
          settings: CHAT_PROFILES.profiles[2].settings,
        },
        {
          id: "remote-reverse",
          name: "Remote reverse engineering",
          settings: CHAT_PROFILES.profiles[1].settings,
        },
      ],
    },
  });
  await profileHost.seedWorkspace({
    repoPrefix: "remote-profile-",
    title: "Remote profile chat",
    port: daemon.port,
  });
  return { serverId: daemon.serverId, port: daemon.port };
}

async function openDraftTab(page: Page) {
  await page.getByTestId("workspace-pane-main").getByTestId("workspace-new-tab-button").click();
  await page.getByTestId("workspace-new-tab-menu-agent").click();
}

async function openProfileMenu(page: Page) {
  await page.getByTestId("combined-model-selector").filter({ visible: true }).first().click();
  await expect(
    page
      .getByTestId("chat-settings-profile-selector")
      .or(page.getByTestId("chat-settings-profile-label"))
      .filter({ visible: true }),
  ).toBeVisible();
}

async function closeProfileMenu(page: Page) {
  await page.keyboard.press("Escape");
  await expect(
    page
      .getByTestId("chat-settings-profile-selector")
      .or(page.getByTestId("chat-settings-profile-label"))
      .filter({ visible: true }),
  ).toHaveCount(0);
}

async function expectSelectedProfile(page: Page, id: string) {
  await expect(page.getByTestId(`chat-settings-profile-${id}`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

async function expectEmptyDraftFinalized(page: Page) {
  await expect
    .poll(async () => {
      const saved = await page.evaluate(() => localStorage.getItem("paseo-drafts"));
      if (!saved) return null;
      const state = DraftStoreStateSchema.parse(JSON.parse(saved).state);
      const selectedDraft = Object.entries(state.settingsProfileChoices).find(([, choices]) =>
        Object.values(choices).includes("reverse"),
      );
      return selectedDraft ? state.drafts[selectedDraft[0]] : null;
    })
    .toMatchObject({ input: { text: "", attachments: [] }, lifecycle: "abandoned" });
}

async function expectCapturedProfile(page: Page, name: string) {
  await openProfileMenu(page);
  await expect(page.getByTestId("chat-settings-profile-name")).toHaveText(name);
  await closeProfileMenu(page);
}

async function openOrchestrationSettings(page: Page, profileHost: ProfileHost) {
  const gate = await installDaemonWebSocketGate(page);
  const client = profileHost.client;
  const settings = {
    appendSystemPrompt: "Stored prompt",
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    agentProfiles: [],
    skills: { selection: { mode: "custom" as const, skills: [] } },
  };
  const bundle: AgentSettingsProfiles = {
    activeProfileId: "coding",
    profiles: [
      { id: "coding", name: "Coding", settings },
      { id: "reverse", name: "Reverse", settings },
    ],
  };
  profileHost.onCleanup(async () => gate.setServerMessageSuppressed("status", false));
  await client.patchDaemonConfig({ agentSettingsProfiles: bundle });
  await openAgentProfileSettings(page);
  await expect(page.getByTestId("agent-settings-profile-select")).toContainText("Coding");
  return { gate, client, bundle };
}

async function captureSettingsFeedback(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function restoreGeneralSettings(client: DaemonClient, previous: MutableDaemonConfig) {
  await client.patchDaemonConfig({
    agentSettingsProfiles: previous.agentSettingsProfiles ?? {
      activeProfileId: "default",
      profiles: [
        {
          id: "default",
          name: "Default",
          settings: {
            appendSystemPrompt: previous.appendSystemPrompt,
            mcp: { injectIntoAgents: previous.mcp.injectIntoAgents },
            browserTools: { enabled: previous.browserTools.enabled },
            agentProfiles: previous.agentProfiles ?? [],
            skills: {
              selection: previous.skills?.selection ?? { mode: "all" },
            },
          },
        },
      ],
    },
  });
}

test.describe("Agent profiles settings", () => {
  test("Paseo tools save shows pending state and persists through the real daemon", async ({
    profileHost,
    page,
  }, testInfo) => {
    const fixture = await openOrchestrationSettings(page, profileHost);

    const card = page.getByTestId("host-page-inject-mcp-card");
    const toggle = card.getByRole("switch");
    await expect(toggle).not.toBeChecked();
    fixture.gate.holdNextClientRequest("set_daemon_config_request");
    await toggle.click();
    await fixture.gate.waitForHeldClientRequest();
    await expect(page.getByTestId("host-page-inject-mcp-saving")).toBeVisible();
    await expect(toggle).toBeDisabled();
    await captureSettingsFeedback(page, testInfo, "mcp-save-pending");
    fixture.gate.releaseHeldClientRequest();
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    await expect(page.getByTestId("host-page-inject-mcp-saving")).toHaveCount(0);
    expect((await fixture.client.getDaemonConfig()).config.mcp.injectIntoAgents).toBe(true);
    await captureSettingsFeedback(page, testInfo, "mcp-save-success");
  });

  test("Paseo tools save shows a real daemon rejection and supports retry", async ({
    profileHost,
    page,
  }, testInfo) => {
    const fixture = await openOrchestrationSettings(page, profileHost);

    const toggle = page.getByTestId("host-page-inject-mcp-card").getByRole("switch");
    fixture.gate.setServerMessageSuppressed("status", true);
    await fixture.client.patchDaemonConfig({
      agentSettingsProfiles: {
        activeProfileId: "reverse",
        profiles: [fixture.bundle.profiles[1]],
      },
    });
    await toggle.click();
    const error = page.getByTestId("host-page-inject-mcp-error");
    await expect(error).toContainText("Agent settings profile does not exist");
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeEnabled();
    expect((await fixture.client.getDaemonConfig()).config.mcp.injectIntoAgents).toBe(false);
    await captureSettingsFeedback(page, testInfo, "mcp-save-error");
    await fixture.client.patchDaemonConfig({ agentSettingsProfiles: fixture.bundle });
    await toggle.click();
    await expect(error).toHaveCount(0);
    await expect(toggle).toBeChecked();
    expect(
      (await fixture.client.getDaemonConfig()).config.agentSettingsProfiles?.profiles[0].settings
        .mcp.injectIntoAgents,
    ).toBe(true);
    await captureSettingsFeedback(page, testInfo, "mcp-save-retry-success");
  });

  test("system prompt save keeps the editor pending and persists through the real daemon", async ({
    profileHost,
    page,
  }, testInfo) => {
    const fixture = await openOrchestrationSettings(page, profileHost);

    await page.getByTestId("host-page-append-system-prompt-edit").click();
    const input = page.getByTestId("host-page-append-system-prompt-input");
    await input.fill("App-level saved prompt");
    const save = page.getByTestId("host-page-append-system-prompt-save");
    fixture.gate.holdNextClientRequest("set_daemon_config_request");
    await save.click();
    await fixture.gate.waitForHeldClientRequest();
    await expect(save).toContainText("Saving");
    await expect(save).toBeDisabled();
    await expect(page.getByTestId("host-page-append-system-prompt-reset")).toBeDisabled();
    await expect(input).toHaveValue("App-level saved prompt");
    await captureSettingsFeedback(page, testInfo, "prompt-save-pending");
    fixture.gate.releaseHeldClientRequest();
    await expect(page.getByTestId("host-page-append-system-prompt-sheet")).toHaveCount(0);
    expect((await fixture.client.getDaemonConfig()).config.appendSystemPrompt).toBe(
      "App-level saved prompt",
    );
    await page.getByTestId("host-page-append-system-prompt-edit").click();
    await expect(input).toHaveValue("App-level saved prompt");
    await captureSettingsFeedback(page, testInfo, "prompt-save-success");
  });

  test("system prompt save shows a real daemon rejection and retains the draft for retry", async ({
    profileHost,
    page,
  }, testInfo) => {
    const fixture = await openOrchestrationSettings(page, profileHost);

    await page.getByTestId("host-page-append-system-prompt-edit").click();
    const input = page.getByTestId("host-page-append-system-prompt-input");
    await input.fill("Keep this unsaved prompt");
    fixture.gate.setServerMessageSuppressed("status", true);
    await fixture.client.patchDaemonConfig({
      agentSettingsProfiles: {
        activeProfileId: "reverse",
        profiles: [fixture.bundle.profiles[1]],
      },
    });
    const save = page.getByTestId("host-page-append-system-prompt-save");
    await save.click();
    const error = page.getByTestId("host-page-append-system-prompt-error");
    await expect(error).toContainText("Agent settings profile does not exist");
    await expect(input).toHaveValue("Keep this unsaved prompt");
    await expect(save).toBeEnabled();
    expect((await fixture.client.getDaemonConfig()).config.appendSystemPrompt).toBe(
      "Stored prompt",
    );
    await captureSettingsFeedback(page, testInfo, "prompt-save-error");
    await fixture.client.patchDaemonConfig({ agentSettingsProfiles: fixture.bundle });
    await save.click();
    await expect(page.getByTestId("host-page-append-system-prompt-sheet")).toHaveCount(0);
    expect(
      (await fixture.client.getDaemonConfig()).config.agentSettingsProfiles?.profiles[0].settings
        .appendSystemPrompt,
    ).toBe("Keep this unsaved prompt");
    await page.getByTestId("host-page-append-system-prompt-edit").click();
    await expect(input).toHaveValue("Keep this unsaved prompt");
    await expect(error).toHaveCount(0);
    await captureSettingsFeedback(page, testInfo, "prompt-save-retry-success");
  });

  test("stale profile removal shows an error and preserves a concurrent edit", async ({
    profileHost,
    page,
  }) => {
    const client = profileHost.client;
    const gate = await installDaemonWebSocketGate(page);
    const settings = {
      appendSystemPrompt: "",
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      agentProfiles: [],
      skills: { selection: { mode: "custom" as const, skills: [] } },
    };

    await client.patchDaemonConfig({
      agentSettingsProfiles: {
        activeProfileId: "coding",
        profiles: [
          { id: "coding", name: "Coding", settings },
          { id: "reverse", name: "Reverse", settings },
        ],
      },
    });
    await openAgentProfileSettings(page);
    gate.holdNextClientRequest("set_daemon_config_request");
    const dialogPromise = page.waitForEvent("dialog");
    const clickPromise = page.getByTestId("agent-settings-profile-remove").click();
    const dialog = await dialogPromise;
    const newerPreset = {
      id: "concurrent",
      name: "Concurrent preset",
      provider: "mock",
    };
    await client.patchDaemonConfig({
      agentSettingsProfilePatch: {
        profileId: "coding",
        agentProfiles: [newerPreset],
      },
    });
    await dialog.accept();
    await clickPromise;
    await gate.waitForHeldClientRequest();
    await expect(page.getByTestId("agent-settings-profile-saving")).toBeVisible();
    await expect(
      page.getByTestId("agent-settings-profile-select").getByRole("button"),
    ).toBeDisabled();
    await expect(page.getByTestId("agent-settings-profile-remove")).toBeDisabled();
    gate.releaseHeldClientRequest();
    const error = page.getByTestId("agent-settings-profile-error");
    await expect(error).toContainText("Agent settings profiles changed");
    const current = (await client.getDaemonConfig()).config.agentSettingsProfiles;
    expect(current?.activeProfileId).toBe("coding");
    expect(current?.profiles.map((profile) => profile.id)).toEqual(["coding", "reverse"]);
    expect(current?.profiles[0].settings.agentProfiles).toEqual([newerPreset]);
    await expect(error).toBeVisible();
    page.once("dialog", (retryDialog) => retryDialog.accept());
    await page.getByTestId("agent-settings-profile-remove").click();
    await expect(page.getByTestId("agent-settings-profile-select")).toContainText("Reverse");
    await expect(error).toHaveCount(0);
  });

  test("profile switching shows pending feedback and a persistent conflict that can be retried", async ({
    page,
    profileHost,
  }) => {
    const fixture = await openOrchestrationSettings(page, profileHost);
    const select = page.getByTestId("agent-settings-profile-select").getByRole("button");
    fixture.gate.setServerMessageSuppressed("status", true);
    fixture.gate.holdNextClientRequest("set_daemon_config_request");
    await select.click();
    await page.getByRole("menuitem", { name: "Reverse", exact: true }).click();
    await fixture.gate.waitForHeldClientRequest();
    await expect(select).toBeDisabled();
    await expect(page.getByTestId("agent-settings-profile-saving")).toBeVisible();
    await fixture.client.patchDaemonConfig({
      agentSettingsProfilePatch: { profileId: "coding", appendSystemPrompt: "Concurrent prompt" },
    });
    fixture.gate.releaseHeldClientRequest();
    const error = page.getByTestId("agent-settings-profile-error");
    await expect(error).toContainText("Agent settings profiles changed");
    await expect(select).toContainText("Coding");
    await expect(select).toBeEnabled();
    fixture.gate.setServerMessageSuppressed("status", false);
    await fixture.client.patchDaemonConfig({
      agentSettingsProfilePatch: { profileId: "coding", browserTools: { enabled: true } },
    });
    await page.getByTestId("host-page-append-system-prompt-edit").click();
    await expect(page.getByTestId("host-page-append-system-prompt-input")).toHaveValue(
      "Concurrent prompt",
    );
    await page
      .getByTestId("host-page-append-system-prompt-sheet")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(error).toBeVisible();
    await select.click();
    await page.getByRole("menuitem", { name: "Reverse", exact: true }).click();
    await expect(select).toContainText("Reverse");
    await expect(error).toHaveCount(0);
    expect(
      (await fixture.client.getDaemonConfig()).config.agentSettingsProfiles?.profiles[0].settings
        .appendSystemPrompt,
    ).toBe("Concurrent prompt");
  });

  test("repeated settings profile switches keep one copy of every Agents section", async ({
    profileHost,
    page,
  }) => {
    const client = profileHost.client;
    const settings = {
      appendSystemPrompt: "",
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      agentProfiles: [],
      skills: { selection: { mode: "custom" as const, skills: [] } },
    };

    await client.patchDaemonConfig({
      agentSettingsProfiles: {
        activeProfileId: "section-a",
        profiles: [
          { id: "section-a", name: "Section A", settings },
          { id: "section-b", name: "Section B", settings },
        ],
      },
    });
    await openAgentProfileSettings(page);
    for (const width of [601, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (let change = 0; change < 6; change++) {
        const name = change % 2 === 0 ? "Section B" : "Section A";
        await page.getByTestId("agent-settings-profile-select").getByRole("button").click();
        await page.getByText(name, { exact: true }).click();
        await expect(page.getByTestId("agent-settings-profile-select")).toContainText(name);
        await expect(
          page.getByRole("button", {
            name: "Open skills documentation",
            exact: true,
          }),
        ).toHaveCount(1);
        await expect(page.getByRole("button", { name: "Choose skills", exact: true })).toHaveCount(
          1,
        );
        await expect(page.getByTestId("agent-profiles-section")).toHaveCount(1);
        await expect(page.getByTestId("host-page-append-system-prompt-card")).toHaveCount(1);
      }
    }
  });

  test("general Agents profiles restore their own prompt and tool settings", async ({
    profileHost,
    page,
  }) => {
    const client = profileHost.client;

    await openAgentProfileSettings(page);
    await expect(page.getByTestId("agent-settings-profile-select")).toContainText("Default");
    await page.getByTestId("agent-settings-profile-create").click();
    await page.getByTestId("agent-settings-profile-name-input").fill("Reverse engineering");
    await page.getByTestId("agent-settings-profile-name-submit").click();
    await expect(page.getByTestId("agent-settings-profile-select")).toContainText(
      "Reverse engineering",
    );
    await page.getByTestId("host-page-append-system-prompt-edit").click();
    await page
      .getByTestId("host-page-append-system-prompt-input")
      .fill("Analyze binaries before making changes.");
    await page.getByTestId("host-page-append-system-prompt-save").click();
    await expect(page.getByTestId("host-page-append-system-prompt-sheet")).not.toBeVisible();

    await page.getByTestId("agent-settings-profile-create").click();
    await page.getByTestId("agent-settings-profile-name-input").fill("Coding");
    await page.getByTestId("agent-settings-profile-name-submit").click();
    await expect(page.getByTestId("agent-settings-profile-select")).toContainText("Coding");
    await page.getByTestId("host-page-append-system-prompt-edit").click();
    await page
      .getByTestId("host-page-append-system-prompt-input")
      .fill("Write code and run focused tests.");
    await page.getByTestId("host-page-append-system-prompt-save").click();
    await expect(page.getByTestId("host-page-append-system-prompt-sheet")).not.toBeVisible();
    await page.getByTestId("host-page-inject-mcp-card").getByRole("switch").click();
    await expect
      .poll(async () => (await client.getDaemonConfig()).config.appendSystemPrompt)
      .toBe("Write code and run focused tests.");
    const coding = (await client.getDaemonConfig()).config;

    await page.getByTestId("agent-settings-profile-select").getByRole("button").click();
    await page.getByText("Reverse engineering", { exact: true }).click();
    await expect
      .poll(async () => (await client.getDaemonConfig()).config.appendSystemPrompt)
      .toBe("Analyze binaries before making changes.");
    expect((await client.getDaemonConfig()).config.mcp.injectIntoAgents).toBe(
      !coding.mcp.injectIntoAgents,
    );
    await page.getByTestId("host-page-append-system-prompt-edit").click();
    await expect(page.getByTestId("host-page-append-system-prompt-input")).toHaveValue(
      "Analyze binaries before making changes.",
    );
    await page.keyboard.press("Escape");

    await page.getByTestId("agent-settings-profile-select").getByRole("button").click();
    await page.getByText("Coding", { exact: true }).click();
    await expect
      .poll(async () => (await client.getDaemonConfig()).config.appendSystemPrompt)
      .toBe("Write code and run focused tests.");
    await page.reload();
    await expect(page.getByTestId("agent-settings-profile-select")).toContainText("Coding");
    await page.getByTestId("agent-settings-profile-rename").click();
    await page.getByTestId("agent-settings-profile-name-input").fill("Development");
    await page.getByTestId("agent-settings-profile-name-submit").click();
    await expect(page.getByTestId("agent-settings-profile-select")).toContainText("Development");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("agent-settings-profile-remove").click();
    await expect(page.getByTestId("agent-settings-profile-select")).toContainText("Default");
    expect(
      (await client.getDaemonConfig()).config.agentSettingsProfiles?.profiles.map(
        (profile) => profile.name,
      ),
    ).toEqual(["Default", "Reverse engineering"]);
  });

  test("new chats choose profile tabs in the model menu across desktop and compact layouts", async ({
    page,
    profileHost,
  }, testInfo) => {
    const workspace = await seedProfileChat(profileHost);
    await openAgentRoute(page, workspace);
    await expect(
      page.getByTestId("chat-settings-profile-label").filter({ visible: true }),
    ).toHaveCount(0);
    await openProfileMenu(page);
    await expect(page.getByTestId("chat-settings-profile-name")).toHaveText("Kodlama");
    await expect(page.getByTestId("chat-settings-profile-label").getByRole("button")).toHaveCount(
      0,
    );
    await closeProfileMenu(page);
    await openDraftTab(page);
    await expect(
      page.getByTestId("chat-settings-profile-selector").filter({ visible: true }),
    ).toHaveCount(0);
    const model = page.getByTestId("combined-model-selector").filter({ visible: true });
    await model.focus();
    await page.keyboard.press("Enter");
    await expectSelectedProfile(page, "coding");
    await expect(page.getByTestId("model-profile-row-coding-preset")).toBeVisible();
    await page.getByTestId("chat-settings-profile-reverse").focus();
    await page.keyboard.press("Enter");
    await expectSelectedProfile(page, "reverse");
    await expect(page.getByTestId("model-profile-row-reverse-preset")).toBeVisible();
    await expect(page.getByTestId("model-profile-row-coding-preset")).toHaveCount(0);
    await page.mouse.move(24, 24);
    await captureSettingsFeedback(page, testInfo, "profile-tabs-desktop");
    await closeProfileMenu(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openProfileMenu(page);
    await expectSelectedProfile(page, "reverse");
    await expect(page.getByTestId("chat-settings-profile-review")).toBeInViewport({ ratio: 1 });
    await page.getByTestId("chat-settings-profile-review").click();
    await expectSelectedProfile(page, "review");
    await captureSettingsFeedback(page, testInfo, "profile-tabs-compact");
    await page
      .getByRole("button", { name: "Close", exact: true })
      .filter({ visible: true })
      .last()
      .click();
    await page.setViewportSize({ width: 1280, height: 720 });
    await openProfileMenu(page);
    await expectSelectedProfile(page, "review");
    await closeProfileMenu(page);
    await submitMessage(page, "Review this project.");
    await expectCapturedProfile(page, "Review");
    expect(
      (await profileHost.client.getDaemonConfig()).config.agentSettingsProfiles?.activeProfileId,
    ).toBe("coding");
    await page.getByTestId(`workspace-tab-agent_${workspace.agentId}`).click();
    await profileHost.client.patchDaemonConfig({
      agentSettingsProfiles: { ...CHAT_PROFILES, activeProfileId: "review" },
    });
    await page.reload();
    await expectCapturedProfile(page, "Kodlama");
  });

  test("deleting a selected draft profile falls back to the current host default and can send", async ({
    page,
    profileHost,
  }) => {
    const workspace = await seedProfileChat(profileHost);
    await openAgentRoute(page, workspace);
    await openDraftTab(page);
    await openProfileMenu(page);
    await page.getByTestId("chat-settings-profile-reverse").click();
    await profileHost.client.patchDaemonConfig({
      agentSettingsProfiles: {
        activeProfileId: "review",
        profiles: [CHAT_PROFILES.profiles[0], CHAT_PROFILES.profiles[2]],
      },
    });
    await expect(page.getByTestId("chat-settings-profile-reverse")).toHaveCount(0);
    await expectSelectedProfile(page, "review");
    await closeProfileMenu(page);
    await submitMessage(page, "Review after removing the old profile.");
    await expectCapturedProfile(page, "Review");
  });

  test("removing the last attachment with empty text preserves the chosen profile", async ({
    page,
    profileHost,
  }) => {
    const workspace = await seedProfileChat(profileHost);
    await openAgentRoute(page, workspace);
    await openDraftTab(page);
    await openProfileMenu(page);
    await page.getByTestId("chat-settings-profile-reverse").click();
    await closeProfileMenu(page);
    await attachFileFromMenu(page, {
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("test notes"),
    });
    await removeAttachmentPill(page, "composer-file-attachment-pill", "Remove file attachment");
    await expect(page.getByTestId("composer-file-attachment-pill")).toHaveCount(0);
    await expectEmptyDraftFinalized(page);
    await page.reload();
    await openProfileMenu(page);
    await expectSelectedProfile(page, "reverse");
    await closeProfileMenu(page);
    await submitMessage(page, "Analyze this project.");
    await expectCapturedProfile(page, "Reverse engineering");
  });

  test("connected clients see each host's profiles and keep draft choices separate when switching hosts", async ({
    page,
    profileHost,
  }) => {
    const workspace = await seedProfileChat(profileHost);
    const remote = await createRemoteProfileHost(profileHost);
    await openAgentRoute(page, workspace);
    await addConnectedHostAndReload(page, {
      serverId: remote.serverId,
      port: remote.port,
      label: "Remote host",
      primaryLabel: "Local host",
    });
    await openGlobalNewWorkspaceComposer(page);
    await selectNewWorkspaceHost(page, "Local host");
    await openProfileMenu(page);
    await expectSelectedProfile(page, "coding");
    await page.getByTestId("chat-settings-profile-reverse").click();
    await closeProfileMenu(page);
    await selectNewWorkspaceHost(page, "Remote host");
    await openProfileMenu(page);
    await expectSelectedProfile(page, "remote-review");
    await expect(page.getByTestId("chat-settings-profile-remote-review")).toHaveText(
      "Remote reviewer",
    );
    await expect(page.getByTestId("chat-settings-profile-reverse")).toHaveCount(0);
    await page.getByTestId("chat-settings-profile-remote-reverse").click();
    await closeProfileMenu(page);
    await selectNewWorkspaceHost(page, "Local host");
    await openProfileMenu(page);
    await expectSelectedProfile(page, "reverse");
    await closeProfileMenu(page);
    await selectNewWorkspaceHost(page, "Remote host");
    await openProfileMenu(page);
    await expectSelectedProfile(page, "remote-reverse");
    await closeProfileMenu(page);
    await submitNewWorkspacePrompt(page, "Analyze on the remote host.");
    await expectCapturedProfile(page, "Remote reverse engineering");
  });

  test("a fork uses its source host profile and the destination host default after switching", async ({
    page,
    profileHost,
  }) => {
    const workspace = await seedProfileChat(profileHost);
    const remote = await createRemoteProfileHost(profileHost);
    await openAgentRoute(page, workspace);
    await addConnectedHostAndReload(page, {
      serverId: remote.serverId,
      port: remote.port,
      label: "Remote host",
      primaryLabel: "Local host",
    });
    await awaitAssistantMessage(page);
    await workspace.client.waitForFinish(workspace.agentId, 45_000);
    await profileHost.client.patchDaemonConfig({
      agentSettingsProfiles: { ...CHAT_PROFILES, activeProfileId: "review" },
    });
    await forkMostRecentAssistantTurnToNewWorkspace(page);
    await openProfileMenu(page);
    await expectSelectedProfile(page, "coding");
    await closeProfileMenu(page);
    await selectNewWorkspaceHost(page, "Remote host");
    await openProfileMenu(page);
    await expectSelectedProfile(page, "remote-review");
    await expect(page.getByTestId("chat-settings-profile-coding")).toHaveCount(0);
    await closeProfileMenu(page);
    await submitNewWorkspacePrompt(page, "Continue the fork on the remote host.");
    await expectCapturedProfile(page, "Remote reviewer");
  });

  test("switching general profiles changes Agent profiles and skill selection", async ({
    profileHost,
    page,
  }) => {
    const client = profileHost.client;
    const base = {
      appendSystemPrompt: "",
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
    };
    const bundle = {
      activeProfileId: "coding-scope",
      profiles: [
        {
          id: "coding-scope",
          name: "Coding scope",
          settings: {
            ...base,
            agentProfiles: [
              {
                id: "dev",
                name: "Developer preset",
                provider: "mock",
                model: "e2e-fast-stream",
                modeId: "load-test",
              },
            ],
            skills: { selection: { mode: "all" as const } },
          },
        },
        {
          id: "reverse-scope",
          name: "Reverse scope",
          settings: {
            ...base,
            agentProfiles: [
              {
                id: "binary",
                name: "Binary analyst preset",
                provider: "mock",
                model: "e2e-fast-stream",
                modeId: "load-test",
              },
            ],
            skills: { selection: { mode: "custom" as const, skills: [] } },
          },
        },
      ],
    };

    await client.patchDaemonConfig({ agentSettingsProfiles: bundle });
    await openAgentProfileSettings(page);
    await expectAgentProfile(page, {
      name: "Developer preset",
      tags: [MOCK_PROVIDER_LABEL, "E2E fast stream", "Load test"],
    });
    await expect(page.getByTestId("agent-profiles-card")).not.toContainText(
      "Binary analyst preset",
    );
    await page.getByTestId("agent-settings-profile-select").getByRole("button").click();
    await page.getByText("Reverse scope", { exact: true }).click();
    await expectAgentProfile(page, {
      name: "Binary analyst preset",
      tags: [MOCK_PROVIDER_LABEL, "E2E fast stream", "Load test"],
    });
    await expect(page.getByTestId("agent-profiles-card")).not.toContainText("Developer preset");
    await expect
      .poll(async () => (await client.getAgentSkillsStatus()).selection)
      .toEqual({ mode: "custom", skills: [] });
    await page.getByRole("button", { name: "Choose skills", exact: true }).click();
    await expect(page.getByTestId("skill-selection-all")).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await editAgentProfile(page, "Binary analyst preset", {
      notes: "Use for binary analysis.",
    });
    await page.getByTestId("agent-settings-profile-select").getByRole("button").click();
    await page.getByText("Coding scope", { exact: true }).click();
    await expectAgentProfile(page, {
      name: "Developer preset",
      tags: [MOCK_PROVIDER_LABEL, "E2E fast stream", "Load test"],
    });
    await expect
      .poll(async () => (await client.getAgentSkillsStatus()).selection)
      .toEqual({ mode: "all" });
    await page.getByTestId("agent-settings-profile-select").getByRole("button").click();
    await page.getByText("Reverse scope", { exact: true }).click();
    await expectAgentProfile(page, {
      name: "Binary analyst preset",
      tags: [MOCK_PROVIDER_LABEL, "E2E fast stream", "Load test"],
      notes: "Use for binary analysis.",
    });
    await page.reload();
    await expectAgentProfile(page, {
      name: "Binary analyst preset",
      tags: [MOCK_PROVIDER_LABEL, "E2E fast stream", "Load test"],
      notes: "Use for binary analysis.",
    });
  });

  test("legacy model favourites migrate into provider-and-model-only host profiles", async ({
    profileHost,
    page,
  }) => {
    await profileHost.client.patchDaemonConfig({ agentProfiles: [] });
    const migratedProfile = {
      id: "legacy_favorite:mock:one-minute-stream",
      name: "One minute stream",
      provider: "mock",
      model: "one-minute-stream",
    };

    await stageLegacyFavoritesForHostMigration(page, [
      { provider: "mock", modelId: "one-minute-stream" },
    ]);

    await expectHostAgentProfiles([migratedProfile]);
    await openAgentProfileSettings(page);
    await expectAgentProfile(page, {
      name: migratedProfile.name,
      tags: [MOCK_PROVIDER_LABEL, "One minute stream"],
    });
  });

  test("host owner creates, edits, reorders and removes agent profiles", async ({
    profileHost,
    page,
  }) => {
    // The journey owns the list, so it starts from an empty one whatever the
    // worker ran before, and hands it back untouched.
    await profileHost.client.patchDaemonConfig({ agentProfiles: [] });

    await test.step("the section starts empty", async () => {
      await openAgentProfileSettings(page);
      await expectNoAgentProfiles(page);
    });

    await test.step("create a profile from the modal", async () => {
      await createAgentProfileFromEmptyState(page, {
        name: "UI work",
        provider: MOCK_PROVIDER_LABEL,
        model: "Ten second stream",
        thinking: "High",
        mode: "Approval test",
        notes: "Use for UI work — components, layout and design tokens.",
      });
      await expectAgentProfile(page, {
        name: "UI work",
        tags: [MOCK_PROVIDER_LABEL, "Ten second stream", "Approval test", "High"],
        notes: "Use for UI work — components, layout and design tokens.",
      });
    });

    await test.step("editing to a model without thinking levels drops the level", async () => {
      await editAgentProfile(page, "UI work", {
        model: "One minute stream",
        notes: "Now for quick checks.",
      });
      await expectAgentProfile(page, {
        name: "UI work",
        tags: [MOCK_PROVIDER_LABEL, "One minute stream", "Approval test"],
        notes: "Now for quick checks.",
      });
      await expectAgentProfileTagsGone(page, {
        name: "UI work",
        tags: ["Ten second stream", "High"],
      });
    });

    await test.step("the edit form reopens on what was stored", async () => {
      await expectAgentProfileForm(page, "UI work", {
        provider: MOCK_PROVIDER_LABEL,
        model: "One minute stream",
        mode: "Approval test",
        notes: "Now for quick checks.",
      });
    });

    await test.step("a second profile lands below the first", async () => {
      await createAgentProfile(page, {
        name: "Deep review",
        provider: MOCK_PROVIDER_LABEL,
        model: "Five minute stream",
      });
      await expectAgentProfileOrder(page, ["UI work", "Deep review"]);
    });

    await test.step("reorder puts the second profile on top", async () => {
      await moveAgentProfileUp(page, "Deep review");
      await expectAgentProfileOrder(page, ["Deep review", "UI work"]);
    });

    await test.step("removing a profile confirms by name", async () => {
      await removeAgentProfile(page, "UI work");
      await expectAgentProfileOrder(page, ["Deep review"]);
    });

    await test.step("removing the last profile returns the empty state", async () => {
      await removeAgentProfile(page, "Deep review");
      await expectNoAgentProfiles(page);
    });
  });
});
