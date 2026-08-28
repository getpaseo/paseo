import type { BrowserTabExecuteResponse } from "@getpaseo/protocol/browser-automation/client-command";
import { describe, expect, it } from "vitest";
import { describeMirrorFailure, runMirrorCommand, type BrowserCommandSender } from "./command";

const RELOAD = { command: "reload", args: { browserId: "browser-1" } } as const;
const run = (sender: BrowserCommandSender | null) =>
  runMirrorCommand({ sender, command: RELOAD, workspaceId: "workspace-1" });
const answering = (payload: BrowserTabExecuteResponse["payload"]): BrowserCommandSender => ({
  runBrowserCommand: async () => payload,
});

describe("runMirrorCommand", () => {
  it("returns the host result", async () => {
    await expect(
      run(
        answering({
          requestId: "r1",
          ok: true,
          result: { command: "reload", browserId: "browser-1" },
        }),
      ),
    ).resolves.toEqual({
      status: "ok",
      result: { command: "reload", browserId: "browser-1" },
    });
  });

  it.each([
    [
      answering({
        requestId: "r1",
        ok: false,
        error: {
          code: "browser_tab_not_found",
          message: "refused",
          retryable: false,
        },
      }),
      "refused",
    ],
    [{ runBrowserCommand: async () => Promise.reject(new Error("timed out")) }, "timed out"],
  ] satisfies Array<[BrowserCommandSender, string]>)(
    "reports command failures",
    async (sender, message) => {
      await expect(run(sender)).resolves.toEqual({ status: "failed", message });
    },
  );

  it("reports a missing client as disconnected", async () => {
    await expect(run(null)).resolves.toEqual({ status: "disconnected" });
  });
});

it.each([
  [{ status: "disconnected" } as const, "unavailable"],
  [{ status: "failed", message: "blocked" } as const, "blocked"],
])("describes mirror failures", (outcome, expected) => {
  expect(describeMirrorFailure(outcome, "unavailable")).toBe(expected);
});
