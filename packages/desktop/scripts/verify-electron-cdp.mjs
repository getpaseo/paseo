import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const CDP_PORT = process.env.PASEO_ELECTRON_REMOTE_DEBUGGING_PORT ?? "9223";
const EXPO_PORT = process.env.EXPO_PORT ?? "8082";
const CDP_URL = process.env.CDP_URL ?? `http://127.0.0.1:${CDP_PORT}`;
const OUTPUT_DIR = process.env.ELECTRON_VERIFY_OUTPUT_DIR ?? "/tmp/electron-verification";
const APP_URL_FRAGMENT = process.env.ELECTRON_VERIFY_APP_URL_FRAGMENT ?? `localhost:${EXPO_PORT}`;
const REQUIRED_DESKTOP_KEYS = ["invoke", "events", "window", "dialog", "notification", "opener"];
const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[role='combobox']",
  "[role='tab']",
  "[role='switch']",
  "[role='checkbox']",
  "[role='slider']",
  "[role='menuitem']",
  "[tabindex]",
  "[contenteditable='true']",
].join(", ");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function captureScreenshot(page, fileName) {
  const filePath = path.join(OUTPUT_DIR, fileName);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

function rectsIntersect(left, right) {
  return (
    left.left < right.left + right.width &&
    left.left + left.width > right.left &&
    left.top < right.top + right.height &&
    left.top + left.height > right.top
  );
}

/**
 * The window-chrome rectangle the app must keep clear. macOS reserves the
 * native traffic-light corner; the hand-drawn Windows/Linux controls are flex
 * items inside the header row, so they reserve no band of their own.
 */
function getWindowChromeObstruction(platform) {
  if (platform === "darwin") {
    return { corner: "top-left", left: 0, top: 0, width: 78, height: 45 };
  }
  return { corner: "none", left: 0, top: 0, width: 0, height: 0 };
}

async function inspectSettingsGeometry(page) {
  return page.evaluate(() => {
    function rect(selector) {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      };
    }

    const title = document.querySelector('[data-testid="settings-detail-header-title"]');
    const headerLeft = title instanceof HTMLElement ? title.parentElement : null;
    const headerLeftBounds = headerLeft?.getBoundingClientRect() ?? null;

    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      sidebarRect: rect('[data-testid="settings-sidebar"]'),
      detailPaneRect: rect('[data-testid="settings-detail-pane"]'),
      outerAppSidebarSettingsRect: rect('[data-testid="sidebar-settings"]'),
      backButtonRect: rect('[data-testid="settings-back-to-workspace"]'),
      detailTitleRect: rect('[data-testid="settings-detail-header-title"]'),
      detailHeaderLeftRect: headerLeftBounds
        ? {
            left: headerLeftBounds.left,
            top: headerLeftBounds.top,
            width: headerLeftBounds.width,
            height: headerLeftBounds.height,
          }
        : null,
    };
  });
}

function settingsGeometryClearsWindowChrome(geometry, platform) {
  const obstruction = getWindowChromeObstruction(platform);
  const consumer =
    obstruction.corner === "top-left" ? geometry.backButtonRect : geometry.detailHeaderLeftRect;
  return Boolean(consumer && !rectsIntersect(consumer, obstruction));
}

async function readBridgeFullscreen(page) {
  return page.evaluate(
    async () =>
      (await window.paseoDesktop?.window?.getCurrentWindow?.()?.isFullscreen?.()) === true,
  );
}

async function setNativeFullscreen(page, fullscreen) {
  await page.evaluate(async (nextFullscreen) => {
    const win = window.paseoDesktop?.window?.getCurrentWindow?.();
    if (typeof win?.setFullscreen !== "function") throw new Error("setFullscreen is unavailable");
    await win.setFullscreen(nextFullscreen);
  }, fullscreen);
}

