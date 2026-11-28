import { expect } from "@playwright/test";

const timeoutMs = 90_000;

export const FOCUS_FIXTURE_PATH = "/focus-fixture";

export function buildFocusFixture() {
  return `<!doctype html>
<html>
  <head>
    <title>Browser focus fixture</title>
    <style>
      body { font-family: sans-serif; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
      #drag-source, #drag-target {
        width: 120px;
        height: 44px;
        border: 1px solid #333;
        display: flex;
        align-items: center;
        justify-content: center;
      }
    </style>
  </head>
  <body>
    <button id="click-target" data-clicks="0">Click target</button>
    <label for="typing-target">Typing target</label>
    <input id="typing-target" />
    <div id="drag-source" role="button" tabindex="0">Drag source</div>
    <div id="drag-target" role="button" tabindex="0">Drag target</div>
    <script>
      const button = document.getElementById("click-target");
      button.addEventListener("click", () => {
        const next = Number(button.dataset.clicks || "0") + 1;
        button.dataset.clicks = String(next);
        button.textContent = "Clicks: " + next;
      });
      window.__dragStarted = false;
      window.__dragCompleted = false;
      document.getElementById("drag-source").addEventListener("mousedown", () => {
        window.__dragStarted = true;
      });
      document.getElementById("drag-target").addEventListener("mouseup", () => {
        if (window.__dragStarted) window.__dragCompleted = true;
      });
    </script>
  </body>
</html>`;
}

async function readRef(call, browserId, pattern, label) {
  const { snapshot } = await call("browser_snapshot", { browserId });
  const ref = snapshot.match(pattern)?.[1];
  expect(ref, `browser_snapshot did not expose ${label}: ${snapshot}`).toBeTruthy();
  return ref;
}

async function evalJson(call, browserId, fnSource) {
  const evaluated = await call("browser_evaluate", { browserId, function: fnSource });
  return JSON.parse(evaluated.resultJson);
}

async function readNativeFocusState(evaluateMain) {
  return evaluateMain(`
    const { webContents } = process.mainModule.require('electron');
    const focused = webContents.getFocusedWebContents();
    const guests = webContents.getAllWebContents().filter((wc) => wc.getType() === 'webview');
    return {
      focusedId: focused?.id ?? null,
      focusedType: focused?.getType?.() ?? null,
      winId: win.webContents.id,
      winIsFocused: win.webContents.isFocused(),
      winFocusedFrame: Boolean(win.webContents.focusedFrame),
      guests: guests.map((g) => ({
        id: g.id,
        isFocused: g.isFocused(),
        focusedFrame: Boolean(g.focusedFrame),
      })),
    };
  `);
}

async function expectHostNativeFocus(evaluateMain, label) {
  await expect
    .poll(
      async () => {
        const state = await readNativeFocusState(evaluateMain);
        const anyGuestFocused = state.guests.some((g) => g.focusedFrame);
        return !anyGuestFocused && state.winFocusedFrame ? "host" : JSON.stringify(state);
      },
      { timeout: 5_000, message: `${label}: native Electron focus left the host window` },
    )
    .toBe("host");
}

async function typeIntoNativeFocusedWebContents(evaluateMain, text) {
  await evaluateMain(`
    const { webContents } = process.mainModule.require('electron');
    const focused =
      win.webContents.focusedFrame !== null
        ? win.webContents
        : webContents.getFocusedWebContents();
    if (!focused) throw new Error("No focused WebContents");
    for (const ch of ${JSON.stringify(text)}) {
      focused.sendInputEvent({ type: "keyDown", keyCode: ch });
      focused.sendInputEvent({ type: "char", keyCode: ch });
      focused.sendInputEvent({ type: "keyUp", keyCode: ch });
    }
    return focused.id;
  `);
}

