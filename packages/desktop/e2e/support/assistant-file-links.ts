import { readFile, writeFile } from "node:fs/promises";
import { expect, type Locator, type Page } from "@playwright/test";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
} from "../../../app/e2e/support/helpers/mock-agent";
import { getServerId } from "../../../app/e2e/support/helpers/server-id";
import { installDesktopRuntime, type DesktopRuntimeConfig } from "./runtime";

const explorerTarget: DesktopRuntimeConfig["editorTargets"] = [
  {
    id: "explorer",
    label: "Explorer",
    kind: "file-manager",
    icon: { kind: "symbol", name: "folder" },
  },
];

export interface EditorOpen {
  editorId: string;
  workspacePath: string;
  filePath: string;
}

interface AssistantLinksScenario {
  /** Markdown the mock assistant answers with. */
  response: string;
  /** Files created in the repository the mock agent works in. */
  files?: { path: string; content: string }[];
  /** Where the desktop runtime stub records file-manager opens. Omit to act as a different host. */
  recordPath?: string;
}

export function forwardSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Opens a mock agent whose answer contains `response`, on a desktop runtime that offers Explorer. */
export async function openAssistantLinks(page: Page, scenario: AssistantLinksScenario) {
  if (scenario.recordPath) {
    await writeFile(scenario.recordPath, "");
  }
  await installDesktopRuntime(page, {
    serverId: scenario.recordPath ? getServerId() : "another-desktop-host",
    editorTargets: explorerTarget,
    editorRecordPath: scenario.recordPath,
  });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "assistant-links-",
    title: "Assistant file links",
    initialPrompt: "Show the links.",
    repo: scenario.files ? { files: scenario.files } : undefined,
    featureValues: { mockAssistantResponse: scenario.response },
  });
  await openAgentRoute(page, agent);
  return agent;
}

export function assistantLink(page: Page, text: string): Locator {
  return page.getByTestId("assistant-message").locator("a").filter({ hasText: text });
}

export function fileLinkMenu(page: Page): Locator {
  return page.getByTestId("assistant-file-link-context-menu");
}

export function menuAction(page: Page, name: string | RegExp): Locator {
  return fileLinkMenu(page).getByRole("menuitem", { name });
}

/** Right-clicks a link and waits until the menu has finished fading in, so clicks and screenshots see the final state. */
export async function openLinkMenu(page: Page, linkText: string): Promise<void> {
  await assistantLink(page, linkText).click({ button: "right" });
  await expect(fileLinkMenu(page)).toBeVisible();
  await expect
    .poll(() =>
      fileLinkMenu(page).evaluate((element) => {
        let opacity = 1;
        for (let node: Element | null = element; node; node = node.parentElement) {
          opacity *= Number(getComputedStyle(node).opacity);
        }
        return opacity;
      }),
    )
    .toBe(1);
}

export async function revealFromLinkMenu(page: Page, linkText: string): Promise<void> {
  await openLinkMenu(page, linkText);
  await menuAction(page, "Reveal in Explorer").click();
}

/** File-manager opens recorded by the desktop runtime stub, one JSON object per line. */
export async function expectEditorOpens(recordPath: string, expected: EditorOpen[]): Promise<void> {
  await expect
    .poll(async () => {
      const text = (await readFile(recordPath, "utf8")).trim();
      return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
    })
    .toEqual(expected);
}
