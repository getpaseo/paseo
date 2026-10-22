import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { openAgentRoute, type MockAgentWorkspace } from "./mock-agent";
import { daemonWsRoutePattern } from "./daemon-port";
import { submitMessageWithButton } from "./composer";

interface UsageLimitChatInput {
  page: Page;
  agent: MockAgentWorkspace;
  viewport: NonNullable<ReturnType<Page["viewportSize"]>>;
}

interface UsageLimitPreferenceInput {
  page: Page;
  enabled: boolean;
}

interface UsageLimitCaptureInput {
  page: Page;
  testInfo: TestInfo;
  name: string;
  colorScheme: "light" | "dark";
}

interface SyntheticUsageLimitInput {
  page: Page;
  resetsAt: string | null;
}

export function usageLimitResumeSwitch(page: Page): Locator {
  return page.getByRole("switch", { name: "Resume after usage limit", exact: true });
}

export async function openUsageLimitChat({ page, agent, viewport }: UsageLimitChatInput) {
  await page.setViewportSize(viewport);
  await openAgentRoute(page, agent);
}

export async function setUsageLimitResume({ page, enabled }: UsageLimitPreferenceInput) {
  const toggle = usageLimitResumeSwitch(page);
  await expect(toggle).toHaveAttribute("aria-checked", String(!enabled));
  await toggle.click();
}

export async function reloadUsageLimitChat(page: Page) {
  await page.reload();
  await expect(usageLimitResumeSwitch(page)).toBeVisible();
}

export async function captureUsageLimit({
  page,
  testInfo,
  name,
  colorScheme,
}: UsageLimitCaptureInput) {
  await page.emulateMedia({ colorScheme });
  // Reanimated drives this transition in JavaScript, so capture the settled thumb position.
  await expect
    .poll(() =>
      usageLimitResumeSwitch(page).evaluate((toggle) => {
        const thumb = toggle.querySelector('div[style*="translateX"]');
        const track = thumb?.parentElement;
        if (!track || !thumb) return false;
        const trackBounds = track.getBoundingClientRect();
        const thumbBounds = thumb.getBoundingClientRect();
        return toggle.getAttribute("aria-checked") === "true"
          ? trackBounds.right - thumbBounds.right < 4
          : thumbBounds.left - trackBounds.left < 4;
      }),
    )
    .toBe(true);
  await page.screenshot({ path: testInfo.outputPath(name) });
}

export async function emitSyntheticUsageLimit({ page, resetsAt }: SyntheticUsageLimitInput) {
  await submitMessageWithButton(page, `Emit synthetic usage limit: ${resetsAt ?? "unknown"}`);
}

/** Holds one real-client preference RPC at the network boundary, then rejects only that save. */
export async function holdUsageLimitSave(input: { page: Page; agentId: string }) {
  const requested = Promise.withResolvers<void>();
  let rejectSave: (() => void) | null = null;
  let held = false;
  await input.page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const envelope = JSON.parse(typeof message === "string" ? message : message.toString("utf8"));
      if (
        !held &&
        envelope.type === "session" &&
        envelope.message?.type === "update_agent_request" &&
        envelope.message.agentId === input.agentId
      ) {
        held = true;
        rejectSave = () =>
          ws.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "rpc_error",
                payload: {
                  requestId: envelope.message.requestId,
                  requestType: "update_agent_request",
                  error: "Preference could not be saved",
                  code: "save_rejected",
                },
              },
            }),
          );
        requested.resolve();
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  return {
    waitForRequest: () => requested.promise,
    reject: () => {
      if (!rejectSave) throw new Error("Preference save has not arrived");
      rejectSave();
    },
  };
}
