// Unit tests for claude-code-binary.
//
// We can exercise getClaudeCodeStatus() and the idempotency branch of
// ensureClaudeCode() without touching the network or running npm: those
// paths only do filesystem inspection. Download + extraction + npm spawn
// are integration concerns covered by manual smoke tests.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeUserData = mkdtempSync(path.join(tmpdir(), "hubcode-userdata-"));

// Mock electron BEFORE importing the module under test. Vitest's hoisting
// makes vi.mock() run before the dynamic import below.
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === "userData") return fakeUserData;
      throw new Error(`unexpected getPath: ${name}`);
    }),
  },
}));

vi.mock("electron-log/main", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

const PINNED_VERSION = "2.1.119";

interface ClaudeCodeBinaryModule {
  getClaudeCodeStatus: () => Promise<{
    installed: boolean;
    pinnedVersion: string;
    installedVersion: string | null;
    claudeBinary: string;
    nodeBinary: string | null;
  }>;
  getClaudeHomeDir: () => string;
}

let mod: ClaudeCodeBinaryModule;

beforeEach(async () => {
  vi.resetModules();
  mod = (await import("./claude-code-binary")) as unknown as ClaudeCodeBinaryModule;
});

afterEach(() => {
  // Reset state between tests so each one starts from an empty userData.
  rmSync(path.join(fakeUserData, "runtime"), { recursive: true, force: true });
  rmSync(path.join(fakeUserData, "claude"), { recursive: true, force: true });
  rmSync(path.join(fakeUserData, "claude-home"), { recursive: true, force: true });
});

describe("getClaudeCodeStatus()", () => {
  it("reports installed=false when nothing has been provisioned yet", async () => {
    const status = await mod.getClaudeCodeStatus();
    expect(status.installed).toBe(false);
    expect(status.installedVersion).toBeNull();
    expect(status.pinnedVersion).toBe(PINNED_VERSION);
    expect(status.nodeBinary).toBeNull();
  });

  it("reports installed=false when only the Node runtime exists (no claude-code)", async () => {
    // Simulate a partial install: Node binary exists but claude-code does not.
    const nodeDir = path.join(fakeUserData, "runtime", "node-v22.11.0", "bin");
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(path.join(nodeDir, "node"), "");
    const status = await mod.getClaudeCodeStatus();
    expect(status.installed).toBe(false);
    expect(status.installedVersion).toBeNull();
  });

  it("reports installed=false when claude-code is present but version mismatches the pin", async () => {
    primeClaudeCodeAtVersion("99.0.0");
    primeNodeBinary();
    const status = await mod.getClaudeCodeStatus();
    expect(status.installed).toBe(false);
    expect(status.installedVersion).toBe("99.0.0");
  });

  it("reports installed=true when version matches and node binary exists", async () => {
    primeClaudeCodeAtVersion(PINNED_VERSION);
    primeNodeBinary();
    const status = await mod.getClaudeCodeStatus();
    expect(status.installed).toBe(true);
    expect(status.installedVersion).toBe(PINNED_VERSION);
    expect(status.claudeBinary).toContain("claude");
    expect(status.nodeBinary).toContain("node");
  });
});

describe("getClaudeHomeDir()", () => {
  it("points to an isolated CLAUDE_HOME inside userData", () => {
    const dir = mod.getClaudeHomeDir();
    expect(dir).toBe(path.join(fakeUserData, "claude-home"));
  });
});

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function primeClaudeCodeAtVersion(version: string) {
  const pkgDir = path.join(fakeUserData, "claude", "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "@anthropic-ai/claude-code", version }),
    "utf8",
  );
  // The status check also probes for the executable shim under .bin/.
  const binDir = path.join(fakeUserData, "claude", "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env node\n");
}

function primeNodeBinary() {
  const isWindows = process.platform === "win32";
  const nodeDir = path.join(fakeUserData, "runtime", "node-v22.11.0", isWindows ? "" : "bin");
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(path.join(nodeDir, isWindows ? "node.exe" : "node"), "");
}
