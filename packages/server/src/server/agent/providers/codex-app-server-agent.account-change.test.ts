import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  CodexAppServerAgentSession,
  shouldMonitorCodexAuthFileStorage,
} from "./codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./codex/test-utils/fake-app-server.js";

const temporaryDirectories: string[] = [];

test("only watches the credential file when Codex uses file storage", () => {
  expect(shouldMonitorCodexAuthFileStorage(undefined)).toBe(true);
  expect(shouldMonitorCodexAuthFileStorage("file")).toBe(true);
  expect(shouldMonitorCodexAuthFileStorage("keyring")).toBe(false);
  expect(shouldMonitorCodexAuthFileStorage("auto")).toBe(false);
  expect(shouldMonitorCodexAuthFileStorage("ephemeral")).toBe(false);
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function idToken(email: string): string {
  return `header.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.signature`;
}

function authJson(accountId: string, email: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      account_id: accountId,
      access_token: `access-${accountId}`,
      id_token: idToken(email),
      refresh_token: `refresh-${accountId}`,
    },
  });
}

async function waitForModelChange(
  events: AgentStreamEvent[],
  startIndex: number,
): Promise<Extract<AgentStreamEvent, { type: "model_changed" }>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const event = events.slice(startIndex).find((candidate) => candidate.type === "model_changed");
    if (event?.type === "model_changed") return event;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for Codex runtime info update");
}

test("surfaces an external Codex account switch and clears it when the launch account returns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-codex-session-auth-"));
  temporaryDirectories.push(directory);
  const authPath = join(directory, "auth.json");
  await writeFile(authPath, authJson("account-a", "a@example.com"));

  const appServer = createFakeCodexAppServer({
    "account/read": () => ({
      account: { type: "chatgpt", email: "a@example.com", planType: "pro" },
      requiresOpenaiAuth: true,
    }),
  });
  const session = new CodexAppServerAgentSession(
    {
      provider: "codex",
      cwd: directory,
      modeId: "auto",
      model: "gpt-5.4",
    },
    null,
    createTestLogger(),
    async () => appServer.child,
    {},
    false,
    false,
    false,
    "agent-1",
    "interactive",
    authPath,
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  await session.connect();
  await session.getRuntimeInfo();

  const accountBPath = join(directory, "auth-b.json");
  await writeFile(accountBPath, authJson("account-b", "b@example.com"));
  await rename(accountBPath, authPath);
  const changed = await waitForModelChange(events, 0);
  expect(changed.runtimeInfo.extra?.codexAccountLabel).toBe("a@example.com");
  expect(changed.runtimeInfo.extra?.codexAccountVerificationStatus).toBe("verified");
  expect(changed.runtimeInfo.extra?.codexAccountChange).toEqual({
    previousLabel: "a@example.com",
    nextLabel: "b@example.com",
    revision: 1,
  });

  const accountAPath = join(directory, "auth-a.json");
  await writeFile(accountAPath, authJson("account-a", "a@example.com"));
  await rename(accountAPath, authPath);
  const reverted = await waitForModelChange(events, events.indexOf(changed) + 1);
  expect(reverted.runtimeInfo.extra?.codexAccountChange).toBeUndefined();

  await session.close();
  appServer.assertNoErrors();
});

test("reports the account returned by Codex when it differs from the launch credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-codex-session-auth-"));
  temporaryDirectories.push(directory);
  const authPath = join(directory, "auth.json");
  await writeFile(authPath, authJson("account-b", "b@example.com"));

  const appServer = createFakeCodexAppServer({
    "account/read": () => ({
      account: { type: "chatgpt", email: "a@example.com", planType: "pro" },
      requiresOpenaiAuth: true,
    }),
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: directory, modeId: "auto", model: "gpt-5.4" },
    null,
    createTestLogger(),
    async () => appServer.child,
    {},
    false,
    false,
    false,
    "agent-1",
    "interactive",
    authPath,
  );

  await session.connect();
  const runtimeInfo = await session.getRuntimeInfo();
  expect(runtimeInfo.extra?.codexAccountLabel).toBe("a@example.com");
  expect(runtimeInfo.extra?.codexAccountVerificationStatus).toBe("mismatch");

  await session.close();
  appServer.assertNoErrors();
});

test("keeps the Codex session available when account verification is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-codex-session-auth-"));
  temporaryDirectories.push(directory);
  const authPath = join(directory, "auth.json");
  await writeFile(authPath, authJson("account-a", "a@example.com"));

  const appServer = createFakeCodexAppServer({ "account/read": () => ({}) });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: directory, modeId: "auto", model: "gpt-5.4" },
    null,
    createTestLogger(),
    async () => appServer.child,
    {},
    false,
    false,
    false,
    "agent-1",
    "interactive",
    authPath,
  );

  await session.connect();
  const runtimeInfo = await session.getRuntimeInfo();
  expect(runtimeInfo.extra?.codexAccountLabel).toBeUndefined();
  expect(runtimeInfo.extra?.codexAccountVerificationStatus).toBe("unavailable");

  await session.close();
  appServer.assertNoErrors();
});
