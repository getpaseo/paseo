import { expect, test, type Page } from "../support/fixtures";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import { gotoAppShell } from "../support/helpers/app";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { submitMessage } from "../support/helpers/composer";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import {
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
} from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openModelPicker, drillIntoProvider } from "../support/helpers/agent-profiles";

const CREATE_AGENT_PREFERENCES_KEY = "@paseo:create-agent-preferences";

type WebSocketMessage = string | Buffer;

function parseWebSocketJson(message: WebSocketMessage): unknown {
  const rawMessage = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(rawMessage);
  } catch {
    return null;
  }
}

function getSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const envelope = parseWebSocketJson(message);
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const maybeEnvelope = envelope as { type?: unknown; message?: unknown };
  if (maybeEnvelope.type !== "session" || !maybeEnvelope.message) {
    return null;
  }
  if (typeof maybeEnvelope.message !== "object") {
    return null;
  }
  return maybeEnvelope.message as Record<string, unknown>;
}

// The draft mode control in New Workspace only mutates local form state; it never sends
// agent control requests. So the only source of such a request while the New Workspace
// composer is focused is a *live* agent's mode control. Recording those, keyed by agentId,
// gives a direct signal that Shift+Tab leaked into a backgrounded agent.
async function recordAgentControlRequests(page: Page): Promise<{
  requestsForAgent(agentId: string): Record<string, unknown>[];
}> {
  const seen: Record<string, unknown>[] = [];
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      if (
        sessionMessage?.type === "set_agent_mode_request" ||
        sessionMessage?.type === "set_agent_feature_request"
      ) {
        seen.push(sessionMessage);
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  return {
    requestsForAgent: (agentId: string) => seen.filter((request) => request.agentId === agentId),
  };
}

async function seedCodexDefaultPreferences(page: Page): Promise<void> {
  await page.addInitScript(
    ({ preferencesKey }) => {
      localStorage.setItem(
        preferencesKey,
        JSON.stringify({
          provider: "codex",
          providerPreferences: {
            codex: {
              model: "gpt-6-astra",
              mode: "auto",
              thinkingByModel: { "gpt-6-astra": "high" },
            },
            mock: { model: "ten-second-stream" },
          },
        } satisfies FormPreferences),
      );
    },
    { preferencesKey: CREATE_AGENT_PREFERENCES_KEY },
  );
}

// Focus the New Workspace composer and cycle the execution mode with the keyboard.
// Kept out of the test body so the test reads as intent rather than key mechanics.
async function cycleNewWorkspaceMode(page: Page, presses: number): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message agent..." });
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill("Keep this draft");
  const stripe = page.getByTestId("message-input-plan-stripe");
  await expect(stripe).toBeVisible();
  const permissions = page.getByRole("button", { name: /^Select agent mode \(/ });
  await expect(permissions).toBeVisible();
  const permissionsBefore = await permissions.getAttribute("aria-label");
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press("Shift+Tab");
    await expect(stripe).toHaveCount(i % 2);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Keep this draft");
    expect(await permissions.getAttribute("aria-label")).toBe(permissionsBefore);
  }
}

interface ComposerBox {
  height: number;
  top: number;
}

// The plan decoration is a decorative layer. If it ever joins the layout, the
// composer surface grows a whole stripe band (120px → 282px) and every control
// below it moves. Measure the surface, the text field, and the button row so the
// regression can't hide behind one stable node.
async function measureComposerGeometry(page: Page): Promise<Record<string, ComposerBox>> {
  const targets = {
    surface: page.getByTestId("message-input-surface"),
    field: page.getByRole("textbox", { name: "Message agent..." }),
    buttonRow: page.getByTestId("workspace-create-submit"),
  } as const;

  const entries = await Promise.all(
    Object.entries(targets).map(async ([name, locator]) => {
      const box = await locator.boundingBox();
      if (!box) throw new Error(`Composer geometry missing for ${name}`);
      return [name, { height: box.height, top: box.y }] as const;
    }),
  );
  return Object.fromEntries(entries);
}

async function expectAutoModelSelection(page: Page): Promise<void> {
  const selector = page.getByTestId("combined-model-selector").filter({ visible: true });
  await expect(selector).toBeVisible();
  await expect(selector.getByText("Auto · JEV", { exact: true })).toBeVisible();
  await expect(selector).toHaveAttribute("aria-label", /Auto · JEV/);
  await expect(page.getByTestId("agent-thinking-selector")).toHaveCount(0);
}

function expectSameGeometry(
  before: Record<string, ComposerBox>,
  after: Record<string, ComposerBox>,
): void {
  for (const name of Object.keys(before)) {
    expect(
      Math.abs(after[name].height - before[name].height),
      `${name} height`,
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(after[name].top - before[name].top), `${name} top`).toBeLessThanOrEqual(1);
  }
}

