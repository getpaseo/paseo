import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserToolsBroker } from "../browser-tools/broker.js";
import type { BrowserToolsResponsePayload } from "../browser-tools/errors.js";
import { resolveBrowserExecutable } from "./browser-capability.js";
import { DaemonPlaywrightHost, type ScreencastFrame } from "./playwright-host.js";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { BrowserMirrorEvent } from "@getpaseo/protocol/browser-activity/rpc-schemas";
import {
  FIXTURE_PASSWORD,
  FIXTURE_USERNAME,
  startVerifyFixtureApp,
  type VerifyFixtureApp,
} from "./fixtures/verify-fixture-app.js";

function isDaemonBrowserAvailable(): boolean {
  try {
    resolveBrowserExecutable();
    return true;
  } catch {
    return false;
  }
}

const BROWSER_AVAILABLE = isDaemonBrowserAvailable();
const WORKSPACE_ID = "wks_verify_slice";
const OTHER_WORKSPACE_ID = "wks_other_workspace";

describe.skipIf(!BROWSER_AVAILABLE)("DaemonPlaywrightHost", { timeout: 20_000 }, () => {
  let paseoHome = "";
  let host: DaemonPlaywrightHost | null = null;
  let app: VerifyFixtureApp | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    paseoHome = mkdtempSync(join(tmpdir(), "paseo-verify-host-test-"));
    tempDirs.push(paseoHome);
    host = new DaemonPlaywrightHost({ paseoHome, logger: pino({ enabled: false }) });
    app = await startVerifyFixtureApp();
  }, 60_000);

  afterAll(async () => {
    await host?.close();
    await app?.close();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function openTab(url: string, profile: string): Promise<string> {
    const created = await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      profile,
      command: { command: "new_tab", args: { url } },
    });
    const browserId =
      created?.ok && created.result.command === "new_tab" ? created.result.browserId : "";
    expect(browserId.length).toBeGreaterThan(0);
    return browserId;
  }

  async function readSnapshotYaml(browserId: string, profile: string): Promise<string> {
    const snapshot = await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      profile,
      command: { command: "snapshot", args: { browserId } },
    });
    return snapshot?.ok && snapshot.result.command === "snapshot" ? snapshot.result.snapshot : "";
  }

  async function executeTabCommand(
    command: BrowserAutomationCommand,
    profile: string,
  ): Promise<BrowserToolsResponsePayload | undefined> {
    return host?.executeLocal({ workspaceId: WORKSPACE_ID, profile, command });
  }

  it("navigates, snapshots, and exposes refs for form controls", async () => {
    const created = await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      command: { command: "new_tab", args: { url: `${app?.url}/login` } },
    });
    expect(created?.ok).toBe(true);
    const browserId = created?.ok ? created.result.browserId : "";

    const snapshot = await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      command: { command: "snapshot", args: { browserId } },
    });
    expect(snapshot?.ok).toBe(true);
    if (snapshot?.ok && snapshot.result.command === "snapshot") {
      expect(snapshot.result.format).toBe("aria-yaml");
      expect(snapshot.result.snapshot).toContain('textbox "Email" @e');
      expect(snapshot.result.snapshot).toContain('button "Sign in" @e');
      expect(snapshot.result.stats.refCount).toBeGreaterThan(0);
    } else {
      expect.unreachable();
    }
  });

  it("fills the login form and reaches the report behind auth", async () => {
    const browserId = await openTab(`${app?.url}/login`, "login-flow");

    const yaml = await readSnapshotYaml(browserId, "login-flow");
    const emailRef = refFor(yaml, "textbox", "Email");
    const passwordRef = refFor(yaml, "textbox", "Password");
    const submitRef = refFor(yaml, "button", "Sign in");
    expect([emailRef, passwordRef, submitRef].every((ref) => ref !== null)).toBe(true);

    await executeTabCommand(
      { command: "fill", args: { browserId, ref: emailRef ?? "", value: FIXTURE_USERNAME } },
      "login-flow",
    );
    await executeTabCommand(
      { command: "fill", args: { browserId, ref: passwordRef ?? "", value: FIXTURE_PASSWORD } },
      "login-flow",
    );
    // Refs expire after page-modifying actions; re-snapshot before clicking submit.
    const freshYaml = await readSnapshotYaml(browserId, "login-flow");
    const freshSubmitRef = refFor(freshYaml, "button", "Sign in");
    expect(freshSubmitRef).not.toBeNull();

    await executeTabCommand(
      {
        command: "click",
        args: {
          browserId,
          ref: freshSubmitRef ?? "",
          button: "left",
          doubleClick: false,
          modifiers: [],
        },
      },
      "login-flow",
    );
    const waited = await executeTabCommand(
      { command: "wait", args: { browserId, text: "Current Report", timeoutMs: 10_000 } },
      "login-flow",
    );
    expect(waited?.ok).toBe(true);

    await host?.close();
    host = new DaemonPlaywrightHost({ paseoHome, logger: pino({ enabled: false }) });
    const restored = await openTab(`${app?.url}/report`, "login-flow");
    expect(await readSnapshotYaml(restored, "login-flow")).toContain("Current Report");
    const isolated = await openTab(`${app?.url}/report`, "separate-login");
    expect(await readSnapshotYaml(isolated, "separate-login")).toContain("Sign in");
  }, 15_000);

  it("keeps Chrome's normal launch and sandbox settings", async () => {
    const browserId = await openTab("chrome://version", "browser-security");
    const version = await executeTabCommand(
      {
        command: "evaluate",
        args: {
          browserId,
          function:
            "() => ({ commandLine: document.querySelector('#command_line').textContent, userAgent: navigator.userAgent, webdriver: navigator.webdriver })",
        },
      },
      "browser-security",
    );
    expect(version?.ok).toBe(true);
    if (!version?.ok || version.result.command !== "evaluate") expect.unreachable();
    const details = JSON.parse(version.result.resultJson);
    expect(details.commandLine).not.toMatch(
      /--(?:no-sandbox|disable-web-security|enable-automation|headless|ignore-certificate-errors|disable-client-side-phishing-detection)/,
    );
    expect(details.userAgent).not.toContain("HeadlessChrome");
    expect(details.webdriver).toBe(false);
    if (process.platform !== "linux") return;
    await executeTabCommand(
      { command: "navigate", args: { browserId, url: "chrome://sandbox" } },
      "browser-security",
    );
    const sandbox = await executeTabCommand(
      { command: "evaluate", args: { browserId, function: "() => document.body.innerText" } },
      "browser-security",
    );
    expect(sandbox).toMatchObject({
      ok: true,
      result: { resultJson: expect.stringContaining("You are adequately sandboxed") },
    });
  }, 15_000);

  it("dispatches trusted coordinate pointer actions", async () => {
    const browserId = await openTab(`${app?.url}/interaction`, "pointer-flow");

    const clicked = await executeTabCommand(
      {
        command: "click",
        args: {
          browserId,
          x: 40,
          y: 30,
          button: "left",
          doubleClick: false,
          modifiers: [],
        },
      },
      "pointer-flow",
    );
    expect(clicked).toMatchObject({ ok: true, result: { command: "click", x: 40, y: 30 } });

    const hovered = await executeTabCommand(
      { command: "hover", args: { browserId, x: 260, y: 30 } },
      "pointer-flow",
    );
    expect(hovered).toMatchObject({ ok: true, result: { command: "hover", x: 260, y: 30 } });

    const dragged = await executeTabCommand(
      {
        command: "drag",
        args: {
          browserId,
          sourceX: 50,
          sourceY: 140,
          targetX: 340,
          targetY: 140,
        },
      },
      "pointer-flow",
    );
    expect(dragged).toMatchObject({
      ok: true,
      result: { command: "drag", sourceX: 50, sourceY: 140, targetX: 340, targetY: 140 },
    });

    const scrolled = await executeTabCommand(
      {
        command: "scroll",
        args: { browserId, x: 600, y: 400, deltaX: 0, deltaY: 500 },
      },
      "pointer-flow",
    );
    expect(scrolled).toMatchObject({
      ok: true,
      result: { command: "scroll", x: 600, y: 400, deltaX: 0, deltaY: 500 },
    });
    await expect
      .poll(async () => {
        const scroll = await executeTabCommand(
          {
            command: "evaluate",
            args: {
              browserId,
              function:
                "() => Math.max(window.scrollY, document.documentElement.scrollTop, document.body.scrollTop)",
            },
          },
          "pointer-flow",
        );
        return scroll?.ok && scroll.result.command === "evaluate"
          ? Number(JSON.parse(scroll.result.resultJson))
          : 0;
      })
      .toBeGreaterThan(0);

    const state = await executeTabCommand(
      {
        command: "evaluate",
        args: {
          browserId,
          function:
            "() => ({ clicked: document.body.dataset.clicked, hovered: document.body.dataset.hovered, dragged: document.body.dataset.dragged, scrollY: Math.max(window.scrollY, document.documentElement.scrollTop, document.body.scrollTop) })",
        },
      },
      "pointer-flow",
    );
    expect(state).toMatchObject({ ok: true, result: { command: "evaluate" } });
    if (state?.ok && state.result.command === "evaluate") {
      expect(JSON.parse(state.result.resultJson)).toEqual({
        clicked: "yes",
        hovered: "yes",
        dragged: "yes",
        scrollY: expect.any(Number),
      });
      expect(JSON.parse(state.result.resultJson).scrollY).toBeGreaterThan(0);
    }
  }, 15_000);

  it("keeps a login made in one workspace for every other workspace", async () => {
    const setCookie = await host?.executeLocal({
      workspaceId: "wks_login_a",
      command: { command: "new_tab", args: { url: `${app?.url}/login` } },
    });
    const tabA = setCookie?.ok ? setCookie.result.browserId : "";
    await host?.executeLocal({
      workspaceId: "wks_login_a",
      command: {
        command: "evaluate",
        args: {
          browserId: tabA,
          function: "() => { document.cookie = 'session=signed-in; max-age=3600'; }",
        },
      },
    });
    const other = await host?.executeLocal({
      workspaceId: "wks_login_b",
      command: { command: "new_tab", args: { url: `${app?.url}/login` } },
    });
    const tabB = other?.ok ? other.result.browserId : "";
    const cookie = await host?.executeLocal({
      workspaceId: "wks_login_b",
      command: {
        command: "evaluate",
        args: { browserId: tabB, function: "() => document.cookie" },
      },
    });
    expect(
      cookie?.ok && cookie.result.command === "evaluate" ? cookie.result.resultJson : "",
    ).toContain("session=signed-in");
  });

  it("exposes a sign-in popup in its workspace and preserves its opener", async () => {
    const openerId = await openTab(`${app?.url}/interaction`, "popup-login");
    const before = await executeTabCommand({ command: "list_tabs", args: {} }, "popup-login");
    if (!before?.ok || before.result.command !== "list_tabs") expect.unreachable();
    const priorIds = new Set(before.result.tabs.map((tab) => tab.browserId));
    const snapshot = await readSnapshotYaml(openerId, "popup-login");
    const ref = refFor(snapshot, "button", "Open sign in");
    expect(ref).not.toBeNull();
    const clicked = await executeTabCommand(
      {
        command: "click",
        args: { browserId: openerId, ref: ref!, button: "left", doubleClick: false, modifiers: [] },
      },
      "popup-login",
    );
    expect(clicked?.ok).toBe(true);
    const after = await executeTabCommand({ command: "list_tabs", args: {} }, "popup-login");
    if (!after?.ok || after.result.command !== "list_tabs") expect.unreachable();
    const popup = after.result.tabs.find((tab) => !priorIds.has(tab.browserId));
    expect(popup).toBeDefined();
    const popupId = popup!.browserId;
    await executeTabCommand(
      { command: "wait", args: { browserId: popupId, text: "Sign in", timeoutMs: 5000 } },
      "popup-login",
    );
    expect(await readSnapshotYaml(popupId, "popup-login")).toContain('textbox "Email"');
    const opener = await executeTabCommand(
      {
        command: "evaluate",
        args: { browserId: popupId, function: "() => window.opener.location.pathname" },
      },
      "popup-login",
    );
    expect(opener).toMatchObject({ ok: true, result: { resultJson: '"/interaction"' } });
    await executeTabCommand({ command: "close_tab", args: { browserId: popupId } }, "popup-login");
    expect(await readSnapshotYaml(openerId, "popup-login")).toContain("Open sign in");
  }, 15_000);

  it("captures console errors and failed requests without recording successes", async () => {
    const created = await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      profile: "logs-flow",
      command: { command: "new_tab", args: { url: `${app?.url}/noisy` } },
    });
    const browserId =
      created?.ok && created.result.command === "new_tab" ? created.result.browserId : "";

    await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      profile: "logs-flow",
      command: { command: "wait", args: { browserId, text: "Noisy page", timeoutMs: 10_000 } },
    });
    // Give the page a moment to emit its console error and failed fetch.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const logs = await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      profile: "logs-flow",
      command: { command: "logs", args: { browserId, maxEntries: 50 } },
    });
    expect(logs?.ok).toBe(true);
    if (logs?.ok && logs.result.command === "logs") {
      expect(logs.result.console.some((entry) => entry.message.includes("boom"))).toBe(true);
      expect(logs.result.network.some((entry) => entry.url.endsWith("/api/missing"))).toBe(true);
      expect(logs.result.network.every((entry) => entry.url.endsWith("/api/missing"))).toBe(true);
    } else {
      expect.unreachable();
    }
  });

  it("returns screenshot evidence refs instead of inline payloads", async () => {
    const created = await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      command: { command: "new_tab", args: { url: `${app?.url}/login` } },
    });
    const browserId =
      created?.ok && created.result.command === "new_tab" ? created.result.browserId : "";
    await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      command: { command: "wait", args: { browserId, text: "Sign in", timeoutMs: 10_000 } },
    });

    const screenshot = await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      command: { command: "screenshot", args: { browserId, fullPage: false } },
    });
    expect(screenshot?.ok).toBe(true);
    if (screenshot?.ok && screenshot.result.command === "screenshot") {
      expect(screenshot.result.mimeType).toBe("image/png");
      expect("dataBase64" in screenshot.result).toBe(false);
      expect(screenshot.result.evidenceRef).toMatch(/^evidence:\/\/\S+\/\S+\/screenshot$/);
      expect(screenshot.result.bytes).toBeGreaterThan(0);
      expect(screenshot.result.width).toBeGreaterThan(0);
      // Size guard: without reveal no single field may carry image bytes.
      expect(Buffer.byteLength(JSON.stringify(screenshot), "utf8")).toBeLessThan(32 * 1024);
    } else {
      expect.unreachable();
    }
  });

  it("captures fresh phone-sized PNG frames only with reveal", async () => {
    const browserId = await openTab(`${app?.url}/login`, "default");
    await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      command: { command: "resize", args: { browserId, width: 390, height: 691 } },
    });

    const screenshot = await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      command: { command: "screenshot", args: { browserId, fullPage: false, reveal: true } },
    });
    expect(screenshot?.ok).toBe(true);
    if (screenshot?.ok && screenshot.result.command === "screenshot") {
      expect(screenshot.result.mimeType).toBe("image/png");
      expect(screenshot.result.evidenceRef).toMatch(/^evidence:\/\//);
      const bytes = Buffer.from(screenshot.result.dataBase64 ?? "", "base64");
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([137, 80, 78, 71]));
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([390, 691]);
    } else {
      expect.unreachable();
    }

    // A second tab hides the first before it navigates; the next frame must
    // contain the new page, not the first tab's retained compositor surface.
    await openTab(`${app?.url}/login`, "default");
    await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      command: { command: "navigate", args: { browserId, url: `${app?.url}/interaction` } },
    });
    const updated = await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      command: { command: "screenshot", args: { browserId, fullPage: false, reveal: true } },
    });
    expect(updated?.ok).toBe(true);
    if (!updated?.ok || updated.result.command !== "screenshot") expect.unreachable();
    expect(updated.result.sha256).not.toBe(screenshot.result.sha256);
    expect([updated.result.width, updated.result.height]).toEqual([390, 691]);
  });

  it("streams JPEG viewport frames that follow page changes until stopped", async () => {
    const browserId = await openTab(`${app?.url}/interaction`, "default");
    await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      command: { command: "resize", args: { browserId, width: 390, height: 691 } },
    });
    const frames: ScreencastFrame[] = [];
    const stop = await host?.startScreencast({
      workspaceId: WORKSPACE_ID,
      browserId,
      onFrame: (frame) => frames.push(frame),
      onEnd: () => {},
    });
    await expect.poll(() => frames.length).toBeGreaterThan(0);
    expect(Buffer.from(frames[0].dataBase64, "base64").subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    );
    expect([frames[0].width, frames[0].height]).toEqual([390, 691]);

    const scroll = () =>
      host?.executeLocal({
        workspaceId: WORKSPACE_ID,
        command: { command: "scroll", args: { browserId, deltaX: 0, deltaY: 300 } },
      });
    const beforeScroll = frames.length;
    await scroll();
    await expect.poll(() => frames.length).toBeGreaterThan(beforeScroll);

    await stop?.();
    const stoppedAt = frames.length;
    const laterFrames: ScreencastFrame[] = [];
    const stopLater = await host?.startScreencast({
      workspaceId: WORKSPACE_ID,
      browserId,
      onFrame: (frame) => laterFrames.push(frame),
      onEnd: () => {},
    });
    await scroll();
    await expect.poll(() => laterFrames.length).toBeGreaterThan(1);
    expect(frames).toHaveLength(stoppedAt);
    await stopLater?.();
  });

  it("scopes screencasts to the workspace and reports a closed tab", async () => {
    const browserId = await openTab(`${app?.url}/login`, "default");
    const noop = () => {};
    await expect(
      host?.startScreencast({
        workspaceId: OTHER_WORKSPACE_ID,
        browserId,
        onFrame: noop,
        onEnd: noop,
      }),
    ).rejects.toMatchObject({ code: "browser_tab_not_found" });

    let ended = false;
    await host?.startScreencast({
      workspaceId: WORKSPACE_ID,
      browserId,
      onFrame: noop,
      onEnd: () => {
        ended = true;
      },
    });
    await executeTabCommand({ command: "close_tab", args: { browserId } }, "default");
    await expect.poll(() => ended).toBe(true);
  });

  it("denies cross-workspace tab access", async () => {
    const created = await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      command: { command: "new_tab", args: { url: `${app?.url}/login` } },
    });
    const browserId =
      created?.ok && created.result.command === "new_tab" ? created.result.browserId : "";

    const foreign = await host?.executeLocal({
      workspaceId: OTHER_WORKSPACE_ID,
      command: { command: "snapshot", args: { browserId } },
    });
    expect(foreign?.ok).toBe(false);
    if (!foreign?.ok) {
      expect(foreign.error.code).toBe("browser_denied");
    }
  });

  it("reports unknown tabs instead of acting on them", async () => {
    const missing = await host?.executeLocal({
      workspaceId: WORKSPACE_ID,
      command: { command: "snapshot", args: { browserId: `${Date.now().toString()}-deadbeef` } },
    });
    expect(missing?.ok).toBe(false);
    if (!missing?.ok) {
      expect(missing.error.code).toBe("browser_tab_not_found");
    }
  });

  it("serves broker-routed commands through the existing wire contract", async () => {
    const broker = new BrowserToolsBroker({});
    const testHost = host;
    expect(testHost).not.toBeNull();
    if (!testHost) {
      return;
    }
    const unregister = broker.registerClient(
      testHost.asHostClient((response) => {
        broker.receiveResponse(response);
      }),
    );
    try {
      const tabs = await broker.execute({
        workspaceId: WORKSPACE_ID,
        command: { command: "list_tabs", args: {} },
      });
      expect(tabs.ok).toBe(true);

      const created = await broker.execute({
        workspaceId: WORKSPACE_ID,
        command: { command: "new_tab", args: { url: `${app?.url}/login` } },
      });
      expect(created.ok).toBe(true);
      if (created.ok && created.result.command === "new_tab") {
        const snapshot = await broker.execute({
          workspaceId: WORKSPACE_ID,
          command: { command: "snapshot", args: { browserId: created.result.browserId } },
        });
        expect(snapshot.ok).toBe(true);
      } else {
        expect.unreachable();
      }
    } finally {
      unregister();
    }
  });
});