async function waitForBridgeFullscreen(page, expected) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await readBridgeFullscreen(page)) === expected) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for fullscreen=${expected}`);
}

async function inspectTitlebarRegions(page) {
  return page.evaluate((interactiveSelector) => {
    const nodes = Array.from(document.querySelectorAll("*"));
    const annotationId = "electron-verify-titlebar-style";
    const existingAnnotation = document.getElementById(annotationId);
    existingAnnotation?.remove();

    const annotationStyle = document.createElement("style");
    annotationStyle.id = annotationId;
    annotationStyle.textContent = `
      [data-electron-verify-drag="true"] {
        outline: 3px solid #ff4d4f !important;
        outline-offset: -3px !important;
      }
      [data-electron-verify-resizer="true"] {
        outline: 3px solid #52c41a !important;
        outline-offset: -3px !important;
      }
      [data-electron-verify-interactive="true"] {
        outline: 3px solid #1677ff !important;
        outline-offset: -3px !important;
      }
      [data-electron-verify-controls-offender="true"] {
        outline: 3px solid #fa8c16 !important;
        outline-offset: -3px !important;
      }
    `;
    document.head.appendChild(annotationStyle);

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    }

    function summarizeText(element) {
      return (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    }

    function readAppRegion(element) {
      const style = window.getComputedStyle(element);
      return style.webkitAppRegion || style.getPropertyValue("-webkit-app-region") || "none";
    }

    function rectInfo(element) {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
    }

    function summarizeElement(element) {
      const style = window.getComputedStyle(element);
      return {
        tagName: element.tagName.toLowerCase(),
        text: summarizeText(element),
        appRegion: readAppRegion(element),
        position: style.position,
        zIndex: style.zIndex,
        paddingLeft: Number.parseFloat(style.paddingLeft || "0"),
        paddingTop: Number.parseFloat(style.paddingTop || "0"),
        ...rectInfo(element),
      };
    }

    function isNearTop(summary) {
      return summary.top < 220;
    }

    function isTopResizer(element, overlayRect) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) {
        return false;
      }
      const summary = summarizeElement(element);
      return (
        summary.appRegion === "no-drag" &&
        summary.position === "absolute" &&
        Math.abs(summary.height - 4) <= 1 &&
        Math.abs(summary.top - overlayRect.top) <= 2 &&
        Math.abs(summary.left - overlayRect.left) <= 2 &&
        Math.abs(summary.width - overlayRect.width) <= 2
      );
    }

    function summarizeInteractive(element) {
      const summary = summarizeElement(element);
      return {
        ...summary,
        testId: element.getAttribute("data-testid"),
        role: element.getAttribute("role"),
      };
    }

    function buildDragRecord(node, summary) {
      const parent = node.parentElement instanceof HTMLElement ? node.parentElement : null;
      const parentSummary = parent ? summarizeElement(parent) : null;
      const interactiveDescendants = Array.from(node.querySelectorAll(interactiveSelector))
        .filter((child) => child instanceof HTMLElement)
        .filter((child) => isVisible(child))
        .map((child) => summarizeInteractive(child));
      const siblingResizers = parent
        ? Array.from(parent.children)
            .filter((child) => child !== node)
            .filter((child) => child instanceof HTMLElement)
            .filter((child) => isTopResizer(child, summary))
            .map((child) => summarizeElement(child))
        : [];
      const parentInteractive = parent
        ? Array.from(parent.querySelectorAll(interactiveSelector))
            .filter((child) => child instanceof HTMLElement)
            .filter((child) => isVisible(child))
            .map((child) => summarizeInteractive(child))
        : [];
      const explicitNoDragInteractive = parentInteractive.filter(
        (child) => child.appRegion === "no-drag",
      );
      const record = {
        ...summary,
        parent: parentSummary,
        interactiveDescendants: interactiveDescendants.slice(0, 5),
        siblingResizers: siblingResizers.slice(0, 3),
        explicitNoDragInteractive: explicitNoDragInteractive.slice(0, 5),
        parentInteractiveCount: parentInteractive.length,
      };
      const looksLikeHostShortcut =
        isNearTop(summary) &&
        (summary.position !== "absolute" ||
          summary.text.length > 0 ||
          interactiveDescendants.length > 0 ||
          parentSummary?.appRegion === "drag");
      return { record, looksLikeHostShortcut };
    }

    const dragSummaries = [];
    const suspiciousDragHosts = [];

    for (const node of nodes) {
      if (!(node instanceof HTMLElement) || !isVisible(node)) continue;
      const summary = summarizeElement(node);
      if (summary.appRegion !== "drag") continue;
      const { record, looksLikeHostShortcut } = buildDragRecord(node, summary);
      dragSummaries.push(record);
      if (looksLikeHostShortcut) suspiciousDragHosts.push(record);
    }

    const verifiedRegions = dragSummaries
      .filter((entry) => isNearTop(entry))
      .filter((entry) => entry.position === "absolute")
      .filter((entry) => entry.text.length === 0)
      .filter((entry) => entry.parent?.appRegion !== "drag")
      .filter((entry) => entry.siblingResizers.length > 0)
      .sort(
        (left, right) =>
          right.explicitNoDragInteractive.length - left.explicitNoDragInteractive.length ||
          left.top - right.top ||
          right.width - left.width,
      );

    const candidate = verifiedRegions[0] ?? null;
    if (candidate) {
      const matchingDragNode = nodes.find((node) => {
        if (!(node instanceof HTMLElement) || !isVisible(node)) {
          return false;
        }
        const summary = summarizeElement(node);
        return (
          summary.appRegion === "drag" &&
          Math.abs(summary.top - candidate.top) <= 1 &&
          Math.abs(summary.left - candidate.left) <= 1 &&
          Math.abs(summary.width - candidate.width) <= 1 &&
          Math.abs(summary.height - candidate.height) <= 1
        );
      });
      function annotateMatchingParent(parent) {
        if (!(parent instanceof HTMLElement)) return;
        const resizers = Array.from(parent.children).filter(
          (child) => child instanceof HTMLElement && isTopResizer(child, candidate),
        );
        for (const child of resizers) {
          child.setAttribute("data-electron-verify-resizer", "true");
        }
        const interactiveChildren = Array.from(parent.querySelectorAll(interactiveSelector))
          .filter((child) => child instanceof HTMLElement)
          .filter((child) => isVisible(child))
          .filter((child) => summarizeElement(child).appRegion === "no-drag")
          .slice(0, 3);
        for (const child of interactiveChildren) {
          child.setAttribute("data-electron-verify-interactive", "true");
        }
      }

      if (matchingDragNode instanceof HTMLElement) {
        matchingDragNode.setAttribute("data-electron-verify-drag", "true");
        annotateMatchingParent(matchingDragNode.parentElement);
      }
    }

    return {
      interactiveSelector,
      dragRegionCount: dragSummaries.length,
      verifiedRegionCount: verifiedRegions.length,
      candidate,
      suspiciousDragHosts: suspiciousDragHosts.slice(0, 10),
      dragRegions: dragSummaries.slice(0, 10),
    };
  }, INTERACTIVE_SELECTOR);
}

/**
 * The one definition of "the app-drawn controls are clear": collect the visible
 * control set plus every other interactive element that could sit under it, then
 * intersect Node-side with the shared rect helper. The controls check and the
 * fullscreen check both read this, so "clear" cannot drift between the two states.
 */
async function collectAppWindowControls(page) {
  const collected = await page.evaluate((interactiveSelector) => {
    const appTestIds = [
      "window-control-minimize",
      "window-control-maximize",
      "window-control-close",
    ];
    const bootTestIds = [
      "boot-window-control-minimize",
      "boot-window-control-maximize",
      "boot-window-control-close",
    ];

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 && rect.height > 0 && window.getComputedStyle(element).display !== "none"
      );
    }

    function readAppRegion(element) {
      const style = window.getComputedStyle(element);
      return style.webkitAppRegion || style.getPropertyValue("-webkit-app-region") || "none";
    }

    function describe(element) {
      const rect = element.getBoundingClientRect();
      const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
      return {
        tagName: element.tagName.toLowerCase(),
        testId: element.getAttribute("data-testid"),
        role: element.getAttribute("role"),
        accessibleName: (element.getAttribute("aria-label") ?? "").trim(),
        text: text ? text.slice(0, 80) : null,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    }

    const appControls = appTestIds
      .map((testId) => document.querySelector(`[data-testid="${testId}"]`))
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => isVisible(element));
    const bootRoot = document.querySelector("#paseo-boot-window-controls");
    const bootControls = Array.from(
      bootRoot?.querySelectorAll('[data-testid^="boot-window-control-"]') ?? [],
    )
      .filter((element) => element instanceof HTMLElement)
      .filter((element) => isVisible(element));

    let variant = "none";
    if (appControls.length > 0 && bootControls.length > 0) variant = "both";
    else if (appControls.length > 0) variant = "app";
    else if (bootControls.length > 0) variant = "boot";

    let activeControls = [];
    if (variant === "app") activeControls = appControls;
    if (variant === "boot") activeControls = bootControls;

    const expectedTestIds = variant === "boot" ? bootTestIds : appTestIds;
    const controls = activeControls.map((element) => describe(element));
    const missingControls = expectedTestIds.filter(
      (testId) => !controls.some((control) => control.testId === testId),
    );

    // A control's own subtree, an ancestor that wraps it, a full-bleed drag
    // overlay and the top-edge resizer all overlap the buttons by design.
    function isControlPart(element) {
      return activeControls.some(
        (control) => control === element || control.contains(element) || element.contains(control),
      );
    }

    function isFullBleedDragOverlay(element) {
      const rect = element.getBoundingClientRect();
      return readAppRegion(element) === "drag" && rect.width >= window.innerWidth - 2;
    }

    function isTopEdgeResizer(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        (style.position === "absolute" || style.position === "fixed") &&
        rect.height <= 6 &&
        rect.top <= 2 &&
        rect.width >= window.innerWidth - 2
      );
    }

    const candidates = [];
    for (const element of document.querySelectorAll(interactiveSelector)) {
      if (!(element instanceof HTMLElement) || !isVisible(element)) continue;
      if (isControlPart(element)) continue;
      if (isFullBleedDragOverlay(element) || isTopEdgeResizer(element)) continue;
      const index = candidates.length;
      element.setAttribute("data-electron-verify-controls-index", String(index));
      candidates.push({ index, ...describe(element) });
    }

    return {
      innerWidth: window.innerWidth,
      variant,
      appControlCount: appControls.length,
      bootControlCount: bootControls.length,
      controls,
      missingControls,
      candidates,
    };
  }, INTERACTIVE_SELECTOR);

  const offendingElements = [];
  for (const candidate of collected.candidates) {
    const control = collected.controls.find((entry) => rectsIntersect(candidate, entry));
    if (!control) continue;
    offendingElements.push({ ...candidate, intersects: control.testId ?? control.tagName });
  }

  await page.evaluate(
    (offenderIndexes) => {
      for (const element of document.querySelectorAll("[data-electron-verify-controls-index]")) {
        const index = Number(element.getAttribute("data-electron-verify-controls-index"));
        if (offenderIndexes.includes(index)) {
          element.setAttribute("data-electron-verify-controls-offender", "true");
        }
        element.removeAttribute("data-electron-verify-controls-index");
      }
    },
    offendingElements.map((offender) => offender.index),
  );

  return {
    innerWidth: collected.innerWidth,
    variant: collected.variant,
    appControlCount: collected.appControlCount,
    bootControlCount: collected.bootControlCount,
    controls: collected.controls,
    missingControls: collected.missingControls,
    candidateCount: collected.candidates.length,
    offendingElements,
  };
}
async function inspectFullscreenWindowChrome(page, platform) {
  const initiallyFullscreen = await readBridgeFullscreen(page);

  try {
    assert(!initiallyFullscreen, "Electron verifier requires a non-fullscreen QA window");
    const before = await inspectSettingsGeometry(page);
    await setNativeFullscreen(page, true);
    await waitForBridgeFullscreen(page, true);

    const details = await page.evaluate(async () => {
      const bridge = window.paseoDesktop?.window?.getCurrentWindow?.();
      const bridgeFullscreen =
        typeof bridge?.isFullscreen === "function" ? await bridge.isFullscreen() : null;
      return { bridgeFullscreen };
    });
    const fullscreen = await inspectSettingsGeometry(page);
    const controls = platform === "darwin" ? null : await collectAppWindowControls(page);
    const screenshot = await captureScreenshot(page, "04-fullscreen-window-chrome.png");
    // macOS drops the traffic lights in fullscreen, so the reserved corner must
    // collapse. Nothing reserves a band on Windows or Linux any more, so the
    // invariant left to check there is the same one the controls check uses: no
    // interactive element sits under the app-drawn buttons. Whether the controls
    // themselves should hide in fullscreen is an open product question, so this
    // deliberately asserts nothing about their visibility.
    const clearanceRemoved =
      platform === "darwin"
        ? Boolean(
            before.backButtonRect &&
            fullscreen.backButtonRect &&
            before.backButtonRect.top >= 45 &&
            fullscreen.backButtonRect.top < 45 &&
            fullscreen.backButtonRect.top < before.backButtonRect.top,
          )
        : null;
    const controlsClear = controls ? controls.offendingElements.length === 0 : null;

    return {
      supported: true,
      initiallyFullscreen,
      before,
      fullscreen,
      clearanceRemoved,
      controlsClear,
      controlsVariant: controls?.variant ?? null,
      controlCount: controls?.controls.length ?? null,
      offendingCount: controls?.offendingElements.length ?? null,
      offendingElements: controls?.offendingElements ?? [],
      screenshot,
      ...details,
      passed:
        details.bridgeFullscreen === true &&
        (platform === "darwin" ? clearanceRemoved === true : controlsClear === true),
    };
  } catch (error) {
    return {
      supported: false,
      error: String(error),
      initiallyFullscreen,
    };
  } finally {
    if (await readBridgeFullscreen(page)) {
      await setNativeFullscreen(page, false);
      await waitForBridgeFullscreen(page, false);
    }
  }
}

async function inspectHalfScreenSettingsLayout(page, platform) {
  const initialBounds = await page.evaluate(() => ({
    width: window.outerWidth,
    height: window.outerHeight,
  }));

  try {
    await page.evaluate(() => {
      // Electron applies resizeTo to the native BrowserWindow. Unlike
      // page.setViewportSize, this exercises the real window/layout boundary.
      window.resizeTo(751, Math.max(window.outerHeight, 700));
    });
    await page.waitForFunction(() => window.innerWidth === 751, undefined, { timeout: 10_000 });

    const sidebar = page.getByTestId("settings-sidebar");
    const detail = page.getByTestId("settings-detail-pane");
    const outerAppSidebarSettings = page.getByTestId("sidebar-settings");
    await sidebar.waitFor({ state: "visible", timeout: 10_000 });
    await detail.waitFor({ state: "visible", timeout: 10_000 });
    await outerAppSidebarSettings.waitFor({ state: "hidden", timeout: 10_000 });

    const details = await inspectSettingsGeometry(page);
    const obstruction = getWindowChromeObstruction(platform);
    const clearsWindowChrome = settingsGeometryClearsWindowChrome(details, platform);
    const sidebarRight = details.sidebarRect
      ? details.sidebarRect.left + details.sidebarRect.width
      : null;
    const detailRight = details.detailPaneRect
      ? details.detailPaneRect.left + details.detailPaneRect.width
      : null;
    const screenshot = await captureScreenshot(page, "06-half-screen-settings.png");

    return {
      supported: true,
      initialBounds,
      ...details,
      obstruction,
      clearsWindowChrome,
      screenshot,
      passed:
        details.innerWidth === 751 &&
        details.sidebarRect !== null &&
        details.sidebarRect.width >= 300 &&
        details.detailPaneRect !== null &&
        details.detailPaneRect.width >= 400 &&
        details.outerAppSidebarSettingsRect === null &&
        Math.abs(details.sidebarRect.left) <= 1 &&
        sidebarRight !== null &&
        Math.abs(sidebarRight - details.detailPaneRect.left) <= 1 &&
        detailRight !== null &&
        Math.abs(detailRight - details.innerWidth) <= 1 &&
        clearsWindowChrome,
    };
  } catch (error) {
    return { supported: false, initialBounds, error: String(error) };
  } finally {
    await page.evaluate((bounds) => window.resizeTo(bounds.width, bounds.height), initialBounds);
    await page.waitForFunction(
      (width) => Math.abs(window.outerWidth - width) <= 1,
      initialBounds.width,
      { timeout: 10_000 },
    );
  }
}

async function findAppPage(browser) {
  function findMatchingPages() {
    const matches = [];
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().includes(APP_URL_FRAGMENT) && !page.url().startsWith("devtools://")) {
          matches.push(page);
        }
      }
    }
    return matches;
  }
  async function poll(attempt) {
    const pages = findMatchingPages();
    if (pages.length > 1) {
      throw new Error(
        `Expected one Electron QA page for ${APP_URL_FRAGMENT}, found ${pages.length}`,
      );
    }
    if (pages.length === 1) return pages[0];
    if (attempt >= 29) {
      throw new Error(`Unable to find Electron app page for ${APP_URL_FRAGMENT}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    return poll(attempt + 1);
  }
  return poll(0);
}