async function clickGuestInputPhysically(page, call, browserId, selector) {
  const rect = await evalJson(
    call,
    browserId,
    `() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }`,
  );
  expect(rect, `Could not find ${selector} in guest`).toBeTruthy();
  const webviewOrigin = await page.evaluate((id) => {
    const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
    if (!webview) return null;
    const box = webview.getBoundingClientRect();
    return { x: box.left, y: box.top };
  }, browserId);
  expect(webviewOrigin, `Could not measure webview ${browserId}`).toBeTruthy();
  await page.mouse.click(webviewOrigin.x + rect.x, webviewOrigin.y + rect.y);
}

// #4679: verify parked tabs, visible split-pane tabs, physical user clicks, and IME composition.
export async function runBrowserFocusIsolationRegression({
  page,
  client,
  call,
  serverId,
  targetUrl,
  browserWorkspaceId,
  callerAgentId,
  typingAgent,
  resizeWindow,
  evaluateMain,
}) {
  const focusUrl = new URL(FOCUS_FIXTURE_PATH, targetUrl).href;
  await page
    .getByTestId(`sidebar-workspace-row-${serverId}:${browserWorkspaceId}`)
    .click({ timeout: timeoutMs });
  const { browserId } = await call("browser_new_tab", { url: focusUrl });

  try {
    await call("browser_wait", { browserId, text: "Typing target", timeoutMs: 15_000 });
    const browserDeck = page.getByTestId(`workspace-deck-entry-${serverId}:${browserWorkspaceId}`);

    // (a) Parked background tab in another workspace: browser_type, browser_keypress,
    // browser_click, and browser_drag must keep 100% of user keystrokes in the composer.
    await browserDeck
      .getByTestId(`workspace-tab-browser_${browserId}`)
      .click({ timeout: timeoutMs });
    await page
      .getByTestId(`sidebar-workspace-row-${serverId}:${typingAgent.workspaceId}`)
      .click({ timeout: timeoutMs });
    await page
      .getByTestId(`workspace-deck-entry-${serverId}:${typingAgent.workspaceId}`)
      .getByTestId(`workspace-tab-agent_${typingAgent.agentId}`)
      .click({ timeout: timeoutMs });

    await page.waitForFunction(
      (id) => {
        const surface = document.querySelector(`[data-paseo-browser-surface="${id}"]`);
        return (
          surface instanceof HTMLElement &&
          surface.style.width === "1px" &&
          surface.hasAttribute("inert") &&
          surface.getAttribute("tabindex") === "-1"
        );
      },
      browserId,
      { timeout: timeoutMs },
    );

    const otherComposer = page
      .getByRole("textbox", { name: "Message agent..." })
      .filter({ visible: true })
      .first();
    await otherComposer.click();
    await otherComposer.fill("");

    await page.keyboard.type("user1 ", { delay: 15 });
    const typingRef = await readRef(
      call,
      browserId,
      /textbox "Typing target" \[ref=(@e\d+)\]/,
      "Typing target",
    );
    const clickRef = await readRef(
      call,
      browserId,
      /button "Click target" \[ref=(@e\d+)\]/,
      "Click target",
    );
    const dragSourceRef = await readRef(
      call,
      browserId,
      /button "Drag source" \[ref=(@e\d+)\]/,
      "Drag source",
    );
    const dragTargetRef = await readRef(
      call,
      browserId,
      /button "Drag target" \[ref=(@e\d+)\]/,
      "Drag target",
    );

    await call("browser_type", { browserId, ref: typingRef, text: "agent-a" });
    await call("browser_keypress", { browserId, ref: typingRef, key: "!" });
    await expectHostNativeFocus(evaluateMain, "After parked browser_type and browser_keypress");
    await typeIntoNativeFocusedWebContents(evaluateMain, "user2 ");
    await call("browser_click", { browserId, ref: clickRef });
    await call("browser_drag", {
      browserId,
      sourceRef: dragSourceRef,
      targetRef: dragTargetRef,
    });
    await expectHostNativeFocus(evaluateMain, "After parked browser_click and browser_drag");
    await typeIntoNativeFocusedWebContents(evaluateMain, "user3");

    await expect
      .poll(() => otherComposer.inputValue(), {
        timeout: 5_000,
        message: "Parked tab automation stole keystrokes from the composer",
      })
      .toBe("user1 user2 user3");
    expect(
      await otherComposer.evaluate((el) => el === document.activeElement),
      "Composer lost focus after parked tab automation",
    ).toBe(true);
    expect(
      await evalJson(call, browserId, "() => document.getElementById('typing-target').value"),
    ).toBe("agent-a!");
    expect(
      await evalJson(
        call,
        browserId,
        "() => Number(document.getElementById('click-target').dataset.clicks)",
      ),
    ).toBe(1);
    expect(await evalJson(call, browserId, "() => Boolean(window.__dragCompleted)")).toBe(true);
    await otherComposer.fill("");

    // (b) Visible side-by-side split-pane browser tab (@Enjoyoer repro):
    // composer on the left, browser tab presented on the right.
    await resizeWindow({ width: 1920, height: 1080 });
    await page.waitForFunction(() => innerWidth >= 1920, null, { timeout: timeoutMs });
    await page
      .getByTestId(`sidebar-workspace-row-${serverId}:${browserWorkspaceId}`)
      .click({ timeout: timeoutMs });
    await browserDeck
      .getByTestId(`workspace-tab-browser_${browserId}`)
      .first()
      .click({ timeout: timeoutMs });
    const visiblePaneRows = browserDeck.getByTestId("workspace-tabs-row").filter({ visible: true });
    if ((await visiblePaneRows.count()) < 2) {
      await page.getByTestId("sidebar-search").click();
      await page.getByTestId("command-center-input").fill("Split pane right");
      await page.getByText("Split pane right", { exact: true }).click();
    }
    await expect(visiblePaneRows).toHaveCount(2);
    // Move the browser tab to the right pane and focus the agent chat composer on the left.
    await browserDeck
      .getByTestId(`workspace-tab-browser_${browserId}`)
      .first()
      .click({ timeout: timeoutMs });
    await page.getByTestId("sidebar-search").click();
    await page.getByTestId("command-center-input").fill("Move tab right");
    await page.getByText("Move tab right", { exact: true }).click();
    await browserDeck
      .getByTestId(`workspace-tab-agent_${callerAgentId}`)
      .first()
      .click({ timeout: timeoutMs });
    await page.waitForFunction(
      (id) => {
        const surface = document.querySelector(`[data-paseo-browser-surface="${id}"]`);
        return (
          surface instanceof HTMLElement &&
          surface.getAttribute("aria-hidden") === "false" &&
          !surface.hasAttribute("inert") &&
          surface.style.pointerEvents === "auto"
        );
      },
      browserId,
      { timeout: timeoutMs },
    );

    // Clear the guest input before side-by-side verification.
    await call("browser_fill", { browserId, ref: typingRef, value: "" });

    const splitComposer = browserDeck
      .getByRole("textbox", { name: "Message agent..." })
      .filter({ visible: true })
      .first();
    await splitComposer.click();
    await splitComposer.fill("");

    await page.keyboard.type("split1 ", { delay: 15 });
    await call("browser_type", { browserId, ref: typingRef, text: "side-a" });
    await call("browser_keypress", { browserId, ref: typingRef, key: "?" });
    await expectHostNativeFocus(evaluateMain, "After visible browser_type and browser_keypress");
    await typeIntoNativeFocusedWebContents(evaluateMain, "split2 ");
    const clickRefVisible = await readRef(
      call,
      browserId,
      /button "Clicks: 1" \[ref=(@e\d+)\]/,
      "Clicks: 1",
    );
    await call("browser_click", { browserId, ref: clickRefVisible });
    await expectHostNativeFocus(evaluateMain, "After visible browser_click");
    await typeIntoNativeFocusedWebContents(evaluateMain, "split3");

    await expect
      .poll(() => splitComposer.inputValue(), {
        timeout: 5_000,
        message: "Visible split-pane automation stole keystrokes from the composer",
      })
      .toBe("split1 split2 split3");
    expect(
      await splitComposer.evaluate((el) => el === document.activeElement),
      "Composer lost focus during visible split-pane automation",
    ).toBe(true);
    expect(
      await evalJson(call, browserId, "() => document.getElementById('typing-target').value"),
    ).toBe("side-a?");
    expect(
      await evalJson(
        call,
        browserId,
        "() => Number(document.getElementById('click-target').dataset.clicks)",
      ),
    ).toBe(2);
    expect(await evalJson(call, browserId, "() => document.hasFocus()")).toBe(true);

    // (d) IME composition active in composer during agent pointer press:
    // pointer press must be refused without blurring or ending composition, then succeed after.
    await splitComposer.evaluate((el) => {
      globalThis.__paseoImeEvents = { blur: 0, compositionend: 0 };
      el.addEventListener("blur", () => {
        globalThis.__paseoImeEvents.blur += 1;
      });
      el.addEventListener("compositionend", () => {
        globalThis.__paseoImeEvents.compositionend += 1;
      });
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      el.dispatchEvent(
        new CompositionEvent("compositionupdate", { bubbles: true, data: "にほん" }),
      );
    });
    const clickRefIme = await readRef(
      call,
      browserId,
      /button "Clicks: 2" \[ref=(@e\d+)\]/,
      "Clicks: 2",
    );
    const blockedClick = await client.callTool({
      name: "browser_click",
      args: { browserId, ref: clickRefIme },
    });
    expect(blockedClick.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "browser_denied",
        retryable: true,
      },
    });
    const imeEventsDuringClick = await page.evaluate(() => globalThis.__paseoImeEvents);
    expect(imeEventsDuringClick).toEqual({ blur: 0, compositionend: 0 });
    expect(await splitComposer.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(
      await evalJson(
        call,
        browserId,
        "() => Number(document.getElementById('click-target').dataset.clicks)",
      ),
    ).toBe(2);

    await splitComposer.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "日本" }));
    });
    await call("browser_click", { browserId, ref: clickRefIme });
    await page.keyboard.type(" ok", { delay: 15 });
    expect(await splitComposer.inputValue()).toBe("split1 split2 split3 ok");
    expect(
      await evalJson(
        call,
        browserId,
        "() => Number(document.getElementById('click-target').dataset.clicks)",
      ),
    ).toBe(3);

    // (c) Physical user click into the presented browser pane still focuses it and accepts typing.
    await call("browser_fill", { browserId, ref: typingRef, value: "" });
    const guestWebContentsId = await page.evaluate((id) => {
      const webview = document.querySelector(`[data-paseo-browser-id="${id}"]`);
      return typeof webview?.getWebContentsId === "function" ? webview.getWebContentsId() : null;
    }, browserId);
    expect(guestWebContentsId, "Presented browser webview had no webContentsId").toBeTruthy();

    await clickGuestInputPhysically(page, call, browserId, "#typing-target");
    await expect
      .poll(() => evalJson(call, browserId, "() => document.activeElement?.id ?? null"), {
        timeout: 5_000,
      })
      .toBe("typing-target");
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.activeElement?.getAttribute("data-paseo-browser-id") ?? null,
          ),
        { timeout: 5_000 },
      )
      .toBe(browserId);
    await expect
      .poll(
        async () => {
          const state = await readNativeFocusState(evaluateMain);
          const guestFocused = !state.winFocusedFrame && state.focusedId === guestWebContentsId;
          return guestFocused ? "guest" : JSON.stringify({ guestWebContentsId, state });
        },
        { timeout: 5_000 },
      )
      .toBe("guest");

    // Dispatch keys to whichever WebContents Chromium natively focused, matching OS typing.
    await typeIntoNativeFocusedWebContents(evaluateMain, "human-typed");
    await expect
      .poll(
        () => evalJson(call, browserId, "() => document.getElementById('typing-target').value"),
        {
          timeout: 5_000,
        },
      )
      .toBe("human-typed");
    expect(await splitComposer.inputValue()).toBe("split1 split2 split3 ok");

    await splitComposer.click();
    await splitComposer.fill("");

    return {
      parkedIsolation: "passed",
      splitPaneIsolation: "passed",
      imeProtection: "passed",
      physicalClickFocus: "passed",
    };
  } finally {
    await call("browser_close_tab", { browserId }).catch(() => undefined);
  }
}