async function expectComposerDensity(page: Page, controlSize: number): Promise<void> {
  const field = page.getByRole("textbox", { name: "Message agent..." });
  const model = page.getByTestId("combined-model-selector").filter({ visible: true });
  const attach = page.getByTestId("message-input-attach-button");
  const submit = page.getByTestId("workspace-create-submit");
  const [fieldBox, modelBox, attachBox, submitBox] = await Promise.all([
    field.boundingBox(),
    model.boundingBox(),
    attach.boundingBox(),
    submit.boundingBox(),
  ]);

  expect(fieldBox?.height).toBe(67);
  expect(modelBox?.height).toBe(controlSize);
  expect(attachBox?.height).toBe(controlSize);
  expect(submitBox?.height).toBe(controlSize);
  await expect(page.getByTestId("message-input-surface")).toHaveCSS(
    "background-color",
    "rgb(250, 250, 249)",
  );
  await expect(page.getByTestId("message-input-surface")).toHaveCSS(
    "border-color",
    "rgb(231, 229, 228)",
  );
  await expect(model.getByText("Auto · JEV", { exact: true })).toHaveCSS("font-size", "12px");
  await expect(model).toHaveCSS("border-radius", "10px");
  await expect(submit).toHaveCSS("background-color", "rgb(26, 26, 30)");
}

// The plan toggle lives in the toolbar on desktop, and behind the model sheet on
// compact widths. Both surfaces flip the same draft feature.
async function setNewWorkspacePlanMode(
  page: Page,
  options: { enabled: boolean; compact: boolean },
): Promise<void> {
  const { enabled, compact } = options;
  const stripe = page.getByTestId("message-input-plan-stripe");
  const planToggle = page.getByTestId("agent-feature-plan_mode");

  if (!compact) {
    await expect(planToggle).toBeVisible({ timeout: 30_000 });
    await planToggle.click();
  } else {
    // The toggle sits in the model sheet. If the sheet is already open (the
    // previous toggle left it up), reuse it instead of re-opening.
    if (!(await planToggle.isVisible().catch(() => false))) {
      await page.getByTestId("combined-model-selector").click();
    }
    await expect(planToggle).toBeVisible({ timeout: 30_000 });
    await planToggle.click();
    await page
      .getByRole("button", { name: enabled ? "On" : "Off", exact: true })
      .click({ timeout: 10_000 });
  }

  if (enabled) {
    await expect(stripe).toBeVisible({ timeout: 10_000 });
  } else {
    await expect(stripe).toHaveCount(0);
  }
}

test.describe("New Workspace mode cycle safety", () => {
  test.describe.configure({ timeout: 240_000 });

  // Regression guard for the P1 safety bug: cycling the execution mode with Shift+Tab in
  // the New Workspace composer must never reach a backgrounded, still-mounted agent's mode
  // control and silently change that (possibly running) agent's mode — e.g. into a
  // permissive/bypass mode. See use-keyboard-action-handler.ts.
  test("Shift+Tab in New Workspace never changes a backgrounded agent's mode", async ({
    page,
  }, testInfo) => {
    const seeded = await seedWorkspace({ repoPrefix: "mode-cycle-safety-" });
    await seedCodexDefaultPreferences(page);
    const modeRequests = await recordAgentControlRequests(page);

    try {
      const agent = await seeded.client.createAgent({
        provider: "codex",
        cwd: seeded.repoPath,
        workspaceId: seeded.workspaceId,
        title: "mode cycle safety e2e",
        modeId: "auto",
        model: "gpt-5.4-mini",
        featureValues: { plan_mode: false },
      });

      // Mount the live agent tab: its mode control registers a mode-cycle keyboard handler.
      await openAgentRoute(page, { workspaceId: seeded.workspaceId, agentId: agent.id });
      await expect(
        page.getByRole("button", { name: "Select agent mode (Default permissions)" }),
      ).toBeVisible({ timeout: 30_000 });

      const liveComposer = page.getByRole("textbox", { name: "Message agent..." });
      await liveComposer.fill("Keep the live message");
      const stripe = page.getByTestId("message-input-plan-stripe");
      await expect(stripe).toHaveCount(0);
      for (const enabled of [true, false]) {
        await page.keyboard.press("Shift+Tab");
        await expect(stripe).toHaveCount(Number(enabled));
        await expect(liveComposer).toBeFocused();
        await expect(liveComposer).toHaveValue("Keep the live message");
        await expect(
          page.getByRole("button", { name: "Select agent mode (Default permissions)" }),
        ).toBeVisible();
      }
      const liveRequests = modeRequests.requestsForAgent(agent.id);
      expect(liveRequests).toMatchObject([
        { type: "set_agent_feature_request", featureId: "plan_mode", value: true },
        { type: "set_agent_feature_request", featureId: "plan_mode", value: false },
      ]);

      // Move to the New Workspace composer. The agent tab stays mounted in the background,
      // so its handler is still registered when we cycle here.
      await openGlobalNewWorkspaceComposer(page);
      await selectNewWorkspaceProject(page, {
        projectKey: seeded.projectKey,
        projectDisplayName: seeded.projectDisplayName,
      });

      await cycleNewWorkspaceMode(page, 2);
      await page.screenshot({ path: testInfo.outputPath("codex-draft-plan.png") });

      // fetchAgents is a real daemon round-trip; once it resolves, any mode change the
      // presses would have triggered has already landed. Assert the running agent is
      // untouched — both its committed mode and on the wire — with no fixed sleep.
      const agents = await seeded.client.fetchAgents();
      const backgroundAgent = agents.entries.find((entry) => entry.agent.id === agent.id)?.agent;
      expect(backgroundAgent?.currentModeId).toBe("auto");
      expect(modeRequests.requestsForAgent(agent.id)).toEqual(liveRequests);
    } finally {
      await seeded.cleanup();
    }
  });
});

