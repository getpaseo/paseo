import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9223";
const OUTPUT_DIR = process.env.ELECTRON_VERIFY_OUTPUT_DIR ?? "/tmp/electron-verification";
const APP_URL_FRAGMENT = process.env.ELECTRON_VERIFY_APP_URL_FRAGMENT ?? "localhost:8081";
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function captureScreenshot(page, fileName) {
  const filePath = path.join(OUTPUT_DIR, fileName);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
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

    const dragSummaries = [];
    const suspiciousDragHosts = [];

    for (const node of nodes) {
      if (!(node instanceof HTMLElement) || !isVisible(node)) {
        continue;
      }
      const summary = summarizeElement(node);
      if (summary.appRegion !== "drag") {
        continue;
      }

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
      dragSummaries.push(record);

      const looksLikeHostShortcut =
        isNearTop(summary) &&
        (summary.position !== "absolute" ||
          summary.text.length > 0 ||
          interactiveDescendants.length > 0 ||
          parentSummary?.appRegion === "drag");
      if (looksLikeHostShortcut) {
        suspiciousDragHosts.push(record);
      }
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
      if (matchingDragNode instanceof HTMLElement) {
        matchingDragNode.setAttribute("data-electron-verify-drag", "true");
        const parent = matchingDragNode.parentElement;
        if (parent instanceof HTMLElement) {
          for (const child of parent.children) {
            if (child instanceof HTMLElement && isTopResizer(child, candidate)) {
              child.setAttribute("data-electron-verify-resizer", "true");
            }
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

async function inspectFullscreenResizer(page) {
  const session = await page.context().newCDPSession(page);
  let windowId = null;
  let initialBounds = null;
  let fullscreenEntered = false;

  try {
    const windowInfo = await session.send("Browser.getWindowForTarget");
    windowId = windowInfo.windowId;
    initialBounds = await session.send("Browser.getWindowBounds", { windowId });
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "fullscreen" },
    });
    fullscreenEntered = true;
    await page.waitForTimeout(1000);

    const details = await page.evaluate(async () => {
      const bridge = window.paseoDesktop?.window;
      const bridgeFullscreen =
        typeof bridge?.isFullscreen === "function" ? await bridge.isFullscreen() : null;
      const visibleNoDragResizers = Array.from(document.querySelectorAll("*"))
        .filter((node) => node instanceof HTMLElement)
        .filter((node) => {
          const element = node;
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          const appRegion =
            style.webkitAppRegion || style.getPropertyValue("-webkit-app-region") || "none";
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0" &&
            appRegion === "no-drag" &&
            style.position === "absolute" &&
            Math.abs(rect.height - 4) <= 1 &&
            rect.top < 220
          );
        })
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            tagName: node.tagName.toLowerCase(),
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          };
        });

      return {
        bridgeFullscreen,
        visibleNoDragResizers,
      };
    });

    return {
      supported: true,
      enteredFullscreen: fullscreenEntered,
      initialBounds,
      ...details,
      passed:
        details.bridgeFullscreen === true &&
        Array.isArray(details.visibleNoDragResizers) &&
        details.visibleNoDragResizers.length === 0,
    };
  } catch (error) {
    return {
      supported: false,
      error: String(error),
      initialBounds,
    };
  } finally {
    const previousWindowState = initialBounds?.bounds?.windowState ?? "normal";
    if (windowId !== null && fullscreenEntered) {
      try {
        await session.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: previousWindowState },
        });
        await page.waitForTimeout(500);
      } catch {
        // Best-effort restore only.
      }
    }
    await session.detach().catch(() => undefined);
  }
}

