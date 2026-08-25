import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAuthFileMonitor,
  parseCodexAuthIdentity,
  readCodexAuthIdentity,
  type CodexAuthIdentity,
} from "./codex-auth-file-monitor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function idToken(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function chatGptAuth(accountId: string, email: string, accessToken: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      account_id: accountId,
      access_token: accessToken,
      id_token: idToken({ email }),
      refresh_token: `refresh-${accountId}`,
    },
  });
}

async function waitForIdentity(
  changes: CodexAuthIdentity[],
  expectedKey: string,
): Promise<CodexAuthIdentity> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const match = changes.find((identity) => identity.key === expectedKey);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expectedKey}`);
}

describe("parseCodexAuthIdentity", () => {
  it("uses the account id for identity and email for display", () => {
    expect(parseCodexAuthIdentity(chatGptAuth("account-a", "a@example.com", "token-a"))).toEqual({
      key: "account:account-a",
      label: "a@example.com",
    });
  });

  it("ignores token rotation for the same account", () => {
    const before = parseCodexAuthIdentity(chatGptAuth("account-a", "a@example.com", "token-a"));
    const after = parseCodexAuthIdentity(chatGptAuth("account-a", "a@example.com", "token-b"));
    expect(after?.key).toBe(before?.key);
  });

  it("distinguishes opaque API credentials without exposing them", () => {
    const first = parseCodexAuthIdentity(JSON.stringify({ OPENAI_API_KEY: "secret-a" }));
    const second = parseCodexAuthIdentity(JSON.stringify({ OPENAI_API_KEY: "secret-b" }));
    expect(first?.label).toBe("API credential");
    expect(first?.key).not.toBe(second?.key);
    expect(first?.key).not.toContain("secret-a");
  });
});

describe("CodexAuthFileMonitor", () => {
  it("detects an atomically replaced auth file and ignores same-account refreshes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-codex-auth-"));
    temporaryDirectories.push(directory);
    const authPath = join(directory, "auth.json");
    await writeFile(authPath, chatGptAuth("account-a", "a@example.com", "token-a"));
    const initialIdentity = await readCodexAuthIdentity(authPath);
    expect(initialIdentity).not.toBeNull();

    const changes: CodexAuthIdentity[] = [];
    const monitor = new CodexAuthFileMonitor({
      filePath: authPath,
      initialIdentity: initialIdentity!,
      onIdentityChange: (identity) => changes.push(identity),
      intervalMs: 20,
      settleDelaysMs: [5, 10, 20],
    });
    monitor.start();

    await writeFile(authPath, chatGptAuth("account-a", "a@example.com", "token-b"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(changes).toEqual([]);

    const replacementPath = join(directory, "auth.next.json");
    await writeFile(replacementPath, chatGptAuth("account-b", "b@example.com", "token-c"));
    await rename(replacementPath, authPath);

    await expect(waitForIdentity(changes, "account:account-b")).resolves.toEqual({
      key: "account:account-b",
      label: "b@example.com",
    });
    monitor.close();
  });
});
