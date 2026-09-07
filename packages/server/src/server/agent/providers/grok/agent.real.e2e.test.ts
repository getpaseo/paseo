import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { GrokACPAgentClient } from "./agent.js";
import type { AgentSession } from "../../agent-sdk-types.js";

test("real Grok exposes controls and applies selections on create, switch, and resume", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-grok-controls-"));
  const client = new GrokACPAgentClient({
    logger: pino({ level: "silent" }),
    command: ["grok", "--no-auto-update", "agent", "stdio"],
    providerId: "grok",
  });
  let session: AgentSession | null = null;
  try {
    const catalog = await client.fetchCatalog({ scope: "cwd", cwd });
    expect(
      catalog.models
        .find((model) => model.id === "grok-4.6")
        ?.thinkingOptions?.map((option) => option.id),
    ).toEqual(["xhigh", "high", "medium", "low"]);
    expect(
      catalog.models
        .find((model) => model.id === "grok-4.5")
        ?.thinkingOptions?.map((option) => option.id),
    ).toEqual(["high", "medium", "low"]);
    expect(catalog.modes.map((mode) => mode.id)).toEqual(["ask", "auto", "always-approve"]);
    expect(await client.listFeatures({ provider: "acp", cwd })).toEqual([]);
    session = await client.createSession({
      provider: "acp",
      cwd,
      model: "grok-4.5",
      thinkingOptionId: "low",
      modeId: "ask",
      featureValues: { auto_accept: true },
    });
    expect(session.features).toEqual([]);
    expect(await session.getCurrentMode()).toBe("ask");
    expect(await session.getRuntimeInfo()).toMatchObject({
      model: "grok-4.5",
      thinkingOptionId: "low",
    });
    await session.setModel("grok-4.6");
    expect(await session.getRuntimeInfo()).toMatchObject({
      model: "grok-4.6",
      thinkingOptionId: "low",
    });
    await session.setThinkingOption("xhigh");
    await session.setModel("grok-4.5");
    expect(await session.getRuntimeInfo()).toMatchObject({
      model: "grok-4.5",
      thinkingOptionId: "high",
    });
    await expect(session.setThinkingOption("xhigh")).rejects.toThrow("Grok cannot select effort");
    expect(await session.getRuntimeInfo()).toMatchObject({
      model: "grok-4.5",
      thinkingOptionId: "high",
    });
    await session.setMode("auto");
    expect(await session.getCurrentMode()).toBe("auto");
    await session.setMode("always-approve");
    expect(await session.getCurrentMode()).toBe("always-approve");
    await expect(session.setMode("plan")).rejects.toThrow("Grok cannot select permission");
    expect(await session.getCurrentMode()).toBe("always-approve");
    await session.setThinkingOption("low");
    const handle = session.describePersistence();
    assert(handle);
    await session.close();
    session = await client.resumeSession(handle);
    expect(await session.getCurrentMode()).toBe("always-approve");
    expect(await session.getRuntimeInfo()).toMatchObject({
      model: "grok-4.5",
      thinkingOptionId: "low",
    });
    await session.setThinkingOption(null);
    expect(await session.getRuntimeInfo()).toMatchObject({ thinkingOptionId: null });
    const clearedHandle = session.describePersistence();
    assert(clearedHandle);
    expect(clearedHandle.metadata?.thinkingOptionId).toBeUndefined();
    await session.close();
    session = await client.resumeSession(clearedHandle);
    expect(await session.getRuntimeInfo()).toMatchObject({
      model: "grok-4.5",
      thinkingOptionId: "high",
    });
    await session.setMode("ask");
    expect(await session.getCurrentMode()).toBe("ask");
    await session.close();
    session = await client.createSession({ provider: "acp", cwd });
    expect(await session.getCurrentMode()).toBe("ask");
    await session.close();
    session = await client.createSession({
      provider: "acp",
      cwd,
      featureValues: { auto_accept: true },
    });
    expect(await session.getCurrentMode()).toBe("always-approve");
  } finally {
    await session?.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);
