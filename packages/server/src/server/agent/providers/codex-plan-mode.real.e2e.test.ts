import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import {
  canRunRealProvider,
  createRealProviderClient,
  getRealProviderConfig,
} from "../../daemon-e2e/real-provider-test-config.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-plan-mode-real-"));
}

function waitForEvent<TEvent extends AgentStreamEvent>(params: {
  session: { subscribe(callback: (event: AgentStreamEvent) => void): () => void };
  predicate: (event: AgentStreamEvent) => event is TEvent;
  label: string;
  timeoutMs?: number;
}): Promise<TEvent> {
  return new Promise<TEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${params.label}`));
    }, params.timeoutMs ?? 120_000);
    const unsubscribe = params.session.subscribe((event) => {
      if (!params.predicate(event)) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

describe("Codex app-server provider (real) plan mode", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("codex");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("keeps implementation requests read-only with appended host instructions", async () => {
    const cwd = tmpCwd();
    const client = createRealProviderClient("codex", createTestLogger());
    const targetFileName = "implementation-sentinel.txt";
    const targetPath = path.join(cwd, targetFileName);
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    writeFileSync(path.join(cwd, "AGENTS.md"), "# Test fixture\n\nNo additional instructions.\n");
    execFileSync("git", ["add", "AGENTS.md"], { cwd, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Paseo Tests",
        "-c",
        "user.email=tests@paseo.invalid",
        "commit",
        "-m",
        "Initialize fixture",
      ],
      { cwd, stdio: "ignore" },
    );

    try {
      const session = await client.createSession({
        ...getRealProviderConfig("codex"),
        cwd,
        modeId: "auto",
        thinkingOptionId: "medium",
        daemonAppendSystemPrompt: "The host application is Paseo.",
      });

      try {
        await session.setFeature?.("plan_mode", true);
        const events: AgentStreamEvent[] = [];
        const unsubscribe = session.subscribe((event) => events.push(event));

        try {
          const planApproval = waitForEvent({
            session,
            label: "Codex plan approval",
            predicate: (
              event,
            ): event is Extract<AgentStreamEvent, { type: "permission_requested" }> =>
              event.type === "permission_requested" && event.request.kind === "plan",
          });
          const turnFinished = waitForEvent({
            session,
            label: "Codex plan turn completion",
            predicate: (
              event,
            ): event is Extract<
              AgentStreamEvent,
              { type: "turn_completed" | "turn_failed" | "turn_canceled" }
            > =>
              event.type === "turn_completed" ||
              event.type === "turn_failed" ||
              event.type === "turn_canceled",
          });

          await session.startTurn(
            `Create ${targetFileName} with a single line containing IMPLEMENTED. Do not inspect existing files or ask questions; complete the change now.`,
          );
          const [permission, terminal] = await Promise.all([planApproval, turnFinished]);

          expect(existsSync(targetPath)).toBe(false);
          expect(execFileSync("git", ["status", "--short"], { cwd, encoding: "utf8" }).trim()).toBe(
            "",
          );
          expect(terminal.type).toBe("turn_completed");
          expect(permission.request).toMatchObject({
            provider: "codex",
            name: "CodexPlanApproval",
            kind: "plan",
            input: {
              plan: expect.stringContaining(targetFileName),
            },
          });
          expect(events).not.toContainEqual(
            expect.objectContaining({
              type: "timeline",
              item: expect.objectContaining({ type: "todo" }),
            }),
          );
        } finally {
          unsubscribe();
        }
      } finally {
        await session.close();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 240_000);
});
