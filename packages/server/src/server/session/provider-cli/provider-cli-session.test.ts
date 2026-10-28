import { describe, expect, test } from "vitest";

import type { ProviderCliStatus } from "@getpaseo/protocol/provider-cli/rpc-schemas";
import type { SessionOutboundMessage } from "../../messages.js";
import { ProviderCliSession } from "./provider-cli-session.js";

const claudeStatus: ProviderCliStatus = {
  provider: "claude",
  installed: true,
  version: "1.0.0",
  latestVersion: "2.0.0",
  updateAvailable: true,
  managedExternally: false,
  update: { supported: true, status: "idle", error: null, finishedAt: null },
  auth: { supported: true, status: "signed_out", account: null },
  login: null,
};

function createSession() {
  const emitted: SessionOutboundMessage[] = [];
  const calls: string[] = [];
  const session = new ProviderCliSession({
    emit: (message) => emitted.push(message),
    runtime: {
      listStatus: async (options) => {
        calls.push(`list:${options?.refresh === true}`);
        return [claudeStatus];
      },
      startUpdate: async (provider) => {
        calls.push(`update:${provider}`);
      },
      startLogin: async (provider) => {
        if (provider !== "claude") throw new Error(`Paseo cannot sign in to ${provider}`);
        calls.push(`login:${provider}`);
      },
      sendLoginInput: (provider, text) => {
        calls.push(`input:${provider}:${text}`);
      },
      cancelLogin: (provider) => {
        calls.push(`cancel:${provider}`);
      },
    },
  });
  return { session, emitted, calls };
}

describe("ProviderCliSession", () => {
  test("lists provider CLI status, forwarding refresh", async () => {
    const { session, emitted, calls } = createSession();

    await session.dispatch({
      type: "provider.cli.status.list.request",
      requestId: "r1",
      refresh: true,
    });

    expect(calls).toEqual(["list:true"]);
    expect(emitted).toEqual([
      {
        type: "provider.cli.status.list.response",
        payload: { requestId: "r1", providers: [claudeStatus], error: null },
      },
    ]);
  });

  test("acknowledges update and sign-in requests", async () => {
    const { session, emitted, calls } = createSession();

    await session.dispatch({
      type: "provider.cli.update.start.request",
      requestId: "u1",
      provider: "claude",
    });
    await session.dispatch({
      type: "provider.cli.login.start.request",
      requestId: "l1",
      provider: "claude",
    });
    await session.dispatch({
      type: "provider.cli.login.input.request",
      requestId: "i1",
      provider: "claude",
      text: "code",
    });
    await session.dispatch({
      type: "provider.cli.login.cancel.request",
      requestId: "c1",
      provider: "claude",
    });

    expect(calls).toEqual(["update:claude", "login:claude", "input:claude:code", "cancel:claude"]);
    expect(emitted.map((message) => message.type)).toEqual([
      "provider.cli.update.start.response",
      "provider.cli.login.start.response",
      "provider.cli.login.input.response",
      "provider.cli.login.cancel.response",
    ]);
  });

  test("returns runtime errors on the response", async () => {
    const { session, emitted } = createSession();

    await session.dispatch({
      type: "provider.cli.login.start.request",
      requestId: "l1",
      provider: "copilot",
    });

    expect(emitted).toEqual([
      {
        type: "provider.cli.login.start.response",
        payload: { requestId: "l1", error: "Paseo cannot sign in to copilot" },
      },
    ]);
  });

  test("reports a daemon without provider CLI management", async () => {
    const emitted: SessionOutboundMessage[] = [];
    const session = new ProviderCliSession({ emit: (message) => emitted.push(message) });

    await session.dispatch({ type: "provider.cli.status.list.request", requestId: "r1" });

    expect(emitted).toEqual([
      {
        type: "provider.cli.status.list.response",
        payload: {
          requestId: "r1",
          providers: [],
          error: "Provider CLI management is unavailable on this daemon",
        },
      },
    ]);
  });

  test("ignores other messages", () => {
    const { session } = createSession();
    expect(session.dispatch({ type: "speech.local_models.list.request", requestId: "x" })).toBe(
      undefined,
    );
  });
});
