import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  PaseoBrowserConfig,
  PaseoVerificationConfig,
} from "@getpaseo/protocol/paseo-config-schema";

import { EvidenceStore } from "./evidence-store.js";
import { DaemonPlaywrightHost } from "./playwright-host.js";
import { RecipeRunner } from "./recipe-runner.js";
import type { TypeSafeDecisionRequest } from "../browser-tools/jev-client.js";
import type { BrowserActivityEvent } from "@getpaseo/protocol/browser-activity/rpc-schemas";
import { BrowserActivityHub } from "../browser-tools/browser-activity.js";
import { resolveBrowserExecutable } from "./browser-capability.js";
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
const WORKSPACE_ID = "wks_recipe_slice";

function testConfig(): { browser: PaseoBrowserConfig; verification: PaseoVerificationConfig } {
  return {
    browser: {
      defaultProfile: "recipe-test",
      credentials: {
        "fixture-admin": {
          usernameEnv: "VERIFY_SLICE_EMAIL",
          passwordEnv: "VERIFY_SLICE_PASSWORD",
          allowedOrigins: [],
        },
      },
    },
    verification: {
      recipes: {
        "verify-report": {
          profile: "recipe-test",
          params: ["caseId"],
          steps: [
            {
              action: "ensure-authenticated",
              credential: "fixture-admin",
              login: {
                service: "frontend",
                path: "/login",
                username: { role: "textbox", name: "Email" },
                password: { role: "textbox", name: "Password" },
                submit: { role: "button", name: "Sign in" },
              },
              check: {
                service: "frontend",
                path: "/report?case={{caseId}}",
                visible: { role: "heading", name: "Current Report" },
              },
            },
            { action: "assert-visible", role: "heading", name: "Current Report" },
            { action: "assert-console-errors", max: 0 },
            { action: "assert-failed-requests", max: 0 },
            { action: "screenshot", name: "report" },
          ],
        },
      },
    },
  };
}

