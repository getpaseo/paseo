import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { findAgentSessionJumpInArgv, resolveAgentSessionJump } from "./agent-session-jump.js";

async function writeAgent(
  home: string,
  id: string,
  sessionId: string,
  cwd = "/work",
): Promise<void> {
  await mkdir(path.join(home, "agents"), { recursive: true });
  await writeFile(
    path.join(home, "agents", `${id}.json`),
    JSON.stringify({
      id,
      provider: "codex",
      cwd,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      config: null,
      persistence: { provider: "codex", sessionId },
    }),
  );
}

describe("agent session jumps", () => {
  it("resolves a prefixed Codex session without using cwd as an identifier", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-session-jump-"));
    await writeFile(path.join(home, "server-id"), "server-1\n");
    await writeAgent(home, "agent-1", "session-1");
    await writeAgent(home, "agent-2", "other-session");

    await expect(
      resolveAgentSessionJump("paseo-local://focus?session=codex-session-1&cwd=%2Fwork", {
        paseoHome: home,
      }),
    ).resolves.toEqual({ serverId: "server-1", agentId: "agent-1" });
    await expect(
      resolveAgentSessionJump("paseo-local://focus?session=unknown&cwd=%2Fwork", {
        paseoHome: home,
      }),
    ).resolves.toBeNull();
  });

  it("rejects ambiguous matches and finds a jump in Electron arguments", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "paseo-session-jump-"));
    await writeFile(path.join(home, "server-id"), "server-1\n");
    await writeAgent(home, "agent-1", "same");
    await writeAgent(home, "agent-2", "same", "/other");

    expect(findAgentSessionJumpInArgv(["Electron", "paseo-local://focus?session=same"])).toBe(
      "paseo-local://focus?session=same",
    );
    await expect(
      resolveAgentSessionJump("paseo-local://focus?session=same", { paseoHome: home }),
    ).resolves.toBeNull();
  });
});
