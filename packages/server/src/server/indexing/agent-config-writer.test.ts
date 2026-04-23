import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  HUBCODE_INDEXING_KEY,
  removeHubcodeMcpEntries,
  writeHubcodeMcpEntries,
} from "./agent-config-writer.js";

const HUBCODE_URL = "http://127.0.0.1:6767/mcp/agents";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(os.tmpdir(), "hubcode-cfg-"));
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(p, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

describe("writeHubcodeMcpEntries", () => {
  it("creates a fresh config with the hubcode-indexing entry for claude-code", async () => {
    const results = await writeHubcodeMcpEntries({
      hubcodeMcpUrl: HUBCODE_URL,
      agentIds: ["claude-code"],
      home: tmpHome,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("written");
    const cfg = await readJson(path.join(tmpHome, ".claude.json"));
    expect(cfg?.mcpServers).toMatchObject({
      [HUBCODE_INDEXING_KEY]: { type: "http", url: HUBCODE_URL },
    });
  });

  it("preserves existing entries when merging", async () => {
    const cfgPath = path.join(tmpHome, ".claude.json");
    await writeFile(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          "user-mcp": { type: "http", url: "https://user.example/mcp" },
        },
        otherKey: "kept",
      }),
    );
    await writeHubcodeMcpEntries({
      hubcodeMcpUrl: HUBCODE_URL,
      agentIds: ["claude-code"],
      home: tmpHome,
    });
    const cfg = await readJson(cfgPath);
    expect(cfg?.otherKey).toBe("kept");
    const servers = cfg?.mcpServers as Record<string, unknown>;
    expect(servers["user-mcp"]).toEqual({ type: "http", url: "https://user.example/mcp" });
    expect(servers[HUBCODE_INDEXING_KEY]).toEqual({ type: "http", url: HUBCODE_URL });
  });

  it("uses {url} shape for cursor (no type field)", async () => {
    await writeHubcodeMcpEntries({
      hubcodeMcpUrl: HUBCODE_URL,
      agentIds: ["cursor"],
      home: tmpHome,
    });
    const cfg = await readJson(path.join(tmpHome, ".cursor", "mcp.json"));
    const servers = cfg?.mcpServers as Record<string, unknown>;
    expect(servers[HUBCODE_INDEXING_KEY]).toEqual({ url: HUBCODE_URL });
  });

  it("returns unsupported for codex (TOML stdio-only)", async () => {
    const results = await writeHubcodeMcpEntries({
      hubcodeMcpUrl: HUBCODE_URL,
      agentIds: ["codex"],
      home: tmpHome,
    });
    expect(results[0]?.status).toBe("unsupported");
    expect(results[0]?.reason).toMatch(/HTTP/);
  });

  it("creates parent directories on first write", async () => {
    await writeHubcodeMcpEntries({
      hubcodeMcpUrl: HUBCODE_URL,
      agentIds: ["opencode"],
      home: tmpHome,
    });
    const cfgPath = path.join(tmpHome, ".config", "opencode", "opencode.json");
    const cfg = await readJson(cfgPath);
    expect(cfg).not.toBeNull();
  });

  it("is idempotent — second write yields the same content", async () => {
    await writeHubcodeMcpEntries({
      hubcodeMcpUrl: HUBCODE_URL,
      agentIds: ["claude-code"],
      home: tmpHome,
    });
    const first = await readFile(path.join(tmpHome, ".claude.json"), "utf8");
    await writeHubcodeMcpEntries({
      hubcodeMcpUrl: HUBCODE_URL,
      agentIds: ["claude-code"],
      home: tmpHome,
    });
    const second = await readFile(path.join(tmpHome, ".claude.json"), "utf8");
    expect(second).toBe(first);
  });

  it("when no agentIds are passed, attempts every MCP-capable agent", async () => {
    const results = await writeHubcodeMcpEntries({
      hubcodeMcpUrl: HUBCODE_URL,
      home: tmpHome,
    });
    // Several agents support http, codex doesn't
    const written = results.filter((r) => r.status === "written");
    const unsupported = results.filter((r) => r.status === "unsupported");
    expect(written.length).toBeGreaterThan(0);
    expect(unsupported.some((r) => r.agentId === "codex")).toBe(true);
  });
});

describe("removeHubcodeMcpEntries", () => {
  it("removes the entry but preserves other entries and keys", async () => {
    const cfgPath = path.join(tmpHome, ".claude.json");
    await mkdir(tmpHome, { recursive: true });
    await writeFile(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          [HUBCODE_INDEXING_KEY]: { type: "http", url: HUBCODE_URL },
          "user-mcp": { type: "http", url: "https://user.example/mcp" },
        },
        otherKey: "kept",
      }),
    );
    const results = await removeHubcodeMcpEntries({
      agentIds: ["claude-code"],
      home: tmpHome,
    });
    expect(results[0]?.status).toBe("removed");
    const cfg = await readJson(cfgPath);
    expect(cfg?.otherKey).toBe("kept");
    const servers = cfg?.mcpServers as Record<string, unknown>;
    expect(HUBCODE_INDEXING_KEY in servers).toBe(false);
    expect(servers["user-mcp"]).toBeDefined();
  });

  it("returns skipped when the entry is not present", async () => {
    const cfgPath = path.join(tmpHome, ".claude.json");
    await writeFile(cfgPath, JSON.stringify({ mcpServers: {} }));
    const results = await removeHubcodeMcpEntries({
      agentIds: ["claude-code"],
      home: tmpHome,
    });
    expect(results[0]?.status).toBe("skipped");
  });

  it("returns skipped when the config does not exist at all", async () => {
    const results = await removeHubcodeMcpEntries({
      agentIds: ["claude-code"],
      home: tmpHome,
    });
    expect(results[0]?.status).toBe("skipped");
  });
});