for (const provider of ["codex", "claude"] as const) {
  for (const surface of ["workspace", "tab"] as const) {
    test(`draft plan shortcut: ${provider}, ${surface}`, async ({ page }, testInfo) => {
      const seeded = await seedWorkspace({ repoPrefix: "draft-plan-shortcut-" });
      const configs: unknown[] = [];
      await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((frame) => {
          const message = getSessionMessage(frame);
          if (
            message?.type === "create_agent_request" ||
            message?.type === "agent.create.request"
          ) {
            configs.push(message.config);
            return;
          }
          if (message?.type === "workspace.create.request" && message.agent) {
            configs.push((message.agent as { config: unknown }).config);
            return;
          }
          server.send(frame);
        });
        server.onMessage((frame) => ws.send(frame));
      });
      try {
        await page.setViewportSize({ width: 1280, height: 900 });
        await gotoWorkspace(page, seeded.workspaceId);
        if (surface === "workspace") {
          await openGlobalNewWorkspaceComposer(page);
          await selectNewWorkspaceProject(page, seeded);
        } else {
          await clickNewChat(page);
        }
        if (provider === "claude") {
          await openModelPicker(page);
          await page.getByRole("button", { name: "Back", exact: true }).click();
          await drillIntoProvider(page, provider);
          await page
            .getByTestId(/^model-row-claude-/)
            .first()
            .click();
        }
        const input = page.getByRole("textbox", { name: "Message agent..." });
        const stripe = page.getByTestId("message-input-plan-stripe");
        await expect(page.getByTestId("mode-control")).toBeVisible();
        const initiallyPlanning = provider === "codex";
        await expect(stripe).toHaveCount(Number(initiallyPlanning));
        await input.fill("Keep this unsent draft");
        if (provider === "codex") {
          const planButton = page.getByTestId("agent-feature-plan_mode");
          for (const enabled of [false, true]) {
            await planButton.click();
            await expect(stripe).toHaveCount(Number(enabled));
            await expect(planButton).toHaveAttribute("aria-pressed", String(enabled));
          }
        }
        for (const enabled of [!initiallyPlanning, initiallyPlanning, !initiallyPlanning]) {
          await input.press("Shift+Tab");
          await expect(stripe).toHaveCount(Number(enabled));
          await expect(input).toBeFocused();
          await expect(input).toHaveValue("Keep this unsent draft");
          expect(configs).toEqual([]);
        }
        await page.screenshot({ path: testInfo.outputPath("draft-plan.png") });
        await input.press("Enter");
        await expect.poll(() => configs.length).toBe(1);
        expect(configs[0]).toMatchObject(
          provider === "codex"
            ? { provider, featureValues: { plan_mode: false } }
            : { provider, modeId: "plan" },
        );
      } finally {
        await seeded.cleanup();
      }
    });
  }
}

