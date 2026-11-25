import { expect } from "@playwright/test";

const timeoutMs = 90_000;

// #4679: an agent's CDP click in a background tab must not take keyboard focus from the composer.
export async function runAgentInputComposerFocusRegression({
  page,
  call,
  serverId,
  targetUrl,
  browserWorkspaceId,
  typingAgent,
}) {
  await page
    .getByTestId(`sidebar-workspace-row-${serverId}:${browserWorkspaceId}`)
    .click({ timeout: timeoutMs });
  const { browserId } = await call("browser_new_tab", { url: targetUrl });
  try {
    await call("browser_wait", { browserId, text: "Typing target", timeoutMs: 15_000 });
    await page
      .getByTestId(`workspace-deck-entry-${serverId}:${browserWorkspaceId}`)
      .getByTestId(`workspace-tab-browser_${browserId}`)
      .click({ timeout: timeoutMs });

    await page
      .getByTestId(`sidebar-workspace-row-${serverId}:${typingAgent.workspaceId}`)
      .click({ timeout: timeoutMs });
    await page
      .getByTestId(`workspace-deck-entry-${serverId}:${typingAgent.workspaceId}`)
      .getByTestId(`workspace-tab-agent_${typingAgent.agentId}`)
      .click({ timeout: timeoutMs });
    const composer = page
      .getByRole("textbox", { name: "Message agent..." })
      .filter({ visible: true })
      .first();
    await composer.click();
    await composer.fill("");

    // The user never clicks the composer again: every key after this must still reach it.
    await page.keyboard.type("user1 ", { delay: 20 });
    const { snapshot } = await call("browser_snapshot", { browserId });
    const ref = snapshot.match(/textbox "Typing target" \[ref=(@e\d+)\]/)?.[1];
    expect(ref, `browser_snapshot did not expose the typing target: ${snapshot}`).toBeTruthy();
    await call("browser_click", { browserId, ref });
    await page.keyboard.type("user2 ", { delay: 20 });
    await call("browser_type", { browserId, ref, text: "agent text" });
    await page.keyboard.type("user3", { delay: 20 });

    const guestValue = JSON.parse(
      (
        await call("browser_evaluate", {
          browserId,
          function: "() => document.getElementById('typing-target').value",
        })
      ).resultJson,
    );
    const composerValue = await composer.inputValue();
    expect(composerValue, "Agent browser input took keys from the focused composer").toBe(
      "user1 user2 user3",
    );
    expect(guestValue, "The browser tab must receive only the agent's text").toBe("agent text");
    await composer.fill("");
    return { composerValue, guestValue };
  } finally {
    await call("browser_close_tab", { browserId }).catch(() => undefined);
  }
}
