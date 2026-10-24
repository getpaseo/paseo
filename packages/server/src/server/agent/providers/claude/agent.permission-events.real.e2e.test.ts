import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { ClaudeAgentClient } from "./agent.js";
import { withTimeout } from "../../../../utils/promise-timeout.js";

// Explicit real-provider coverage, separate from the default unit suite.
test("answers a real plan approval synchronously from the permission subscriber", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-permission-event-"));
  const session = await new ClaudeAgentClient({ logger: pino({ level: "silent" }) }).createSession(
    { provider: "claude", cwd, model: "haiku", modeId: "plan" },
    undefined,
    { persistSession: false },
  );
  let requestName: string | undefined;
  let complete!: () => void;
  let fail!: (error: unknown) => void;
  const responded = new Promise<void>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  void responded.catch(() => undefined);
  session.subscribe((event) => {
    if (event.type === "permission_requested") {
      requestName = event.request.name;
      void session
        .respondToPermission(event.request.id, {
          behavior: "deny",
          message: "End verification here",
        })
        .then(complete, fail);
    }
    if (event.type === "turn_failed") fail(new Error(JSON.stringify(event)));
  });
  try {
    await session.startTurn(
      "Make a one-line plan to create hello.txt containing hello, then call ExitPlanMode now to request approval. Do not use other tools or ask questions.",
    );
    await expect(
      withTimeout(responded, 90_000, "No permission within 90 seconds"),
    ).resolves.toBeUndefined();
    expect(requestName).toBe("ExitPlanMode");
    expect(session.getPendingPermissions()).toEqual([]);
  } finally {
    await session.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);