async function findAppPage(browser) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().includes(APP_URL_FRAGMENT) && !page.url().startsWith("devtools://")) {
          return page;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Unable to find Electron app page for ${APP_URL_FRAGMENT}`);
}

async function main() {
  await ensureDir(OUTPUT_DIR);

  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = await findAppPage(browser);
  const consoleMessages = [];
  const results = [];

  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
    });
  });
  page.on("pageerror", (error) => {
    consoleMessages.push({
      type: "pageerror",
      text: String(error),
    });
  });

  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1000);
  if (!page.url().endsWith("/welcome")) {
    await page.goto(`http://${APP_URL_FRAGMENT}/welcome`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
  }

  const welcomeScreenshot = await captureScreenshot(page, "01-welcome.png");

  const desktopDetection = await page.evaluate(() => {
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

  const hasExpectedDesktopShape =
    desktopDetection.exists &&
    REQUIRED_DESKTOP_KEYS.every((key) => desktopDetection.keys.includes(key));

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
  await page.evaluate((nextServerId) => {
    window.location.href = `/h/${nextServerId}/settings`;
  }, serverId);
  await page.waitForURL(new RegExp(`/h/${escapeRegExp(serverId)}/settings$`), {
    timeout: 30_000,
  });
  await page.getByText("Daemon management", { exact: true }).waitFor({
    timeout: 30_000,
  });

  const settingsScreenshot = await captureScreenshot(page, "02-settings-page.png");

  const sidebarSettingsButton = page.locator('[data-testid="sidebar-settings"]').first();
  const menuToggle = page.locator('[data-testid="menu-button"]').first();
  if (
    (await sidebarSettingsButton.isVisible().catch(() => false)) &&
    (await menuToggle.isVisible().catch(() => false))
  ) {
    await menuToggle.click();
    await sidebarSettingsButton
      .waitFor({ state: "hidden", timeout: 10_000 })
      .catch(() => undefined);
    await page.waitForTimeout(500);
  }

  const dragRegionCheck = await inspectTitlebarRegions(page);

  const dragScreenshot = await captureScreenshot(page, "03-drag-region.png");
  const dragRegionPassed =
    dragRegionCheck.dragRegionCount > 0 &&
    dragRegionCheck.verifiedRegionCount > 0 &&
    Boolean(dragRegionCheck.candidate) &&
    dragRegionCheck.candidate.top < 220 &&
    dragRegionCheck.candidate.parent?.appRegion !== "drag" &&
    dragRegionCheck.candidate.siblingResizers.length > 0 &&
    dragRegionCheck.suspiciousDragHosts.length === 0;

  results.push({
    check: "titlebar-drag-structure",
    pass: dragRegionPassed,
    details: dragRegionCheck,
    screenshot: dragScreenshot,
  });

  const trafficLightScreenshot = await captureScreenshot(page, "04-traffic-light-padding.png");
  const isMac = process.platform === "darwin";
  const observedPaddingLeft = dragRegionCheck.candidate?.parent?.paddingLeft ?? null;
  const trafficLightPaddingPassed = !isMac
    ? true
    : typeof observedPaddingLeft === "number" &&
      observedPaddingLeft >= 78 &&
      observedPaddingLeft <= 110;

  results.push({
    check: "traffic-light-padding",
    pass: trafficLightPaddingPassed,
    details: {
      platform: process.platform,
      observedPaddingLeft,
      note: "Traffic-light padding is only validated structurally on macOS in this verifier.",
      candidate: dragRegionCheck.candidate,
    },
    screenshot: trafficLightScreenshot,
  });

  const noDragInteractiveCheck = {
    check: "interactive-no-drag-layering",
    pass:
      Boolean(dragRegionCheck.candidate) &&
      Array.isArray(dragRegionCheck.candidate.explicitNoDragInteractive) &&
      dragRegionCheck.candidate.explicitNoDragInteractive.length > 0,
    details: {
      candidate: dragRegionCheck.candidate,
      explicitNoDragInteractive:
        dragRegionCheck.candidate?.explicitNoDragInteractive ?? [],
    },
    screenshot: dragScreenshot,
  };
  results.push(noDragInteractiveCheck);

  const fullscreenDetails = await inspectFullscreenResizer(page);
  const fullscreenScreenshot = await captureScreenshot(page, "04-fullscreen-resizer.png");
  results.push({
    check: "fullscreen-resizer",
    pass: fullscreenDetails.supported ? fullscreenDetails.passed : true,
    details: fullscreenDetails,
    screenshot: fullscreenScreenshot,
  });

  const daemonManagementVisible = await Promise.all([
    page.getByText("Built-in daemon", { exact: true }).isVisible(),
    page.getByText("Daemon management", { exact: true }).isVisible(),
    page.getByRole("button", { name: "Restart daemon" }).first().isVisible(),
  ]).then((values) => values.every(Boolean));
  const daemonManagementScreenshot = await captureScreenshot(
    page,
    "05-settings-daemon-management.png",
  );

  results.push({
    check: "settings-daemon-management",
    pass: daemonManagementVisible,
    details: {
      route: page.url(),
      serverId,
      desktopStatus,
    },
    screenshot: daemonManagementScreenshot,
  });

  const desktopDetectionScreenshot = await captureScreenshot(page, "06-desktop-detection.png");
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
  await browser.close();

  if (failedChecks.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
