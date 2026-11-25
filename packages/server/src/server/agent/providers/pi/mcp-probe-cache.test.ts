import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  cachedPiMcpSupport,
  clearPiMcpSupportCache,
  PI_MCP_NONE_TTL_MS,
  piMcpProbeKey,
  type PiMcpProbeInput,
  type PiMcpProbeResult,
} from "./mcp-probe-cache.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pi-mcp-cache-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), "{}");
  const input = (env: Record<string, string> = {}): PiMcpProbeInput => ({
    cwd,
    env: { PI_CODING_AGENT_DIR: agentDir, ...env },
    command: undefined,
    defaultCommand: "pi",
  });
  return { cwd, input };
}

describe("cachedPiMcpSupport", () => {
  beforeEach(() => clearPiMcpSupportCache());

  test("one probe serves agents that differ only by Paseo identity env", async () => {
    const { input } = setup();
    const probe = vi.fn(async (): Promise<PiMcpProbeResult> => ({ support: "builtin", ok: true }));
    for (const id of ["a", "b", "c"]) {
      expect(await cachedPiMcpSupport(input({ PASEO_AGENT_ID: id }), probe)).toBe("builtin");
    }
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test("whether an identity variable is set stays in the identity", () => {
    const { input } = setup();
    expect(piMcpProbeKey(input({ PASEO_WORKSPACE_ID: "w1" }))).not.toBe(piMcpProbeKey(input()));
    expect(piMcpProbeKey(input({ PASEO_WORKSPACE_ID: "w1" }))).toBe(
      piMcpProbeKey(input({ PASEO_WORKSPACE_ID: "w2" })),
    );
  });

  test("other env and launch command are part of the identity", async () => {
    const { input } = setup();
    const probe = vi.fn(async (): Promise<PiMcpProbeResult> => ({ support: "adapter", ok: true }));
    await cachedPiMcpSupport(input(), probe);
    await cachedPiMcpSupport(input({ PI_ROLE: "reviewer" }), probe);
    await cachedPiMcpSupport(
      { ...input(), command: { mode: "append", args: ["-e", "x.ts"] } },
      probe,
    );
    expect(probe).toHaveBeenCalledTimes(3);
  });

  test("failed and throwing probes are not cached", async () => {
    const { input } = setup();
    const failed = vi.fn(async (): Promise<PiMcpProbeResult> => ({ support: null, ok: false }));
    await cachedPiMcpSupport(input(), failed);
    await cachedPiMcpSupport(input(), failed);
    expect(failed).toHaveBeenCalledTimes(2);
    const boom = vi.fn(async (): Promise<PiMcpProbeResult> => {
      throw new Error("spawn failed");
    });
    await expect(cachedPiMcpSupport(input(), boom)).rejects.toThrow("spawn failed");
    await expect(cachedPiMcpSupport(input(), boom)).rejects.toThrow("spawn failed");
    expect(boom).toHaveBeenCalledTimes(2);
  });

  test("a confirmed null expires and a settings change forces a new probe", async () => {
    const { cwd, input } = setup();
    let now = 1_000;
    const probe = vi.fn(async (): Promise<PiMcpProbeResult> => ({ support: null, ok: true }));
    await cachedPiMcpSupport(input(), probe, () => now);
    await cachedPiMcpSupport(input(), probe, () => now);
    expect(probe).toHaveBeenCalledTimes(1);
    now += PI_MCP_NONE_TTL_MS + 1;
    await cachedPiMcpSupport(input(), probe, () => now);
    expect(probe).toHaveBeenCalledTimes(2);
    writeFileSync(join(cwd, ".pi", "settings.json"), '{"packages":[]}');
    await cachedPiMcpSupport(input(), probe, () => now);
    expect(probe).toHaveBeenCalledTimes(3);
  });
});
