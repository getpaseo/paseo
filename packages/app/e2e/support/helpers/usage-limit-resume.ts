import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { openAgentRoute, type MockAgentWorkspace } from "./mock-agent";
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
  await page.screenshot({ path: testInfo.outputPath(name) });
}

export async function emitSyntheticUsageLimit({ page, resetsAt }: SyntheticUsageLimitInput) {
  await submitMessageWithButton(page, `Emit synthetic usage limit: ${resetsAt ?? "unknown"}`);
}
