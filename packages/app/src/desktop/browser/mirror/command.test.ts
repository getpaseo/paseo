import { describe, expect, it } from "vitest";
import type { BrowserTabExecuteResponse } from "@getpaseo/protocol/browser-automation/client-command";
import { describeMirrorFailure, runMirrorCommand, type BrowserCommandSender } from "./command";

type ExecutePayload = BrowserTabExecuteResponse["payload"];

function senderAnswering(payload: ExecutePayload): BrowserCommandSender {
  return { runBrowserCommand: async () => payload };
}

function senderRejecting(error: unknown): BrowserCommandSender {
  return {
    runBrowserCommand: async () => {
      throw error;
    },
  };
}

const RELOAD = { command: "reload", args: { browserId: "browser-1" } } as const;

describe("runMirrorCommand", () => {
  it("reports the host result when the command succeeds", async () => {
    const sender = senderAnswering({
      requestId: "r1",
      ok: true,
      result: { command: "reload", browserId: "browser-1" },
    });

    const outcome = await runMirrorCommand({
      sender,
      command: RELOAD,
      workspaceId: "workspace-1",
    });

    expect(outcome).toEqual({
      status: "ok",
      result: { command: "reload", browserId: "browser-1" },
    });
  });

  it("reports the host's message when the host refuses the command", async () => {
    const sender = senderAnswering({
      requestId: "r1",
      ok: false,
      error: { code: "browser_tab_not_found", message: "No such browser", retryable: false },
    });

    const outcome = await runMirrorCommand({
      sender,
      command: RELOAD,
      workspaceId: "workspace-1",
    });

    expect(outcome).toEqual({ status: "failed", message: "No such browser" });
  });

  it("reports a rejected request as a failure instead of losing it", async () => {
    const sender = senderRejecting(new Error("Request timed out"));

    const outcome = await runMirrorCommand({
      sender,
      command: RELOAD,
      workspaceId: "workspace-1",
    });

    expect(outcome).toEqual({ status: "failed", message: "Request timed out" });
  });

  it("reports a missing client as disconnected rather than doing nothing", async () => {
    const outcome = await runMirrorCommand({
      sender: null,
      command: RELOAD,
      workspaceId: "workspace-1",
    });

    expect(outcome).toEqual({ status: "disconnected" });
  });
});

describe("describeMirrorFailure", () => {
  it("uses the caller's label when there is no connection to explain", () => {
    expect(describeMirrorFailure({ status: "disconnected" }, "Daemon client unavailable")).toBe(
      "Daemon client unavailable",
    );
  });

  it("prefers the host's own message over the connection label", () => {
    expect(
      describeMirrorFailure({ status: "failed", message: "Navigation blocked" }, "Disconnected"),
    ).toBe("Navigation blocked");
  });
});
