import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../../test-utils/index.js";
import { getFullAccessConfig } from "../../daemon-e2e/agent-configs.js";

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("codex agent commands E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  test("lists available slash commands for a codex agent", async () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = tmpDir("codex-home-");
    const promptsDir = path.join(codexHome, "prompts");
    const skillsDir = path.join(codexHome, "skills");
    mkdirSync(promptsDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      path.join(promptsDir, "hello.md"),
      ["---", "description: Test prompt", "argument-hint: NAME=<name>", "---", "", "Say hello to $NAME and then output exactly PASEO_OK.", ""].join("\n"),
      "utf8"
    );
    mkdirSync(path.join(skillsDir, "my-skill"), { recursive: true });
    writeFileSync(
      path.join(skillsDir, "my-skill", "SKILL.md"),
      ["---", "name: my-skill", "description: Test skill", "user-invocable: true", "---", "", "When invoked, respond with exactly PASEO_SKILL_OK.", ""].join("\n"),
      "utf8"
    );
    process.env.CODEX_HOME = codexHome;

    const agent = await ctx.client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd: "/tmp",
      title: "Codex Commands Test Agent",
    });

    expect(agent.id).toBeTruthy();
    expect(agent.provider).toBe("codex");
    expect(agent.status).toBe("idle");

    const result = await ctx.client.listCommands(agent.id);

    expect(result.error).toBeNull();
    expect(result.commands.length).toBeGreaterThan(0);

    for (const cmd of result.commands) {
      expect(cmd.name).toBeTruthy();
      expect(typeof cmd.description).toBe("string");
      expect(typeof cmd.argumentHint).toBe("string");
      expect(cmd.name.startsWith("/")).toBe(false);
    }

    const names = result.commands.map((c) => c.name);
    expect(names).toContain("my-skill");
    expect(names).toContain("prompts:hello");

    if (prevCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prevCodexHome;
    }
    rmSync(codexHome, { recursive: true, force: true });
  }, 30_000);

  test("executes a custom prompt command (prompts:*)", async () => {
    const codexHome = process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "/tmp", ".codex");

    const promptsDir = path.join(codexHome, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    const promptPath = path.join(promptsDir, "paseo-test-sayok.md");
    writeFileSync(
      promptPath,
      ["---", "description: Say OK", "argument-hint: NAME=<name>", "---", "", "Output exactly: PASEO_OK $NAME", ""].join("\n"),
      "utf8"
    );

    const agent = await ctx.client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd: "/tmp",
      title: "Codex Prompt Execute Test Agent",
    });

    const result = await ctx.client.executeCommand(
      agent.id,
      "prompts:paseo-test-sayok",
      "NAME=world"
    );
    expect(result.error).toBeNull();
    expect(result.result?.text).toContain("PASEO_OK");

    rmSync(promptPath, { force: true });
  }, 30_000);

  test("sendMessage routes known slash commands through executeCommand", async () => {
    const prevCodexHome = process.env.CODEX_HOME;
    const codexHome = tmpDir("codex-home-send-command-");
    const promptsDir = path.join(codexHome, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      path.join(promptsDir, "paseo-test-sayok.md"),
      ["---", "description: Say OK", "---", "", "Output exactly: PASEO_OK", ""].join("\n"),
      "utf8"
    );
    process.env.CODEX_HOME = codexHome;

    try {
      const agent = await ctx.client.createAgent({
        ...getFullAccessConfig("codex"),
        cwd: "/tmp",
        title: "Codex Command Route Test",
      });

      await ctx.client.sendMessage(agent.id, "/prompts:paseo-test-sayok NAME=world");
      const state = await ctx.client.waitForFinish(agent.id, 30_000);

      expect(state.status).toBe("idle");
      expect(state.lastMessage).toContain("PASEO_OK paseo-test-sayok");
    } finally {
      if (prevCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = prevCodexHome;
      }
      rmSync(codexHome, { recursive: true, force: true });
    }
  }, 30_000);

  test("sendMessage keeps unknown slash input as plain prompt text", async () => {
    const agent = await ctx.client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd: "/tmp",
      title: "Codex Slash Fallback",
    });

    const token = `RAW_PROMPT_TOKEN_${Date.now()}`;
    await ctx.client.sendMessage(
      agent.id,
      `/not-a-real-command respond with exactly: ${token}`
    );
    const state = await ctx.client.waitForFinish(agent.id, 30_000);

    expect(state.status).toBe("idle");
    expect(state.lastMessage).toContain(token);
    expect(state.lastMessage).not.toContain("PASEO_SKILL_OK");
  }, 30_000);

  test("returns error for non-existent agent", async () => {
    const result = await ctx.client.listCommands("non-existent-agent-id");

    expect(result.error).toBeTruthy();
    expect(result.error).toContain("Agent not found");
    expect(result.commands).toEqual([]);
  }, 30000);
});