function refFor(yaml: string, role: string, name: string): string | null {
  for (const line of yaml.split("\n")) {
    const match = new RegExp(`^- ${role} "${escapeRegExp(name)}" (@e\\d+)$`).exec(line.trim());
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe.skipIf(!BROWSER_AVAILABLE)(
  "DaemonPlaywrightHost cookie import",
  { timeout: 20_000 },
  () => {
    let paseoHome = "";
    let host: DaemonPlaywrightHost | null = null;
    let app: VerifyFixtureApp | null = null;

    beforeAll(async () => {
      paseoHome = mkdtempSync(join(tmpdir(), "paseo-cookie-import-test-"));
      host = new DaemonPlaywrightHost({ paseoHome, logger: pino({ enabled: false }) });
      app = await startVerifyFixtureApp();
    }, 60_000);

    afterAll(async () => {
      await host?.close();
      await app?.close();
      rmSync(paseoHome, { recursive: true, force: true });
    });

    async function openReport(profile: string): Promise<{ browserId: string; url: string }> {
      const created = await host?.executeLocal({
        workspaceId: WORKSPACE_ID,
        profile,
        command: { command: "new_tab", args: { url: `${app?.url}/report` } },
      });
      if (!created?.ok || created.result.command !== "new_tab") expect.unreachable();
      return { browserId: created.result.browserId, url: created.result.url };
    }

    it("signs already open and later launched profiles in with imported cookies", async () => {
      const early = await openReport("early");
      expect(new URL(early.url).pathname).toBe("/login");

      const result = await host?.importCookies([
        {
          name: "verify_auth",
          value: "1",
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ]);
      expect(result).toEqual({ cookieCount: 1, domainCount: 1 });

      const navigated = await host?.executeLocal({
        workspaceId: WORKSPACE_ID,
        profile: "early",
        command: {
          command: "navigate",
          args: { browserId: early.browserId, url: `${app?.url}/report` },
        },
      });
      expect(navigated).toMatchObject({ ok: true, result: { command: "navigate" } });
      if (navigated?.ok && navigated.result.command === "navigate") {
        expect(new URL(navigated.result.url).pathname).toBe("/report");
      }

      const late = await openReport("late");
      expect(new URL(late.url).pathname).toBe("/report");
    });
  },
);

describe.skipIf(!BROWSER_AVAILABLE)("DaemonPlaywrightHost mirror", { timeout: 60_000 }, () => {
  it("reports each action as a DOM-level step and never a password's value", async () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-verify-mirror-test-"));
    const app = await startVerifyFixtureApp();
    const host = new DaemonPlaywrightHost({ paseoHome, logger: pino({ enabled: false }) });
    const events: BrowserMirrorEvent[] = [];
    host.onMirror = (event) => events.push(event);
    const run = (command: BrowserAutomationCommand) =>
      host.executeLocal({ workspaceId: WORKSPACE_ID, command });
    try {
      const created = await run({ command: "new_tab", args: { url: `${app.url}/login` } });
      const browserId =
        created.ok && created.result.command === "new_tab" ? created.result.browserId : "";
      const snapshotYaml = async () => {
        const snapshot = await run({ command: "snapshot", args: { browserId } });
        return snapshot.ok && snapshot.result.command === "snapshot"
          ? snapshot.result.snapshot
          : "";
      };
      let yaml = await snapshotYaml();
      await run({
        command: "fill",
        args: { browserId, ref: refFor(yaml, "textbox", "Email") ?? "", value: FIXTURE_USERNAME },
      });
      yaml = await snapshotYaml();
      await run({
        command: "fill",
        args: {
          browserId,
          ref: refFor(yaml, "textbox", "Password") ?? "",
          value: FIXTURE_PASSWORD,
        },
      });
      yaml = await snapshotYaml();
      await run({
        command: "click",
        args: {
          browserId,
          ref: refFor(yaml, "button", "Sign in") ?? "",
          button: "left",
          doubleClick: false,
          modifiers: [],
        },
      });
      await run({
        command: "wait",
        args: { browserId, text: "Current Report", timeoutMs: 10_000 },
      });

      const actions = events
        .filter((event) => event.browserId === browserId)
        .map((event) => event.action);
      expect(actions.map((action) => action.kind)).toEqual([
        "navigate",
        "fill",
        "fill",
        "click",
        "navigate",
      ]);
      expect(actions[1]).toMatchObject({ kind: "fill", value: FIXTURE_USERNAME });
      expect(actions[2]).toMatchObject({ kind: "fill" });
      expect(actions[2]).not.toHaveProperty("value");
      expect(JSON.stringify(events)).not.toContain(FIXTURE_PASSWORD);
      expect(actions[3]).toMatchObject({
        kind: "click",
        target: { role: "button", name: "Sign in" },
      });
      expect(actions[4]).toMatchObject({
        kind: "navigate",
        url: expect.stringContaining("/report"),
      });
      const listing = await run({ command: "list_tabs", args: {} });
      if (!listing.ok || listing.result.command !== "list_tabs") expect.unreachable();
      expect(listing.result.mirrorEvents).toEqual([events.at(-1)]);
      expect(JSON.stringify(listing.result.mirrorEvents)).not.toContain(FIXTURE_PASSWORD);
    } finally {
      await host.close();
      await app.close();
      rmSync(paseoHome, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!BROWSER_AVAILABLE)(
  "DaemonPlaywrightHost applying app steps",
  { timeout: 60_000 },
  () => {
    it("repeats a person's login from an app and passes it on without the password", async () => {
      const paseoHome = mkdtempSync(join(tmpdir(), "paseo-verify-apply-test-"));
      const app = await startVerifyFixtureApp();
      const host = new DaemonPlaywrightHost({ paseoHome, logger: pino({ enabled: false }) });
      const events: BrowserMirrorEvent[] = [];
      try {
        const created = await host.executeLocal({
          workspaceId: WORKSPACE_ID,
          command: { command: "new_tab", args: { url: `${app.url}/login` } },
        });
        const browserId =
          created.ok && created.result.command === "new_tab" ? created.result.browserId : "";
        host.onMirror = (event) => events.push(event);
        const apply = (action: BrowserMirrorEvent["action"]) =>
          host.applyMirrorAction({
            workspaceId: WORKSPACE_ID,
            browserId,
            action,
            origin: "mac-app",
          });
        // Sent back to back, as an app does: the click must still come after both fills.
        void apply({ kind: "fill", target: { selector: "#email" }, value: FIXTURE_USERNAME });
        void apply({ kind: "fill", target: { selector: "#password" }, value: FIXTURE_PASSWORD });
        await apply({
          kind: "click",
          target: { selector: "#gone", role: "button", name: "Sign in" },
        });
        const waited = await host.executeLocal({
          workspaceId: WORKSPACE_ID,
          command: {
            command: "wait",
            args: { browserId, text: "Current Report", timeoutMs: 10_000 },
          },
        });
        expect(waited.ok).toBe(true);
        const fromApp = events
          .filter((event) => event.origin === "mac-app")
          .map((event) => event.action);
        expect(fromApp.map((action) => action.kind)).toEqual(["fill", "fill", "click"]);
        expect(fromApp[0]).toMatchObject({ value: FIXTURE_USERNAME });
        expect(fromApp[1]).not.toHaveProperty("value");
        expect(JSON.stringify(events)).not.toContain(FIXTURE_PASSWORD);
        // The daemon's own navigation carries no origin, so the app that clicked follows it too.
        expect(events.some((event) => !event.origin && event.action.kind === "navigate")).toBe(
          true,
        );
      } finally {
        await host.close();
        await app.close();
        rmSync(paseoHome, { recursive: true, force: true });
      }
    });
  },
);

describe.skipIf(!BROWSER_AVAILABLE)(
  "DaemonPlaywrightHost across a daemon restart",
  { timeout: 60_000 },
  () => {
    it("reopens open tabs under the same id and forgets closed ones", async () => {
      const paseoHome = mkdtempSync(join(tmpdir(), "paseo-verify-restart-test-"));
      const app = await startVerifyFixtureApp();
      const logger = pino({ enabled: false });
      const tabId = (payload: BrowserToolsResponsePayload) =>
        payload.ok && payload.result.command === "new_tab" ? payload.result.browserId : "";
      try {
        const before = new DaemonPlaywrightHost({ paseoHome, logger });
        const kept = tabId(
          await before.executeLocal({
            workspaceId: WORKSPACE_ID,
            command: { command: "new_tab", args: { url: `${app.url}/login` } },
          }),
        );
        const closed = tabId(
          await before.executeLocal({
            workspaceId: WORKSPACE_ID,
            command: { command: "new_tab", args: { url: `${app.url}/login?closed=1` } },
          }),
        );
        await before.executeLocal({
          workspaceId: WORKSPACE_ID,
          command: { command: "close_tab", args: { browserId: closed } },
        });
        await new Promise((resolve) => setTimeout(resolve, 600));
        await before.close();

        const after = new DaemonPlaywrightHost({ paseoHome, logger });
        try {
          const listed = await after.executeLocal({
            workspaceId: WORKSPACE_ID,
            command: { command: "list_tabs", args: {} },
          });
          const ids =
            listed.ok && listed.result.command === "list_tabs"
              ? listed.result.tabs.map((tab) => tab.browserId)
              : [];
          expect(ids).toEqual([kept]);
          await expect
            .poll(async () => {
              const snapshot = await after.executeLocal({
                workspaceId: WORKSPACE_ID,
                command: { command: "snapshot", args: { browserId: kept } },
              });
              return snapshot.ok && snapshot.result.command === "snapshot"
                ? snapshot.result.url
                : "";
            })
            .toContain("/login");
        } finally {
          await after.close();
        }
      } finally {
        await app.close();
        rmSync(paseoHome, { recursive: true, force: true });
      }
    });
  },
);