describe.skipIf(!BROWSER_AVAILABLE)("RecipeRunner", () => {
  let paseoHome = "";
  let host!: DaemonPlaywrightHost;
  let evidence!: EvidenceStore;
  let runner!: RecipeRunner;
  let app!: VerifyFixtureApp;
  const tempDirs: string[] = [];
  const env = { VERIFY_SLICE_EMAIL: FIXTURE_USERNAME, VERIFY_SLICE_PASSWORD: FIXTURE_PASSWORD };

  beforeAll(async () => {
    paseoHome = mkdtempSync(join(tmpdir(), "paseo-recipe-test-"));
    tempDirs.push(paseoHome);
    host = new DaemonPlaywrightHost({ paseoHome, logger: pino({ enabled: false }) });
    evidence = new EvidenceStore({ paseoHome });
    app = await startVerifyFixtureApp();
    const appUrl = app.url;
    runner = new RecipeRunner({
      host,
      evidence,
      env,
      resolveServiceUrl: async ({ service }) => (service === "frontend" ? appUrl : null),
    });
  }, 60_000);

  afterAll(async () => {
    await host.close();
    await app.close();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the full login-to-report recipe and returns a compact result", async () => {
    const config = testConfig();
    config.browser.credentials["fixture-admin"] = {
      ...config.browser.credentials["fixture-admin"],
      allowedOrigins: [app.url],
    };
    const result = await runner.run({
      workspaceId: WORKSPACE_ID,
      ...config,
      recipeName: "verify-report",
      params: { caseId: "case-1" },
    });

    expect(result.status).toBe("pass");
    expect(result.authReused).toBe(false);
    expect(result.route).toBe(`${app.url}/report?case=case-1`);
    expect(result.consoleErrors).toBe(0);
    expect(result.failedRequests).toBe(0);
    expect(result.evidenceRef).toMatch(/^evidence:\/\/wks_recipe_slice\/evr_/);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(result.rawBytes).toBeGreaterThan(0);
    expect(result.agentBytes).toBeGreaterThan(0);
    expect(result.agentBytes).toBeLessThan(result.rawBytes ?? Number.MAX_SAFE_INTEGER);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FIXTURE_PASSWORD);
    expect(serialized).not.toContain(FIXTURE_USERNAME);
  });

  it("lets Jev drive a goal step and passes only on the goal's verify checks", async () => {
    const requests: TypeSafeDecisionRequest[] = [];
    const goalRunner = new RecipeRunner({
      host,
      evidence,
      env,
      resolveServiceUrl: async ({ service }) => (service === "frontend" ? app.url : null),
      goal: {
        decisionSource: {
          decide: async (request) => {
            requests.push(request);
            const operations = Object.keys(request.questions.operation?.criteria ?? {});
            if (!operations.includes("DONE")) throw new Error("DONE is not offered");
            const probabilities = Object.fromEntries(
              operations.map((operation) => [operation, operation === "DONE" ? 1 : 0]),
            );
            return {
              answers: { operation: { choice: "DONE", confidence: 1, probabilities } },
              model: "jev-test",
              latencyMs: 1,
            };
          },
        },
        minConfidence: () => 0.5,
      },
    });
    const result = await goalRunner.run({
      workspaceId: WORKSPACE_ID,
      browser: { defaultProfile: "goal-test", credentials: {} },
      verification: {
        recipes: {
          "goal-slice": {
            params: [],
            steps: [
              { action: "navigate", service: "frontend", path: "/login" },
              { action: "goal", goal: "Show the sign-in form", verify: [{ text: "Sign in" }] },
            ],
          },
        },
      },
      recipeName: "goal-slice",
    });

    expect(result.status).toBe("pass");
    expect(requests).toHaveLength(1);
    expect(result.checks).toEqual([
      expect.objectContaining({ name: 'goal "Show the sign-in form"', ok: true }),
    ]);
  });

  it("streams the current and next recipe step and pauses between steps on takeover", async () => {
    const events: BrowserActivityEvent[] = [];
    const activity = new BrowserActivityHub((event) => {
      events.push(event);
      if (event.step === 3 && event.phase === "verifying" && !event.pauseRequested) {
        activity.control({
          workspaceId: WORKSPACE_ID,
          browserId: event.browserId,
          action: "pause",
        });
      }
      if (event.phase === "paused") {
        activity.control({
          workspaceId: WORKSPACE_ID,
          browserId: event.browserId,
          action: "resume",
        });
      }
    });
    const activityRunner = new RecipeRunner({
      host,
      evidence,
      env,
      resolveServiceUrl: async ({ service }) => (service === "frontend" ? app.url : null),
      activity,
    });

    const result = await activityRunner.run({
      workspaceId: WORKSPACE_ID,
      // A fresh profile: earlier tests leave the shared one signed in, which skips /login.
      browser: { ...testConfig().browser, defaultProfile: "activity-test" },
      verification: {
        recipes: {
          "activity-slice": {
            params: [],
            steps: [
              { action: "navigate", service: "frontend", path: "/login?token=hidden" },
              {
                action: "fill",
                role: "textbox",
                name: "Email",
                credential: "fixture-admin",
                credentialField: "username",
              },
              { action: "assert-visible", role: "heading", name: "Sign in" },
              { action: "assert-text", text: "Password" },
            ],
          },
        },
      },
      recipeName: "activity-slice",
    });

    expect(result.status).toBe("pass");
    expect(events.map((event) => `${event.step}:${event.phase}`)).toEqual([
      "0:observing",
      "2:executing",
      "3:verifying",
      "3:verifying",
      "3:paused",
      "3:observing",
      "4:verifying",
      "4:finished",
    ]);
    expect(events[1]).toMatchObject({
      kind: "recipe",
      label: "activity-slice",
      workspaceId: WORKSPACE_ID,
      totalSteps: 4,
      action: {
        operation: "fill",
        target: { role: "textbox", name: "Email" },
        valueSlot: "fixture-admin.username",
      },
      next: { operation: "assert-visible", target: { role: "heading", name: "Sign in" } },
    });
    expect(events[1]?.steps.map((step) => step.status)).toEqual([
      "done",
      "active",
      "pending",
      "pending",
    ]);
    expect(events[6]?.next).toBeUndefined();
    expect(events.at(-1)?.result?.status).toBe("passed");
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(FIXTURE_USERNAME);
    expect(serialized).not.toContain("hidden");
  });

  it("stops at the next step once the tab is handed off to the user", async () => {
    let handedOff = false;
    const activity = new BrowserActivityHub((event) => {
      if (event.step === 2 && !handedOff) {
        handedOff = true;
        activity.startHandoff({
          workspaceId: WORKSPACE_ID,
          browserId: event.browserId,
          agentId: "agent-1",
          reason: "Sign in",
          onEnd: () => {},
        });
      }
    });
    const handoffRunner = new RecipeRunner({
      host,
      evidence,
      env,
      resolveServiceUrl: async ({ service }) => (service === "frontend" ? app.url : null),
      activity,
    });

    const result = await handoffRunner.run({
      workspaceId: WORKSPACE_ID,
      browser: { ...testConfig().browser, defaultProfile: "handoff-test" },
      verification: {
        recipes: {
          "handoff-slice": {
            params: [],
            steps: [
              { action: "navigate", service: "frontend", path: "/login" },
              { action: "assert-visible", role: "heading", name: "Sign in" },
            ],
          },
        },
      },
      recipeName: "handoff-slice",
    });

    expect(result.status).toBe("fail");
    expect(result.checks.at(-1)?.detail).toContain(
      "The user controls this tab until they finish the handoff",
    );
  });

  it("fails a goal step clearly when System One is not wired in", async () => {
    const result = await runner.run({
      workspaceId: WORKSPACE_ID,
      browser: testConfig().browser,
      verification: {
        recipes: {
          "goal-off": {
            params: [],
            steps: [
              { action: "navigate", service: "frontend", path: "/login" },
              { action: "goal", goal: "Anything", verify: [{ text: "Sign in" }] },
            ],
          },
        },
      },
      recipeName: "goal-off",
    });

    expect(result.status).toBe("fail");
    expect(result.checks.at(-1)?.detail).toContain("System One");
  });

  it("reuses the stored session on the second run", async () => {
    const config = testConfig();
    config.browser.credentials["fixture-admin"] = {
      ...config.browser.credentials["fixture-admin"],
      allowedOrigins: [app.url],
    };
    const result = await runner.run({
      workspaceId: WORKSPACE_ID,
      ...config,
      recipeName: "verify-report",
      params: { caseId: "case-1" },
    });

    expect(result.status).toBe("pass");
    expect(result.authReused).toBe(true);
  });

  it("persists redacted evidence outside the agent context", async () => {
    const config = testConfig();
    config.browser.credentials["fixture-admin"] = {
      ...config.browser.credentials["fixture-admin"],
      allowedOrigins: [app.url],
    };
    const result = await runner.run({
      workspaceId: WORKSPACE_ID,
      ...config,
      recipeName: "verify-report",
      params: { caseId: "case-2" },
    });
    expect(result.evidenceRef).not.toBeNull();

    const runId = result.runId ?? "";
    const manifest = await evidence?.getManifest({ workspaceId: WORKSPACE_ID, runId });
    const names = manifest?.artifacts.map((entry) => entry.name) ?? [];
    expect(names).toEqual(
      expect.arrayContaining(["report", "screenshot-report", "console", "network"]),
    );

    const report = await evidence?.readArtifact({
      workspaceId: WORKSPACE_ID,
      runId,
      name: "report",
    });
    const reportText = report?.data.toString("utf8") ?? "";
    expect(reportText).not.toContain(FIXTURE_PASSWORD);
    expect(reportText).not.toContain(FIXTURE_USERNAME);
  });

  it("fails closed on wrong credentials without exposing secrets", async () => {
    const config = testConfig();
    config.browser.credentials["fixture-admin"] = {
      ...config.browser.credentials["fixture-admin"],
      allowedOrigins: [app.url],
    };
    const badRunner = new RecipeRunner({
      host,
      evidence,
      env: { VERIFY_SLICE_EMAIL: FIXTURE_USERNAME, VERIFY_SLICE_PASSWORD: "wrong-password" },
      resolveServiceUrl: async () => app.url,
    });
    const result = await badRunner.run({
      workspaceId: "wks_recipe_bad_auth",
      ...config,
      recipeName: "verify-report",
      params: { caseId: "case-1" },
    });

    expect(result.status).toBe("fail");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("wrong-password");
    expect(serialized).toContain("login failed");
  });

  it("fails unknown recipes and missing services without running a browser", async () => {
    const config = testConfig();
    const unknown = await runner.run({
      workspaceId: WORKSPACE_ID,
      ...config,
      recipeName: "does-not-exist",
      params: {},
    });
    expect(unknown.status).toBe("fail");
    expect(unknown.evidenceRef).toBeNull();

    const noServiceRunner = new RecipeRunner({
      host,
      evidence,
      env,
      resolveServiceUrl: async () => null,
    });
    const missingService = await noServiceRunner.run({
      workspaceId: "wks_recipe_no_service",
      ...testConfig(),
      recipeName: "verify-report",
      params: { caseId: "case-1" },
    });
    expect(missingService.status).toBe("fail");
    expect(JSON.stringify(missingService)).toContain("frontend");
  });

  it("denies credential use outside the allowed origins", async () => {
    const config = testConfig();
    config.browser.credentials["fixture-admin"] = {
      ...config.browser.credentials["fixture-admin"],
      allowedOrigins: ["https://other.example.com"],
    };
    const result = await runner.run({
      workspaceId: "wks_recipe_origin",
      ...config,
      recipeName: "verify-report",
      params: { caseId: "case-1" },
    });

    expect(result.status).toBe("fail");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FIXTURE_PASSWORD);
    expect(serialized).toContain("denied");
  });
});
