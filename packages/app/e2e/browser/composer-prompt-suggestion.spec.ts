import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { seedWorkspace } from "../support/helpers/seed-client";

const PLUGIN_ID = "composer-prompt-suggestion-e2e";
const SUGGESTION_TEXT = "Run the full verification suite";

const SUGGESTION_PLUGIN_SOURCE = `import { useComposer } from "@getpaseo/plugin/client";
import { useEffect, useRef } from "react";

// The composer is a snapshot that changes with every state update, including the suggestion this
// item sets, so the effect reads it through a ref and runs once per mount.
function SuggestionInjector() {
  const composer = useComposer();
  const composerRef = useRef(composer);
  composerRef.current = composer;
  useEffect(() => {
    composerRef.current.setSuggestion(${JSON.stringify(SUGGESTION_TEXT)});
    return () => {
      composerRef.current.setSuggestion(null);
    };
  }, []);
  return null;
}

export default function contribute(client) {
  client.addComposerItem({ id: "suggestion-injector", Component: SuggestionInjector });
  return () => {};
}
`;

async function placeholderOverlapsHint(input: Locator, hint: Locator): Promise<boolean> {
  const hintBox = await hint.boundingBox();
  if (!hintBox) throw new Error("Suggestion hint has no layout box");
  return input.evaluate((element, box) => {
    const textarea = element as HTMLTextAreaElement;
    const style = getComputedStyle(textarea);
    const rect = textarea.getBoundingClientRect();
    const mirror = document.createElement("div");
    for (const property of [
      "boxSizing",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "fontFamily",
      "fontSize",
      "fontWeight",
      "letterSpacing",
      "lineHeight",
      "textIndent",
      "wordSpacing",
    ] as const) {
      mirror.style[property] = style[property];
    }
    Object.assign(mirror.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      borderStyle: "solid",
      borderColor: "transparent",
      whiteSpace: "pre-wrap",
      overflowWrap: "break-word",
      visibility: "hidden",
    });
    const text = document.createTextNode(textarea.placeholder);
    mirror.appendChild(text);
    document.body.appendChild(mirror);
    const range = document.createRange();
    range.selectNodeContents(text);
    const lines = Array.from(range.getClientRects());
    mirror.remove();
    return lines.some(
      (line) =>
        line.right > box.x &&
        line.left < box.x + box.width &&
        line.bottom > box.y &&
        line.top < box.y + box.height,
    );
  }, hintBox);
}

test("plugin prompt suggestion renders as ghost text, accepts on Tab without submitting, and clears on unload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "composer-prompt-suggestion-" });
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: "Suggestion agent",
    model: "e2e-fast-stream",
    modeId: "load-test",
  });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const previous = await client.getDaemonConfig();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-composer-prompt-suggestion-"));
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
  );
  await writeFile(path.join(directory, "index.client.tsx"), SUGGESTION_PLUGIN_SOURCE);

  try {
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    await gotoAppShell(page);
    await openAgentRoute(page, { workspaceId: workspace.workspaceId, agentId: agent.id });

    const input = page.locator('[data-testid="message-input-root"] textarea');
    const hint = page.getByTestId("composer-suggestion-hint");
    await expect(input).toBeVisible({ timeout: 30_000 });
    await expect(input).toHaveAttribute("placeholder", SUGGESTION_TEXT, { timeout: 30_000 });

    // Focus the empty composer: the trailing "Tab to accept" hint appears without overlapping.
    await input.click();
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText("Tab to accept");
    // The hint stays transparent until measured; the placeholder makes room for it in that render.
    await expect
      .poll(async () => Number(await hint.evaluate((el) => getComputedStyle(el).opacity)))
      .toBeGreaterThan(0);
    expect(await placeholderOverlapsHint(input, hint)).toBe(false);

    // Pressing Tab fills the editable draft without auto-submitting.
    await page.keyboard.press("Tab");
    await expect(input).toHaveValue(SUGGESTION_TEXT);
    await expect(hint).toHaveCount(0);

    // Editing or clearing after acceptance does not re-show the consumed suggestion.
    await input.fill("");
    await expect(input).not.toHaveAttribute("placeholder", SUGGESTION_TEXT);
    await expect(hint).toHaveCount(0);

    // Re-mounting via plugin removal & reinstall verifies unload cleanup clears any active suggestion.
    await client.removePlugin(PLUGIN_ID);
    await client.installDirectoryPlugin(directory);
    await expect(input).toHaveAttribute("placeholder", SUGGESTION_TEXT, { timeout: 30_000 });

    // Typing hides the hint and preserves the user's text.
    await input.click();
    await expect(hint).toBeVisible();
    await page.keyboard.type("Custom prompt");
    await expect(input).toHaveValue("Custom prompt");
    await expect(hint).toHaveCount(0);

    // Clearing the text shows the plugin suggestion again until the plugin is unloaded.
    await input.fill("");
    await expect(input).toHaveAttribute("placeholder", SUGGESTION_TEXT);
    await client.removePlugin(PLUGIN_ID);
    await expect(input).not.toHaveAttribute("placeholder", SUGGESTION_TEXT, { timeout: 30_000 });
  } finally {
    await client.removePlugin(PLUGIN_ID).catch(() => undefined);
    await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
    await client.close();
    await rm(directory, { recursive: true, force: true });
    await workspace.cleanup();
  }
});
