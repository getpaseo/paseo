import { expect, test, type Page } from "../support/fixtures";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  chooseCommandCenterAgentControl,
  submitDraftAgent,
  waitForDraftComposer,
} from "../support/helpers/command-center-agent-controls";
import { openCommandCenter } from "../support/helpers/command-center";
import { selectModel } from "../support/helpers/app";

const DISABLE_DEFAULT_SEED_ONCE_KEY = "@paseo:e2e-disable-default-seed-once";
const SEED_NONCE_KEY = "@paseo:e2e-seed-nonce";

async function openNewAgentTab(page: Page): Promise<void> {
  await clickNewChat(page);
  await waitForDraftComposer(page);
}

async function chooseDraftControl(page: Page, query: string, choice: string): Promise<void> {
  await openCommandCenter(page);
  await chooseCommandCenterAgentControl({ page, query, choice });
}

async function expectThinkingSelected(page: Page, label: string): Promise<void> {
  await expect(
    page
      .getByRole("button", { name: `Select thinking option (${label})` })
      .filter({ visible: true }),
  ).toBeVisible({ timeout: 30_000 });
}

async function expectModeSelected(page: Page, label: string): Promise<void> {
  await expect(
    page.getByRole("button", { name: `Select agent mode (${label})` }).filter({ visible: true }),
  ).toBeVisible({ timeout: 30_000 });
}

async function reloadWithPersistedPreferences(page: Page): Promise<void> {
  await page.evaluate(
    ({ disableKey, nonceKey }) => {
      const nonce = localStorage.getItem(nonceKey);
      if (!nonce) throw new Error("Expected the Playwright seed nonce before reload");
      localStorage.setItem(disableKey, nonce);
    },
    { disableKey: DISABLE_DEFAULT_SEED_ONCE_KEY, nonceKey: SEED_NONCE_KEY },
  );
  await page.reload();
  await waitForDraftComposer(page);
}

async function readRememberedThinking(page: Page, modelId: string): Promise<string | null> {
  return page.evaluate((selectedModelId) => {
    const raw = localStorage.getItem("@paseo:create-agent-preferences");
    if (!raw) return null;
    const preferences = JSON.parse(raw) as {
      providerPreferences?: { mock?: { thinkingByModel?: Record<string, string> } };
    };
    return preferences.providerPreferences?.mock?.thinkingByModel?.[selectedModelId] ?? null;
  }, modelId);
}

async function seedLegacyModelPreference(page: Page): Promise<void> {
  await page.evaluate(() => {
    const storageKey = "@paseo:create-agent-preferences";
    const raw = localStorage.getItem(storageKey);
    const preferences = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...preferences,
        provider: "mock",
        providerPreferences: {
          ...(preferences.providerPreferences as Record<string, unknown> | undefined),
          mock: {
            model: "legacy-five-minute-stream",
            thinkingByModel: { "legacy-five-minute-stream": "medium" },
          },
        },
      }),
    );
  });
}

test.describe("Workspace draft thinking preferences", () => {
  test.describe.configure({ timeout: 180_000 });

  test("restores a model's remembered thinking after another model and a reload", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "draft-thinking-preferences-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await openNewAgentTab(page);
      await chooseDraftControl(
        page,
        "five minute stream",
        "Model › Mock Load Test › Five minute stream",
      );
      await chooseDraftControl(page, "medium", "Thinking › Medium");
      await expectThinkingSelected(page, "Medium");
      await chooseDraftControl(
        page,
        "ten second stream",
        "Model › Mock Load Test › Ten second stream",
      );
      await chooseDraftControl(
        page,
        "five minute stream",
        "Model › Mock Load Test › Five minute stream",
      );
      await expectThinkingSelected(page, "Medium");
      await submitDraftAgent(page, "Remember medium thinking for this model");

      await openNewAgentTab(page);
      await expectThinkingSelected(page, "Medium");
      await chooseDraftControl(
        page,
        "ten second stream",
        "Model › Mock Load Test › Ten second stream",
      );
      await submitDraftAgent(page, "Hello from the other model");

      await openNewAgentTab(page);
      await reloadWithPersistedPreferences(page);
      await expect.poll(() => readRememberedThinking(page, "five-minute-stream")).toBe("medium");
      await chooseDraftControl(
        page,
        "five minute stream",
        "Model › Mock Load Test › Five minute stream",
      );

      await expectThinkingSelected(page, "Medium");
    } finally {
      await workspace.cleanup();
    }
  });

  test("restores a provider's permission mode after another provider and a reload", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "draft-mode-preferences-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await openNewAgentTab(page);
      await chooseDraftControl(
        page,
        "five minute stream",
        "Model › Mock Load Test › Five minute stream",
      );
      await chooseDraftControl(page, "approval test", "Mode › Approval test");
      await expectModeSelected(page, "Approval test");
      await submitDraftAgent(page, "Remember this permission mode");

      await openNewAgentTab(page);
      await expectModeSelected(page, "Approval test");
      await selectModel(page, "gpt-5.4-mini");

      await openNewAgentTab(page);
      await reloadWithPersistedPreferences(page);
      await selectModel(page, "Five minute stream");

      await expectModeSelected(page, "Approval test");
    } finally {
      await workspace.cleanup();
    }
  });

  test("canonicalizes a retired model preference and restores its thinking option", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "draft-model-alias-preferences-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await openNewAgentTab(page);
      await seedLegacyModelPreference(page);
      await reloadWithPersistedPreferences(page);

      await expect(
        page.getByRole("button", { name: "Select model (Five minute stream)" }),
      ).toBeVisible({ timeout: 30_000 });
      await expectThinkingSelected(page, "Medium");
    } finally {
      await workspace.cleanup();
    }
  });
});
