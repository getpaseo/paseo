import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentSession } from "../agent-sdk-types.js";
import { OpenCodeV2AgentClient } from "./opencode/v2/agent.js";
import {
  OPENCODE_V2_COMMAND,
  SCRIPTED_MODEL,
  ScriptedOpenCodeService,
  scriptedCall,
} from "./opencode/test-utils/v2-scripted-server.js";

interface Fixture {
  root: string;
  service: ScriptedOpenCodeService;
  client: OpenCodeV2AgentClient;
}

let fixture: Fixture | undefined;

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-opencode-v2-pending-approval-"));
  const service = await ScriptedOpenCodeService.start();
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    settings: {
      command: { mode: "replace", argv: [OPENCODE_V2_COMMAND] },
      env: service.ownedEnvironment,
    },
  });
  fixture = { root, service, client };
}, 60_000);

afterEach(async () => {
  if (!fixture) return;
  await fixture.client.shutdown();
  await fixture.service.stop();
  await rm(fixture.root, { recursive: true, force: true });
  fixture = undefined;
}, 60_000);

/** Starts a shell call that OpenCode holds for approval, and waits until Paseo lists it. */
async function startApprovalTurn(): Promise<{
  session: AgentSession;
  turnId: string;
  requestId: string;
}> {
  const project = path.join(fixture!.root, "project");
  await mkdir(project, { recursive: true });
  const session = await fixture!.client.createSession(
    {
      provider: "opencode",
      cwd: project,
      model: SCRIPTED_MODEL,
      providerOptions: { permission: { bash: "ask" } },
    },
    undefined,
    { persistSession: false },
  );
  const { turnId } = await session.startTurn(
    scriptedCall("shell", { command: "printf PASEO_PROBE", description: "Probe" }),
  );
  await expect.poll(() => session.getPendingPermissions().length, { timeout: 30_000 }).toBe(1);
  return { session, turnId, requestId: session.getPendingPermissions()[0].id };
}

test("a message sent while an approval is open clears the approval", async () => {
  const { session, turnId } = await startApprovalTurn();
  await expect(
    session.steerActiveTurn!("Never mind, reply OK.", {
      expectedTurnId: turnId,
      clearPendingPermissions: true,
    }),
  ).resolves.toEqual({ status: "accepted" });
  expect(session.getPendingPermissions()).toEqual([]);
}, 120_000);

// OpenCode drops the approval of an interrupted tool call without a reply event.
test("stopping while an approval is open clears the approval", async () => {
  const { session, requestId } = await startApprovalTurn();
  await session.interrupt();
  await expect.poll(() => session.getPendingPermissions(), { timeout: 10_000 }).toEqual([]);
  // A client that still shows the card can answer it without an error.
  await expect(session.respondToPermission(requestId, { behavior: "deny" })).resolves.toBe(
    undefined,
  );
}, 120_000);