function attachConsoleCollector(page, consoleMessages) {
  page.on("console", (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
  });
  page.on("pageerror", (error) => {
    consoleMessages.push({ type: "pageerror", text: String(error) });
  });
}

async function navigateToWelcome(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1000);
  if (!page.url().endsWith("/welcome")) {
    await page.goto(`http://${APP_URL_FRAGMENT}/welcome`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
  }
}

async function detectDesktopBridge(page) {
  return page.evaluate(() => {
    const bridge = window.paseoDesktop;
    const keys = bridge && typeof bridge === "object" ? Object.keys(bridge) : [];
    const keyTypes =
      bridge && typeof bridge === "object"
        ? Object.fromEntries(Object.entries(bridge).map(([key, value]) => [key, typeof value]))
        : {};
    return {
      exists: Boolean(bridge && typeof bridge === "object"),
      keys,
      keyTypes,
      platform: bridge?.platform ?? null,
    };
  });
}

async function navigateToSettings(page, serverId) {
  await page.evaluate((nextServerId) => {
    window.location.href = `/h/${nextServerId}/settings`;
  }, serverId);
  await page.getByTestId("settings-sidebar").waitFor({ state: "visible", timeout: 30_000 });
  await page
    .getByTestId("settings-detail-header-title")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function dismissOuterAppSidebarIfVisible(page) {
  const sidebarSettingsButton = page.locator('[data-testid="sidebar-settings"]').first();
  const menuToggle = page.locator('[data-testid="menu-button"]').first();
  const bothVisible =
    (await sidebarSettingsButton.isVisible().catch(() => false)) &&
    (await menuToggle.isVisible().catch(() => false));
  if (!bothVisible) return false;
  await menuToggle.click();
  await sidebarSettingsButton.waitFor({ state: "hidden", timeout: 10_000 });
  await page.waitForTimeout(500);
  return true;
}

async function restoreOuterAppSidebar(page, wasDismissed) {
  if (!wasDismissed) return;
  const menuToggle = page.locator('[data-testid="menu-button"]').first();
  const sidebarSettingsButton = page.locator('[data-testid="sidebar-settings"]').first();
  await menuToggle.click();
  await sidebarSettingsButton.waitFor({ state: "visible", timeout: 10_000 });
}

async function clearTitlebarAnnotations(page) {
  await page.evaluate(() => {
    document.getElementById("electron-verify-titlebar-style")?.remove();
    for (const attribute of [
      "data-electron-verify-drag",
      "data-electron-verify-resizer",
      "data-electron-verify-interactive",
      "data-electron-verify-controls-offender",
      "data-electron-verify-controls-index",
    ]) {
      for (const element of document.querySelectorAll(`[${attribute}]`)) {
        element.removeAttribute(attribute);
      }
    }
  });
}

function evaluateDragRegionCheck(dragRegionCheck) {
  return (
    dragRegionCheck.dragRegionCount > 0 &&
    dragRegionCheck.verifiedRegionCount > 0 &&
    Boolean(dragRegionCheck.candidate) &&
    dragRegionCheck.candidate.top < 220 &&
    dragRegionCheck.candidate.parent?.appRegion !== "drag" &&
    dragRegionCheck.candidate.siblingResizers.length > 0 &&
    dragRegionCheck.suspiciousDragHosts.length === 0
  );
}

function evaluateTrafficLightAvoidance(dragRegionCheck) {
  const firstInteractive = dragRegionCheck.candidate?.explicitNoDragInteractive?.find(
    (entry) => entry.testId === "settings-back-to-workspace",
  );
  return Boolean(
    firstInteractive &&
    !rectsIntersect(firstInteractive, { left: 0, top: 0, width: 78, height: 45 }),
  );
}

/**
 * The app draws its own minimise/maximise/close buttons, and the preload injects
 * a plain-DOM fallback set until the bundle mounts. Exactly one set may be
 * visible, its buttons must not sit under another interactive element, and each
 * one must keep an accessible name.
 */
async function inspectAppWindowControlsClearance(page) {
  if (process.platform === "darwin") {
    return {
      supported: true,
      skipped: true,
      passed: true,
      reason: "macOS keeps the native traffic lights, so the app draws no window controls to check",
      variant: null,
      innerWidth: null,
      appControlCount: 0,
      bootControlCount: 0,
      controls: [],
      accessibleNames: [],
      missingControls: [],
      missingAccessibleNames: [],
      candidateCount: 0,
      offendingCount: 0,
      offendingElements: [],
    };
  }

  const collected = await collectAppWindowControls(page);
  const missingAccessibleNames = collected.controls
    .filter((control) => control.accessibleName.length === 0)
    .map((control) => control.testId ?? control.tagName);

  let reason = null;
  if (collected.variant === "both") {
    reason = "The app controls and the preload boot fallback are visible at the same time";
  } else if (collected.variant === "none") {
    reason = "Neither the app controls nor the preload boot fallback are visible";
  } else if (collected.missingControls.length > 0) {
    reason = `Missing ${collected.variant} controls: ${collected.missingControls.join(", ")}`;
  } else if (collected.offendingElements.length > 0) {
    reason = `${collected.offendingElements.length} interactive element(s) overlap the controls`;
  } else if (missingAccessibleNames.length > 0) {
    reason = `Window controls without an aria-label: ${missingAccessibleNames.join(", ")}`;
  }

  return {
    supported: true,
    skipped: false,
    passed:
      (collected.variant === "app" || collected.variant === "boot") &&
      collected.missingControls.length === 0 &&
      collected.offendingElements.length === 0 &&
      missingAccessibleNames.length === 0,
    reason,
    variant: collected.variant,
    innerWidth: collected.innerWidth,
    appControlCount: collected.appControlCount,
    bootControlCount: collected.bootControlCount,
    controls: collected.controls,
    accessibleNames: collected.controls.map((control) => ({
      testId: control.testId,
      accessibleName: control.accessibleName,
    })),
    missingControls: collected.missingControls,
    missingAccessibleNames,
    candidateCount: collected.candidateCount,
    offendingCount: collected.offendingElements.length,
    offendingElements: collected.offendingElements,
  };
}

async function collectDragRegionResults(page, dragRegionCheck, dragScreenshot, results) {
  results.push({
    check: "titlebar-drag-structure",
    pass: evaluateDragRegionCheck(dragRegionCheck),
    details: dragRegionCheck,
    screenshot: dragScreenshot,
  });

  const trafficLightScreenshot = await captureScreenshot(page, "04-traffic-light-avoidance.png");
  const firstInteractive = dragRegionCheck.candidate?.explicitNoDragInteractive?.find(
    (entry) => entry.testId === "settings-back-to-workspace",
  );
  results.push({
    check: "traffic-light-avoidance",
    pass: process.platform === "darwin" ? evaluateTrafficLightAvoidance(dragRegionCheck) : true,
    skipped: process.platform !== "darwin",
    details: {
      platform: process.platform,
      obstruction: process.platform === "darwin" ? { width: 78, height: 45 } : null,
      firstInteractive: firstInteractive ?? null,
      note:
        process.platform === "darwin"
          ? "The first interactive sidebar row must not intersect the traffic-light rectangle."
          : "Skipped here; the half-screen check exercises the right-side obstruction on Windows/Linux.",
      candidate: dragRegionCheck.candidate,
    },
    screenshot: trafficLightScreenshot,
  });

  results.push({
    check: "interactive-no-drag-layering",
    pass:
      Boolean(dragRegionCheck.candidate) &&
      Array.isArray(dragRegionCheck.candidate.explicitNoDragInteractive) &&
      dragRegionCheck.candidate.explicitNoDragInteractive.length > 0,
    details: {
      candidate: dragRegionCheck.candidate,
      explicitNoDragInteractive: dragRegionCheck.candidate?.explicitNoDragInteractive ?? [],
    },
    screenshot: dragScreenshot,
  });
}

async function collectSettingsSplitResult(page, serverId, desktopStatus, results) {
  const geometry = await inspectSettingsGeometry(page);
  const sidebarRight = geometry.sidebarRect
    ? geometry.sidebarRect.left + geometry.sidebarRect.width
    : null;
  const settingsScreenshot = await captureScreenshot(page, "05-settings-split.png");
  results.push({
    check: "settings-split",
    pass: Boolean(
      geometry.sidebarRect &&
      geometry.detailPaneRect &&
      geometry.detailTitleRect &&
      sidebarRight !== null &&
      Math.abs(sidebarRight - geometry.detailPaneRect.left) <= 1,
    ),
    details: {
      route: page.url(),
      serverId,
      desktopStatus,
      geometry,
    },
    screenshot: settingsScreenshot,
  });
}

async function main() {
  await ensureDir(OUTPUT_DIR);

  const browser = await chromium.connectOverCDP(CDP_URL);
  let page = null;
  let initialPageUrl = null;
  let outerSidebarDismissed = false;

  try {
    page = await findAppPage(browser);
    initialPageUrl = page.url();
    const consoleMessages = [];
    const results = [];

    attachConsoleCollector(page, consoleMessages);
    await navigateToWelcome(page);

    const welcomeScreenshot = await captureScreenshot(page, "01-welcome.png");
    const desktopDetection = await detectDesktopBridge(page);

    const hasExpectedDesktopShape =
      desktopDetection.exists &&
      REQUIRED_DESKTOP_KEYS.every((key) => desktopDetection.keys.includes(key));
    assert(
      ["darwin", "win32", "linux"].includes(desktopDetection.platform),
      `Unexpected Electron platform: ${desktopDetection.platform}`,
    );

    results.push({
      check: "desktop-detection",
      pass: hasExpectedDesktopShape,
      details: desktopDetection,
      screenshot: welcomeScreenshot,
    });

    const desktopStatus = await page.evaluate(() =>
      window.paseoDesktop.invoke("desktop_daemon_status"),
    );
    assert(
      typeof desktopStatus?.serverId === "string" && desktopStatus.serverId.trim().length > 0,
      "desktop_daemon_status did not return a serverId",
    );

    const serverId = desktopStatus.serverId.trim();
    await navigateToSettings(page, serverId);

    await captureScreenshot(page, "02-settings-page.png");
    outerSidebarDismissed = await dismissOuterAppSidebarIfVisible(page);

    const dragRegionCheck = await inspectTitlebarRegions(page);
    const dragScreenshot = await captureScreenshot(page, "03-drag-region.png");
    await collectDragRegionResults(page, dragRegionCheck, dragScreenshot, results);

    const controlsClearance = await inspectAppWindowControlsClearance(page);
    const controlsScreenshot = await captureScreenshot(page, "04-app-window-controls.png");
    results.push({
      check: "app-window-controls-clearance",
      pass: controlsClearance.skipped ? true : controlsClearance.passed,
      skipped: controlsClearance.skipped,
      details: controlsClearance,
      screenshot: controlsScreenshot,
    });

    const fullscreenDetails = await inspectFullscreenWindowChrome(page, desktopDetection.platform);
    results.push({
      check: "fullscreen-window-chrome",
      pass: fullscreenDetails.supported && fullscreenDetails.passed,
      details: fullscreenDetails,
      screenshot: fullscreenDetails.screenshot ?? null,
    });

    await collectSettingsSplitResult(page, serverId, desktopStatus, results);

    if (outerSidebarDismissed) {
      await restoreOuterAppSidebar(page, outerSidebarDismissed);
      outerSidebarDismissed = false;
    }

    const halfScreenDetails = await inspectHalfScreenSettingsLayout(
      page,
      desktopDetection.platform,
    );
    results.push({
      check: "half-screen-settings-layout",
      pass: halfScreenDetails.supported && halfScreenDetails.passed,
      details: halfScreenDetails,
      screenshot: halfScreenDetails.screenshot ?? null,
    });

    const desktopDetectionScreenshot = await captureScreenshot(page, "07-desktop-detection.png");
    results[0].screenshot = desktopDetectionScreenshot;

    const report = {
      cdpUrl: CDP_URL,
      outputDir: OUTPUT_DIR,
      pageUrl: page.url(),
      desktopStatus,
      results,
      consoleMessages,
    };

    const reportPath = path.join(OUTPUT_DIR, "report.json");
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const failedChecks = results.filter((result) => !result.pass);
    console.log(JSON.stringify(report, null, 2));
    if (failedChecks.length > 0) process.exitCode = 1;
  } finally {
    if (page && !page.isClosed()) {
      await clearTitlebarAnnotations(page);
      await restoreOuterAppSidebar(page, outerSidebarDismissed);
      if (initialPageUrl && page.url() !== initialPageUrl) {
        await page.goto(initialPageUrl, { waitUntil: "domcontentloaded" });
      }
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
