import { describe, expect, it } from "vitest";
import type { ProviderInstallationUpdate } from "@getpaseo/protocol/messages";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProviderInstallationRead } from "@/components/provider-installation";
import { readRowSummary } from "./row-summary";

type Read = Pick<ProviderInstallationRead, "state" | "updates" | "action">;

function entry(overrides: Partial<ProviderSnapshotEntry> = {}): ProviderSnapshotEntry {
  return {
    provider: "claude",
    label: "Claude",
    status: "ready",
    enabled: true,
    modes: [],
    models: [
      { provider: "claude", id: "opus", label: "Opus" },
      { provider: "claude", id: "sonnet", label: "Sonnet" },
    ],
    ...overrides,
  };
}

function installed(version: string | undefined, overrides: Partial<Read> = {}): Read {
  return {
    state: {
      status: "ready",
      installation: { inspection: { status: "installed", version }, canUpdate: true },
    },
    updates: { status: "ready", updateCheck: { status: "current" } },
    action: { current: null, starting: false, startError: null, start: () => undefined },
    ...overrides,
  };
}

function update(operation: ProviderInstallationUpdate["operation"]): ProviderInstallationUpdate {
  return { operation, output: [] };
}

const oldHost: Read = {
  state: { status: "unsupported" },
  updates: { status: "hidden" },
  action: undefined,
};

describe("provider row summary", () => {
  it("reads version and model count for a provider that runs", () => {
    expect(readRowSummary(entry(), installed("2.1.321"))).toEqual({
      kind: "ready",
      version: "2.1.321",
      models: 2,
    });
  });

  it("says an update is available after the version", () => {
    const read = installed("2.1.321", {
      updates: { status: "ready", updateCheck: { status: "available", versions: ["2.1.400"] } },
    });
    expect(readRowSummary(entry(), read)).toEqual({ kind: "updateAvailable", version: "2.1.321" });
  });

  it("names the target version while an update runs, when the check reported one", () => {
    const running = update({ status: "running", id: "u1", startedAt: "2026-11-14T10:00:00Z" });
    const one = installed("1.0.30", {
      updates: { status: "ready", updateCheck: { status: "available", versions: ["1.0.31"] } },
      action: { current: running, starting: false, startError: null, start: () => undefined },
    });
    expect(readRowSummary(entry(), one)).toEqual({ kind: "updating", target: "1.0.31" });

    const unknown = installed("1.0.30", {
      updates: { status: "ready", updateCheck: { status: "available" } },
      action: { current: null, starting: true, startError: null, start: () => undefined },
    });
    expect(readRowSummary(entry(), unknown)).toEqual({ kind: "updating", target: null });
  });

  it("reports a failed update as the fault", () => {
    const failed = update({
      status: "failed",
      id: "u1",
      startedAt: "2026-11-14T10:00:00Z",
      finishedAt: "2026-11-14T10:01:00Z",
      message: "npm exited with code 1",
    });
    const read = installed("1.0.30", {
      action: { current: failed, starting: false, startError: null, start: () => undefined },
    });
    expect(readRowSummary(entry(), read)).toEqual({
      kind: "failing",
      message: "npm exited with code 1",
    });
  });

  it("reports the provider's error", () => {
    expect(
      readRowSummary(entry({ status: "error", error: " opencode exited with code 1 " }), oldHost),
    ).toEqual({ kind: "failing", message: "opencode exited with code 1" });
    expect(readRowSummary(entry({ status: "error" }), oldHost)).toEqual({
      kind: "failing",
      message: null,
    });
  });

  it("calls a missing CLI Not installed, not a fault", () => {
    expect(readRowSummary(entry({ status: "unavailable" }), oldHost)).toEqual({
      kind: "notInstalled",
    });
    const missing: Read = {
      ...oldHost,
      state: { status: "ready", installation: { inspection: { status: "not_installed" } } },
    };
    expect(readRowSummary(entry({ status: "error", error: "spawn ENOENT" }), missing)).toEqual({
      kind: "notInstalled",
    });
  });

  it("says Disabled for a provider that is off", () => {
    expect(readRowSummary(entry({ enabled: false }), installed("2.1.321"))).toEqual({
      kind: "disabled",
    });
  });

  it("calls a disabled provider whose CLI is missing Not installed, so turning it on changes nothing", () => {
    const missing: Read = {
      ...oldHost,
      state: { status: "ready", installation: { inspection: { status: "not_installed" } } },
    };
    expect(readRowSummary(entry({ enabled: false, status: "unavailable" }), missing)).toEqual({
      kind: "notInstalled",
    });
    // A disabled provider is never probed, so without an inspection it is only Disabled.
    expect(readRowSummary(entry({ enabled: false, status: "unavailable" }), oldHost)).toEqual({
      kind: "disabled",
    });
  });

  it("holds the line until the installation is read", () => {
    const reading: Read = { ...oldHost, state: { status: "loading" } };
    expect(readRowSummary(entry(), reading)).toEqual({ kind: "pending" });
  });

  it("holds the line while the provider's first probe runs", () => {
    expect(readRowSummary(entry({ status: "loading", models: [] }), oldHost)).toEqual({
      kind: "pending",
    });
  });

  it("keeps the last count while the provider is probed again", () => {
    expect(readRowSummary(entry({ status: "loading" }), installed("2.1.321"))).toEqual({
      kind: "ready",
      version: "2.1.321",
      models: 2,
    });
  });

  it("reads a count alone on hosts that cannot report installations", () => {
    expect(readRowSummary(entry(), oldHost)).toEqual({ kind: "ready", version: null, models: 2 });
  });
});
