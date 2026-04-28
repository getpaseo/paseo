import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { BUILTIN_COMMAND_IDS, buildBuiltinCommands } from "./builtins.js";
import { CommandRegistry } from "./registry.js";
import type { HubcodeCommand } from "./types.js";

describe("CommandRegistry", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "hubcode-commands-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const newRegistry = () => new CommandRegistry({ logger: createTestLogger(), hubcodeHome: home });

  it("seeds builtins as enabled on first load", async () => {
    const reg = newRegistry();
    await reg.load();
    const list = reg.list();
    for (const id of BUILTIN_COMMAND_IDS) {
      const entry = list.find((e) => e.definition.id === id);
      expect(entry, `builtin ${id} should exist`).toBeDefined();
      expect(entry?.state.enabled).toBe(true);
    }
    expect(list.length).toBeGreaterThanOrEqual(buildBuiltinCommands().length);
  });

  it("preserves an explicit disable across reload", async () => {
    const reg = newRegistry();
    await reg.load();
    const id = [...BUILTIN_COMMAND_IDS][0]!;
    await reg.setEnabled(id, false);

    const reg2 = newRegistry();
    await reg2.load();
    expect(reg2.get(id)?.state.enabled).toBe(false);
  });

  it("upserts and lists a user command", async () => {
    const reg = newRegistry();
    await reg.load();
    const cmd: HubcodeCommand = {
      id: "user.my-cmd",
      name: "my-cmd",
      description: "test",
      prompt: "body",
      author: "user",
      scope: "global",
    };
    await reg.upsertUserCommand(cmd);

    const got = reg.get("user.my-cmd");
    expect(got).not.toBeNull();
    expect(got?.state.enabled).toBe(true);

    // Persists on disk.
    const onDisk = await readFile(
      path.join(home, "commands", "definitions", "user.my-cmd.json"),
      "utf8",
    );
    expect(JSON.parse(onDisk).name).toBe("my-cmd");
  });

  it("rejects overwriting a builtin", async () => {
    const reg = newRegistry();
    await reg.load();
    const builtinId = [...BUILTIN_COMMAND_IDS][0]!;
    await expect(
      reg.upsertUserCommand({
        id: builtinId,
        name: "x",
        description: "",
        prompt: "body",
        author: "user",
        scope: "global",
      }),
    ).rejects.toThrow(/built-in/);
  });

  it("deletes only user commands", async () => {
    const reg = newRegistry();
    await reg.load();
    const builtinId = [...BUILTIN_COMMAND_IDS][0]!;
    await expect(reg.deleteUserCommand(builtinId)).rejects.toThrow(/built-in/);

    await reg.upsertUserCommand({
      id: "user.temp",
      name: "temp",
      description: "",
      prompt: "body",
      author: "user",
      scope: "global",
    });
    await reg.deleteUserCommand("user.temp");
    expect(reg.get("user.temp")).toBeNull();
  });

  it("skips malformed definitions on load", async () => {
    const dir = path.join(home, "commands", "definitions");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "bad.json"), "{not valid}", "utf8");

    const reg = newRegistry();
    await expect(reg.load()).resolves.toBeUndefined();
    // Builtins still loaded.
    expect(reg.list().length).toBeGreaterThan(0);
  });

  it("emits change events on upsert/toggle/delete", async () => {
    const reg = newRegistry();
    await reg.load();
    const events: string[] = [];
    reg.onChange((e) => events.push(e.id));

    await reg.upsertUserCommand({
      id: "user.evt",
      name: "evt",
      description: "",
      prompt: "body",
      author: "user",
      scope: "global",
    });
    const builtinId = [...BUILTIN_COMMAND_IDS][0]!;
    await reg.setEnabled(builtinId, false);
    await reg.deleteUserCommand("user.evt");

    expect(events).toEqual(["user.evt", builtinId, "user.evt"]);
  });
});
