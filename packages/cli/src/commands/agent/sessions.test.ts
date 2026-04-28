import type { FetchPersistedAgentsEntry } from "@getpaseo/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentSessionsFetchOptions,
  resolvePersistedSession,
  toAgentSessionListItem,
} from "./sessions.js";

function makeEntry(sessionId: string): FetchPersistedAgentsEntry {
  return {
    provider: "opencode",
    sessionId,
    cwd: "/tmp/project",
    title: null,
    lastActivityAt: "2026-04-26T18:11:00.000Z",
    persistence: {
      provider: "opencode",
      sessionId,
    },
    timeline: [],
  };
}

describe("buildAgentSessionsFetchOptions", () => {
  it("queries OpenCode sessions in the current directory by default", () => {
    expect(buildAgentSessionsFetchOptions({})).toEqual({
      provider: "opencode",
      cwd: process.cwd(),
      page: { limit: 20 },
    });
  });

  it("passes provider, cwd, and limit to the daemon", () => {
    expect(
      buildAgentSessionsFetchOptions({
        provider: "opencode",
        cwd: "/tmp/project",
        limit: "5",
      }),
    ).toEqual({
      provider: "opencode",
      cwd: "/tmp/project",
      page: { limit: 5 },
    });
  });

  it("rejects invalid limits", () => {
    expect(() => buildAgentSessionsFetchOptions({ limit: "0" })).toThrow(
      expect.objectContaining({ code: "INVALID_LIMIT" }),
    );
  });
});

describe("toAgentSessionListItem", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats persisted session entries for table output", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T18:16:00.000Z"));

    const entry = {
      provider: "opencode",
      sessionId: "ses_1234567890",
      cwd: "/tmp/project",
      title: null,
      lastActivityAt: "2026-04-26T18:11:00.000Z",
      persistence: {
        provider: "opencode",
        sessionId: "ses_1234567890",
      },
      timeline: [
        { type: "user_message", text: "hello" },
        { type: "assistant_message", text: "hi" },
      ],
    } satisfies FetchPersistedAgentsEntry;

    expect(toAgentSessionListItem(entry)).toEqual({
      sessionId: "ses_1234567890",
      shortSessionId: "ses_12345678",
      title: "-",
      provider: "opencode",
      cwd: "/tmp/project",
      updated: "5 minutes ago",
      handoff: "quit terminal OpenCode first",
      messages: 2,
    });
  });
});

describe("resolvePersistedSession", () => {
  it("resolves exact session IDs and unique prefixes", () => {
    const entries = [makeEntry("ses_alpha"), makeEntry("ses_beta")];

    expect(resolvePersistedSession("ses_alpha", entries).sessionId).toBe("ses_alpha");
    expect(resolvePersistedSession("ses_b", entries).sessionId).toBe("ses_beta");
  });

  it("rejects ambiguous session prefixes", () => {
    const entries = [makeEntry("ses_alpha"), makeEntry("ses_alpine")];

    expect(() => resolvePersistedSession("ses_al", entries)).toThrow(
      expect.objectContaining({ code: "AMBIGUOUS_SESSION_ID" }),
    );
  });

  it("rejects unknown sessions", () => {
    expect(() => resolvePersistedSession("missing", [makeEntry("ses_alpha")])).toThrow(
      expect.objectContaining({ code: "SESSION_NOT_FOUND" }),
    );
  });
});
