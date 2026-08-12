import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_MCP_AUTH_TOKEN_FILENAME,
  getOrCreateAgentMcpAuthToken,
} from "./agent-mcp-auth-token.js";
import { PRIVATE_FILE_MODE } from "./private-files.js";

const MODE_MASK = 0o777;
const PERMISSIVE_FILE_MODE = 0o644;

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "paseo-agent-mcp-auth-token-"));
}

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

describe("getOrCreateAgentMcpAuthToken", () => {
  let home: string;

  beforeEach(() => {
    home = tmpHome();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates and reuses a stable token per PASEO_HOME", () => {
    const first = getOrCreateAgentMcpAuthToken(home);
    const second = getOrCreateAgentMcpAuthToken(home);
    expect(first).toBe(second);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const tokenPath = path.join(home, AGENT_MCP_AUTH_TOKEN_FILENAME);
    expect(existsSync(tokenPath)).toBe(true);
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(first);
  });

  it("regenerates when the persisted value is not a UUID", () => {
    const tokenPath = path.join(home, AGENT_MCP_AUTH_TOKEN_FILENAME);
    writeFileSync(tokenPath, "not-a-token\n", { mode: PRIVATE_FILE_MODE });

    const token = getOrCreateAgentMcpAuthToken(home);
    expect(token).not.toBe("not-a-token");
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(token);
  });

  describe.skipIf(process.platform === "win32")("file permissions", () => {
    it("creates the token file with private permissions", () => {
      getOrCreateAgentMcpAuthToken(home);
      expect(modeOf(path.join(home, AGENT_MCP_AUTH_TOKEN_FILENAME))).toBe(PRIVATE_FILE_MODE);
    });

    it("repairs existing token file permissions when loading", () => {
      const tokenPath = path.join(home, AGENT_MCP_AUTH_TOKEN_FILENAME);
      const existing = "11111111-1111-4111-8111-111111111111";
      writeFileSync(tokenPath, `${existing}\n`, { mode: PERMISSIVE_FILE_MODE });
      chmodSync(tokenPath, PERMISSIVE_FILE_MODE);

      expect(getOrCreateAgentMcpAuthToken(home)).toBe(existing);
      expect(modeOf(tokenPath)).toBe(PRIVATE_FILE_MODE);
    });
  });
});
