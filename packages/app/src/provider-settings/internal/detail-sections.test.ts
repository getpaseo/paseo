import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { ProviderInstallationState } from "@/components/provider-installation-section";
import { readDetailPresence, readDetailSections } from "./detail-sections";

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
  it("shows models for a provider that runs", () => {
    expect(readDetailSections(entry(), unsupported)).toEqual({ error: null, models: true });
  });

  it("keeps models while the provider is probed again", () => {
    expect(readDetailSections(entry({ status: "loading" }), unsupported).models).toBe(true);
  });

  it("leads with the error and hides models when the provider fails", () => {
    expect(
      readDetailSections(
        entry({ status: "error", error: "opencode exited with code 1" }),
        unsupported,
      ),
    ).toEqual({ error: "opencode exited with code 1", models: false });
  });

  it("says nothing extra when Installation already says Not installed", () => {
    expect(readDetailSections(entry({ status: "unavailable" }), unsupported)).toEqual({
      error: null,
      models: false,
    });
    expect(
      readDetailSections(entry({ status: "error", error: "spawn ENOENT" }), notInstalled),
    ).toEqual({ error: null, models: false });
  });

  it("hides models and the error for a disabled provider", () => {
    expect(
      readDetailSections(entry({ enabled: false, status: "error", error: "boom" }), unsupported),
    ).toEqual({ error: null, models: false });
  });

  it("gives an error with no message an empty one, so the alert still shows", () => {
    expect(readDetailSections(entry({ status: "error" }), unsupported).error).toBe("");
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
        wasFound: false,
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
        wasFound: false,
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
        wasFound: false,
      }),
    ).toEqual({ kind: "missing" });
  });

  it("shows nothing for a provider it already showed that then left, as when it is removed", () => {
    expect(
      readDetailPresence({
        provider: "gone",
        connected: true,
        entries: loaded,
        error: null,
        wasFound: true,
      }),
    ).toEqual({ kind: "removed" });
  });

  it("says the host is offline rather than loading forever", () => {
    expect(
      readDetailPresence({
        provider: "codex",
        connected: false,
        entries: undefined,
        error: null,
        wasFound: false,
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
        wasFound: false,
      }),
    ).toEqual({ kind: "failed", message: "Request timed out" });
  });
});
