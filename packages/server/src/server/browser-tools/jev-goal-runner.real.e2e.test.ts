import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserToolsExecuteInput } from "./broker.js";
import { JevBrowserGoalRunner } from "./jev-goal-runner.js";
import {
  FIXTURE_PASSWORD,
  FIXTURE_USERNAME,
  startVerifyFixtureApp,
  type VerifyFixtureApp,
} from "../verify/fixtures/verify-fixture-app.js";
import { DaemonPlaywrightHost } from "../verify/playwright-host.js";

const RUN_REAL_E2E = process.env.RUN_TYPESAFE_E2E === "1";
const WORKSPACE_ID = "wks_jev_real_e2e";

describe.skipIf(!RUN_REAL_E2E)("Jev browser goal real E2E", () => {
  let app: VerifyFixtureApp;
  let host: DaemonPlaywrightHost;
  let paseoHome: string;

  beforeAll(async () => {
    paseoHome = mkdtempSync(join(tmpdir(), "paseo-jev-real-e2e-"));
    app = await startVerifyFixtureApp();
    host = new DaemonPlaywrightHost({ paseoHome, logger: pino({ enabled: false }) });
  }, 60_000);

  afterAll(async () => {
    await host.close();
    await app.close();
    rmSync(paseoHome, { recursive: true, force: true });
  });

  it("uses live TypeSafe decisions to complete and verify a Playwright login flow", async () => {
    const broker = {
      execute: (input: BrowserToolsExecuteInput) =>
        host.executeLocal({
          workspaceId: input.workspaceId ?? WORKSPACE_ID,
          command: input.command,
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(input.agentId ? { agentId: input.agentId } : {}),
        }),
    };
    const runner = new JevBrowserGoalRunner({ broker });
    const result = await runner.run(
      {
        goal: "Sign in using the email and password value slots, then reach Current Report.",
        url: `${app.url}/login`,
        values: {
          email: { value: FIXTURE_USERNAME, description: "fixture account email" },
          password: { value: FIXTURE_PASSWORD, description: "fixture account password" },
        },
        verify: [{ text: "Current Report" }, { url: "/report" }],
        maxSteps: 10,
        minConfidence: 0,
      },
      { agentId: "jev-real-e2e", cwd: process.cwd(), workspaceId: WORKSPACE_ID },
    );

    expect(result.status).toBe("passed");
    expect(result.steps.some((step) => step.operation === "FILL")).toBe(true);
    expect(result.steps.some((step) => step.operation === "CLICK")).toBe(true);

    const screenshot = await host.executeLocal({
      workspaceId: WORKSPACE_ID,
      command: {
        command: "screenshot",
        args: { browserId: result.browserId, fullPage: true, reveal: true },
      },
    });
    expect(screenshot.ok).toBe(true);
    if (screenshot.ok && screenshot.result.command === "screenshot") {
      expect(screenshot.result.dataBase64).toBeTruthy();
      const outputPath = process.env.JEV_E2E_SCREENSHOT_PATH;
      if (outputPath && screenshot.result.dataBase64) {
        writeFileSync(outputPath, Buffer.from(screenshot.result.dataBase64, "base64"), {
          mode: 0o600,
        });
      }
    }
  }, 60_000);

  // Agents describe a goal in the person's words; the page may word the control differently.
  it("follows a link whose label is worded differently from the goal", async () => {
    const pages = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        request.url === "/help"
          ? "<title>Example Domains</title><h1>Example Domains</h1>"
          : '<title>Example Domain</title><h1>Example Domain</h1><p>This domain is for use in documentation.</p><a href="/help">Learn more</a>',
      );
    });
    await new Promise<void>((resolve) => pages.listen(0, "127.0.0.1", resolve));
    const { port } = pages.address() as AddressInfo;
    try {
      const runner = new JevBrowserGoalRunner({
        broker: {
          execute: (input: BrowserToolsExecuteInput) =>
            host.executeLocal({
              workspaceId: input.workspaceId ?? WORKSPACE_ID,
              command: input.command,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            }),
        },
      });
      const result = await runner.run(
        {
          goal: "Follow the 'More information' link and reach the page it leads to.",
          url: `http://127.0.0.1:${port}/`,
          verify: [{ text: "Example Domains" }],
          maxSteps: 4,
        },
        { agentId: "jev-real-e2e", cwd: process.cwd(), workspaceId: WORKSPACE_ID },
      );
      expect(result.status).toBe("passed");
    } finally {
      pages.close();
    }
  }, 60_000);
});
