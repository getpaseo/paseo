import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { BUILTIN_RULE_IDS, buildBuiltinRules } from "./builtins.js";
import { RuleRegistry } from "./registry.js";
import type { HubcodeRule } from "./types.js";

describe("RuleRegistry", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "hubcode-rules-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const newRegistry = () => new RuleRegistry({ logger: createTestLogger(), hubcodeHome: home });

  it("seeds builtins as enabled", async () => {
    const reg = newRegistry();
    await reg.load();
    expect(reg.list().length).toBeGreaterThanOrEqual(buildBuiltinRules().length);
    for (const id of BUILTIN_RULE_IDS) {
      expect(reg.get(id)?.state.enabled).toBe(true);
    }
  });

  it("rejects overwriting a builtin", async () => {
    const reg = newRegistry();
    await reg.load();
    const id = [...BUILTIN_RULE_IDS][0]!;
    await expect(
      reg.upsertUserRule({
        id,
        title: "x",
        body: "y",
        author: "user",
        scope: "global",
      } satisfies HubcodeRule),
    ).rejects.toThrow(/built-in/);
  });

  it("round-trips a user rule across reload", async () => {
    const reg = newRegistry();
    await reg.load();
    await reg.upsertUserRule({
      id: "user.r1",
      title: "Mine",
      body: "Do stuff.",
      author: "user",
      scope: "global",
    });

    const reg2 = newRegistry();
    await reg2.load();
    expect(reg2.get("user.r1")?.definition.title).toBe("Mine");
  });
});
