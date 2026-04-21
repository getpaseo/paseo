import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncLibraryToTargets, defaultSyncPaths } from "./sync-writers.js";
import type { MaterializedMcpEntry, MaterializedSkillEntry } from "./types.js";

async function makeTmp(): Promise<{
  hubcodeHome: string;
  fakeHome: string;
  paths: ReturnType<typeof defaultSyncPaths>;
  claudeConfig: string;
  codexConfig: string;
  opencodeConfig: string;
}> {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "hub-sync-"));
  const hubcodeHome = path.join(fakeHome, ".hubcode");
  await mkdir(hubcodeHome, { recursive: true });
  const paths = defaultSyncPaths(fakeHome);
  return {
    hubcodeHome,
    fakeHome,
    paths,
    claudeConfig: paths.agentConfigPaths["claude-code"]!,
    codexConfig: paths.agentConfigPaths.codex!,
    opencodeConfig: paths.agentConfigPaths.opencode!,
  };
}

const stdioEntry: MaterializedMcpEntry = {
  id: "id-1",
  name: "playwright",
  payload: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    env: { TOKEN: "abc" },
  },
  syncTargets: ["claude-code", "codex", "opencode"],
};

const httpEntry: MaterializedMcpEntry = {
  id: "id-2",
  name: "remote-thing",
  payload: {
    transport: "http",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer t" },
  },
  syncTargets: ["claude-code", "codex", "opencode"],
};

const skill: MaterializedSkillEntry = {
  id: "skill-1",
  name: "release-notes",
  displayName: "Release Notes",
  description: "Generate clean release notes.",
  payload: { instructionsInline: "# Release notes\n\nDo the thing." },
  syncTargets: ["claude-code"],
};

describe("syncLibraryToTargets", () => {
  let ctx: Awaited<ReturnType<typeof makeTmp>>;
  beforeEach(async () => {
    ctx = await makeTmp();
  });

  it("writes claude.json with both stdio + http entries", async () => {
    await syncLibraryToTargets({
      hubcodeHome: ctx.hubcodeHome,
      paths: ctx.paths,
      mcps: [stdioEntry, httpEntry],
      skills: [],
    });
    const json = JSON.parse(await readFile(ctx.claudeConfig, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(json.mcpServers.playwright).toMatchObject({
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
      env: { TOKEN: "abc" },
    });
    expect(json.mcpServers["remote-thing"]).toMatchObject({
      type: "http",
      url: "https://mcp.example.com/mcp",
    });
  });

  it("writes codex config.toml with stdio entries only", async () => {
    await syncLibraryToTargets({
      hubcodeHome: ctx.hubcodeHome,
      paths: ctx.paths,
      mcps: [stdioEntry, httpEntry],
      skills: [],
    });
    const toml = await readFile(ctx.codexConfig, "utf-8");
    expect(toml).toContain("[mcp_servers.playwright]");
    expect(toml).toContain('command = "npx"');
    expect(toml).not.toContain("remote-thing");
  });

  it("writes opencode.json with array-form command for stdio", async () => {
    await syncLibraryToTargets({
      hubcodeHome: ctx.hubcodeHome,
      paths: ctx.paths,
      mcps: [stdioEntry],
      skills: [],
    });
    const json = JSON.parse(await readFile(ctx.opencodeConfig, "utf-8")) as {
      mcp: Record<string, { type: string; command: string[] }>;
    };
    expect(json.mcp.playwright).toMatchObject({
      type: "local",
      command: ["npx", "-y", "@playwright/mcp@latest"],
    });
  });

  it("writes ~/.claude/skills/<name>/SKILL.md", async () => {
    await syncLibraryToTargets({
      hubcodeHome: ctx.hubcodeHome,
      paths: ctx.paths,
      mcps: [],
      skills: [skill],
    });
    const body = await readFile(
      path.join(ctx.paths.skillsDir, "release-notes", "SKILL.md"),
      "utf-8",
    );
    expect(body).toContain("# Release notes");
  });

  it("removes entries on the next sync that are no longer present", async () => {
    await syncLibraryToTargets({
      hubcodeHome: ctx.hubcodeHome,
      paths: ctx.paths,
      mcps: [stdioEntry],
      skills: [skill],
    });
    await syncLibraryToTargets({
      hubcodeHome: ctx.hubcodeHome,
      paths: ctx.paths,
      mcps: [],
      skills: [],
    });
    const claude = JSON.parse(await readFile(ctx.claudeConfig, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(claude.mcpServers.playwright).toBeUndefined();
    const codex = await readFile(ctx.codexConfig, "utf-8");
    expect(codex).not.toContain("[mcp_servers.playwright]");
    await expect(
      readFile(path.join(ctx.paths.skillsDir, "release-notes", "SKILL.md"), "utf-8"),
    ).rejects.toThrow();
  });

  it("preserves user-managed mcp entries during sync", async () => {
    // Simulate an existing user-managed claude.json
    await writeFile(
      ctx.claudeConfig,
      JSON.stringify({
        mcpServers: { "user-thing": { command: "user-cmd" } },
        otherSetting: 42,
      }),
    );
    // Same for codex
    await mkdir(path.dirname(ctx.codexConfig), { recursive: true });
    await writeFile(
      ctx.codexConfig,
      '[mcp_servers.user-thing]\ncommand = "user-cmd"\n',
    );

    await syncLibraryToTargets({
      hubcodeHome: ctx.hubcodeHome,
      paths: ctx.paths,
      mcps: [stdioEntry],
      skills: [],
    });

    const claude = JSON.parse(await readFile(ctx.claudeConfig, "utf-8")) as {
      mcpServers: Record<string, unknown>;
      otherSetting: number;
    };
    expect(claude.mcpServers["user-thing"]).toMatchObject({ command: "user-cmd" });
    expect(claude.mcpServers.playwright).toMatchObject({ command: "npx" });
    expect(claude.otherSetting).toBe(42);

    const codex = await readFile(ctx.codexConfig, "utf-8");
    expect(codex).toContain("[mcp_servers.user-thing]");
    expect(codex).toContain("[mcp_servers.playwright]");
  });

  afterEach(async () => {
    await rm(ctx.fakeHome, { recursive: true, force: true });
  });
});

