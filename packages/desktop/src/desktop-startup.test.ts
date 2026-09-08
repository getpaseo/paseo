import { describe, expect, it, vi } from "vitest";
import { runDesktopStartup } from "./desktop-startup";

describe("desktop startup", () => {
  it("runs CLI passthrough before GUI login-shell env inheritance", async () => {
    const calls: string[] = [];
    await runDesktopStartup({
      hasPendingGuiLaunchRequest: false,
      runDaemonOnlyIfRequested: vi.fn(async () => false),
      runCliPassthroughIfRequested: vi.fn(async () => {
        calls.push("cli");
        return true;
      }),
      inheritLoginShellEnv: vi.fn(() => calls.push("env")),
      bootstrapGui: vi.fn(async () => {
        calls.push("gui");
      }),
    });

    expect(calls).toEqual(["cli"]);
  });

  it("keeps login-shell env inheritance on normal GUI startup", async () => {
    const calls: string[] = [];
    await runDesktopStartup({
      hasPendingGuiLaunchRequest: false,
      runDaemonOnlyIfRequested: vi.fn(async () => false),
      runCliPassthroughIfRequested: vi.fn(async () => {
        calls.push("cli");
        return false;
      }),
      inheritLoginShellEnv: vi.fn(() => calls.push("env")),
      bootstrapGui: vi.fn(async () => {
        calls.push("gui");
      }),
    });

    expect(calls).toEqual(["cli", "env", "gui"]);
  });

  it("does not route open-project launches through CLI passthrough", async () => {
    const runCliPassthroughIfRequested = vi.fn(async () => true);
    const calls: string[] = [];

    await runDesktopStartup({
      hasPendingGuiLaunchRequest: true,
      runDaemonOnlyIfRequested: vi.fn(async () => false),
      runCliPassthroughIfRequested,
      inheritLoginShellEnv: vi.fn(() => calls.push("env")),
      bootstrapGui: vi.fn(async () => {
        calls.push("gui");
      }),
    });

    expect(runCliPassthroughIfRequested).not.toHaveBeenCalled();
    expect(calls).toEqual(["env", "gui"]);
  });
  it("runs the headless daemon service instead of the CLI or a window", async () => {
    const calls: string[] = [];
    const runCliPassthroughIfRequested = vi.fn(async () => true);

    await runDesktopStartup({
      hasPendingGuiLaunchRequest: false,
      runDaemonOnlyIfRequested: vi.fn(async () => {
        calls.push("daemon-only");
        return true;
      }),
      runCliPassthroughIfRequested,
      inheritLoginShellEnv: vi.fn(() => calls.push("env")),
      bootstrapGui: vi.fn(async () => {
        calls.push("gui");
      }),
    });

    expect(runCliPassthroughIfRequested).not.toHaveBeenCalled();
    expect(calls).toEqual(["daemon-only"]);
  });

  it("runs the headless daemon service even when argv also names a project to open", async () => {
    const calls: string[] = [];

    await runDesktopStartup({
      hasPendingGuiLaunchRequest: true,
      runDaemonOnlyIfRequested: vi.fn(async () => {
        calls.push("daemon-only");
        return true;
      }),
      runCliPassthroughIfRequested: vi.fn(async () => false),
      inheritLoginShellEnv: vi.fn(() => calls.push("env")),
      bootstrapGui: vi.fn(async () => {
        calls.push("gui");
      }),
    });

    expect(calls).toEqual(["daemon-only"]);
  });
});
