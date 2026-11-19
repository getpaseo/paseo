import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProviderInstallationState } from "@/components/provider-installation-section";
import { readDetailPresence, readDetailSections, readShownInstallation } from "./detail-sections";

function entry(overrides: Partial<ProviderSnapshotEntry> = {}): ProviderSnapshotEntry {
  return {
    provider: "opencode",
    label: "OpenCode",
    status: "ready",
    enabled: true,
    modes: [],
    models: [],
    ...overrides,
  };
}

const unsupported: ProviderInstallationState = { status: "unsupported" };
const notInstalled: ProviderInstallationState = {
  status: "ready",
  installation: { inspection: { status: "not_installed" }, canUpdate: false },
};

describe("provider detail sections", () => {
  it("shows every model for a provider that runs", () => {
    expect(readDetailSections(entry(), unsupported)).toEqual({ error: null, models: "all" });
  });

  it("keeps every model while the provider is probed again", () => {
    expect(readDetailSections(entry({ status: "loading" }), unsupported).models).toBe("all");
  });

  it("leads with the error and keeps custom models when the provider fails", () => {
    expect(
      readDetailSections(
        entry({ status: "error", error: "opencode exited with code 1" }),
        unsupported,
      ),
    ).toEqual({ error: "opencode exited with code 1", models: "custom" });
  });

  it("says nothing extra and lists no models when Installation already says Not installed", () => {
    expect(readDetailSections(entry({ status: "unavailable" }), unsupported)).toEqual({
      error: null,
      models: null,
    });
    expect(
      readDetailSections(entry({ status: "error", error: "spawn ENOENT" }), notInstalled),
    ).toEqual({ error: null, models: null });
  });

  it("hides models and the error for a disabled provider", () => {
    expect(
      readDetailSections(entry({ enabled: false, status: "error", error: "boom" }), unsupported),
    ).toEqual({ error: null, models: null });
  });

  it("gives an error with no message an empty one, so the alert still shows", () => {
    expect(readDetailSections(entry({ status: "error" }), unsupported).error).toBe("");
  });
});

describe("provider detail installation", () => {
  const guide = "https://example.com/install";
  const noContract: ProviderInstallationState = { status: "ready", installation: null };

  it("says Not installed with the install guide when the host reports nothing about it", () => {
    expect(
      readShownInstallation({
        entry: entry({ status: "unavailable" }),
        installation: noContract,
        installGuide: guide,
      }),
    ).toEqual({
      status: "ready",
      installation: { inspection: { status: "not_installed" }, installUrl: guide },
    });
  });

  it("keeps the host's install link over the guide", () => {
    const hosted: ProviderInstallationState = {
      status: "ready",
      installation: {
        inspection: { status: "not_installed" },
        installUrl: "https://host.example/install",
        canUpdate: false,
      },
    };
    expect(
      readShownInstallation({
        entry: entry({ status: "unavailable" }),
        installation: hosted,
        installGuide: guide,
      }),
    ).toEqual(hosted);
  });

  it("gives the host's Not installed the guide when the host has no link", () => {
    expect(
      readShownInstallation({
        entry: entry({ status: "unavailable" }),
        installation: notInstalled,
        installGuide: guide,
      }),
    ).toEqual({
      status: "ready",
      installation: {
        inspection: { status: "not_installed" },
        canUpdate: false,
        installUrl: guide,
      },
    });
  });

  it("adds nothing for an installed or disabled provider", () => {
    expect(
      readShownInstallation({ entry: entry(), installation: noContract, installGuide: guide }),
    ).toEqual(noContract);
    expect(
      readShownInstallation({
        entry: entry({ enabled: false, status: "unavailable" }),
        installation: noContract,
        installGuide: guide,
      }),
    ).toEqual(noContract);
  });

  it("says nothing it cannot back with a guide", () => {
    expect(
      readShownInstallation({
        entry: entry({ status: "unavailable" }),
        installation: noContract,
        installGuide: null,
      }),
    ).toEqual(noContract);
  });

  it("says Not installed with the guide on a host that cannot report installations", () => {
    expect(
      readShownInstallation({
        entry: entry({ status: "unavailable" }),
        installation: unsupported,
        installGuide: guide,
      }),
    ).toEqual({
      status: "ready",
      installation: { inspection: { status: "not_installed" }, installUrl: guide },
    });
    // Without a guide, or for a provider the host runs, there is nothing to show.
    expect(
      readShownInstallation({
        entry: entry({ status: "unavailable" }),
        installation: unsupported,
        installGuide: null,
      }),
    ).toEqual(unsupported);
    expect(
      readShownInstallation({ entry: entry(), installation: unsupported, installGuide: guide }),
    ).toEqual(unsupported);
  });

  it("waits while the host is still checking", () => {
    const checking: ProviderInstallationState = { status: "loading" };
    expect(
      readShownInstallation({
        entry: entry({ status: "unavailable" }),
        installation: checking,
        installGuide: guide,
      }),
    ).toEqual(checking);
  });
});

describe("provider detail presence", () => {
  const loaded = [entry(), entry({ provider: "codex", label: "Codex" })];

  it("finds the provider among the host's providers", () => {
    expect(
      readDetailPresence({
        provider: "codex",
        connected: true,
        entries: loaded,
        error: null,
        removing: null,
      }),
    ).toEqual({ kind: "found", entry: loaded[1] });
  });

  it("is loading until the host's providers arrive", () => {
    expect(
      readDetailPresence({
        provider: "codex",
        connected: true,
        entries: undefined,
        error: null,
        removing: null,
      }),
    ).toEqual({ kind: "loading" });
  });

  it("says the provider is missing once the host's providers have arrived without it", () => {
    expect(
      readDetailPresence({
        provider: "gone",
        connected: true,
        entries: loaded,
        error: null,
        removing: null,
      }),
    ).toEqual({ kind: "missing" });
  });

  it("keeps showing a provider this page is removing once it leaves the list", () => {
    const gone = entry({ provider: "gone", label: "Gone" });
    expect(
      readDetailPresence({
        provider: "gone",
        connected: true,
        entries: loaded,
        error: null,
        removing: gone,
      }),
    ).toEqual({ kind: "found", entry: gone });
  });

  it("says the host is offline rather than loading forever", () => {
    expect(
      readDetailPresence({
        provider: "codex",
        connected: false,
        entries: undefined,
        error: null,
        removing: null,
      }),
    ).toEqual({ kind: "offline" });
  });

  it("shows why the host's providers could not be read", () => {
    expect(
      readDetailPresence({
        provider: "codex",
        connected: true,
        entries: undefined,
        error: "Request timed out",
        removing: null,
      }),
    ).toEqual({ kind: "failed", message: "Request timed out" });
  });
});