test("Auto routing failure preserves the draft for retry and manual selection", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const seeded = await seedWorkspace({ repoPrefix: "auto-routing-retry-" });
  await seedCodexDefaultPreferences(page);
  const createRequests: Record<string, unknown>[] = [];
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const request = getSessionMessage(message);
      // The harness has real Codex discovery but no workflow plugin. Only
      // guarded Auto creation may reach it; never send a real provider prompt.
      expect(request?.type).not.toBe("send_agent_message_request");
      if (request?.type === "create_agent_request") {
        expect(request.modelRouting).toMatchObject({ strategy: "jev" });
        createRequests.push(request);
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });

  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoWorkspace(page, seeded.workspaceId);
    await clickNewChat(page);
    await expectAutoModelSelection(page);
    const selector = page.getByTestId("combined-model-selector").filter({ visible: true });
    await selector.click();
    await expect(page.getByTestId("model-row-codex-gpt-6-astra")).toBeVisible();
    await page.keyboard.press("Escape");

    const draft = "Keep this request intact when Auto routing fails.";
    const field = page.getByRole("textbox", { name: "Message agent..." });
    const error = page.getByRole("alert").filter({
      hasText: "Initial model routing must complete before creating an agent",
    });
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await submitMessage(page, draft);

    for (const attempt of [1, 2]) {
      await expect.poll(() => createRequests.length).toBe(attempt);
      await expect(error).toBeVisible({ timeout: 30_000 });
      await expect(field).toHaveValue(draft);
      await expect(retry).toBeVisible();
      await expect(retry).toBeEnabled();
      await expectAutoModelSelection(page);
      const agents = await seeded.client.fetchAgents();
      expect(
        agents.entries.filter(({ agent }) => agent.workspaceId === seeded.workspaceId),
      ).toEqual([]);
      if (attempt === 1) await retry.click();
    }

    await selector.click();
    await page.getByTestId("model-row-codex-gpt-6-astra").click();
    await expect(selector).not.toContainText("Auto · JEV");
    await expect(selector).toContainText("GPT-6-Astra");
    await expect(selector).not.toHaveAttribute("aria-label", /Auto · JEV/);
    await expect(page.getByTestId("agent-thinking-selector")).toBeVisible();
    await expect(field).toHaveValue(draft);
    await expect
      .poll(() =>
        page.evaluate((key) => {
          const preferences = JSON.parse(localStorage.getItem(key) ?? "{}");
          return preferences.providerPreferences?.codex?.modelRouting;
        }, CREATE_AGENT_PREFERENCES_KEY),
      )
      .toBe("manual");
    expect(createRequests).toHaveLength(2);
  } finally {
    await seeded.cleanup();
  }
});

// Plan mode paints a decorative stripe layer behind the composer. That layer
// must stay out of the layout: the reference implementation put the SVG in flow
// and the composer grew from 120px to 282px. This guards the geometry contract
// the plan background was designed to preserve.
test.describe("Plan background preserves composer geometry", () => {
  test.describe.configure({ timeout: 240_000 });

  const viewports = [
    { name: "desktop width", viewport: { width: 1280, height: 900 }, compact: false },
    { name: "mobile width", viewport: { width: 390, height: 844 }, compact: true },
  ] as const;

  for (const { name, viewport, compact } of viewports) {
    test(`keeps composer geometry at ${name}`, async ({ page }) => {
      // Set up the draft at desktop width: the sidebar hydrates and the project
      // picker is reachable there. Then switch to the measured viewport.
      await page.setViewportSize({ width: 1280, height: 900 });
      const seeded = await seedWorkspace({ repoPrefix: "plan-background-" });
      await seedCodexDefaultPreferences(page);

      try {
        await gotoAppShell(page);
        await waitForSidebarHydration(page);
        await openGlobalNewWorkspaceComposer(page);
        await selectNewWorkspaceProject(page, {
          projectKey: seeded.projectKey,
          projectDisplayName: seeded.projectDisplayName,
        });
        await page.setViewportSize(viewport);

        const surface = page.getByTestId("message-input-surface");
        await expect(surface).toBeVisible({ timeout: 30_000 });
        const stripe = page.getByTestId("message-input-plan-stripe");
        await expect(stripe).toHaveCount(0);
        await expectAutoModelSelection(page);
        await expectComposerDensity(page, compact ? 28 : 24);

        // The field is usable, and multiline text keeps its own height. Do this
        // before any plan toggle: the compact plan toggle opens the model sheet,
        // which would sit over the composer.
        const field = page.getByRole("textbox", { name: "Message agent..." });
        await field.click();
        await field.type("x");
        await expect(field).toHaveValue("x");
        const draft = "first line\nsecond line";
        await field.fill(draft);
        await expect(field).toHaveValue(draft);
        const multilineWithoutPlan = await measureComposerGeometry(page);

        // Turning plan on paints the decoration without moving anything.
        await setNewWorkspacePlanMode(page, { enabled: true, compact });
        await expect(surface).toHaveCSS("background-color", "rgb(245, 239, 237)");
        await expect(surface).toHaveCSS("border-color", "rgb(220, 164, 128)");
        expectSameGeometry(multilineWithoutPlan, await measureComposerGeometry(page));
        await expect(field).toHaveValue(draft);
        await expectAutoModelSelection(page);

        // Turning it off restores the plain surface with the draft intact.
        await setNewWorkspacePlanMode(page, { enabled: false, compact });
        expectSameGeometry(multilineWithoutPlan, await measureComposerGeometry(page));
        await expect(field).toHaveValue(draft);
        await expectAutoModelSelection(page);
      } finally {
        await seeded.cleanup();
      }
    });
  }
});
