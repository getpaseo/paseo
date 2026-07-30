import { describe, expect, it } from "vitest";
import pino from "pino";

import {
  buildLiveVoiceInitialItems,
  buildLiveVoicePrompt,
  buildLiveVoiceStartContext,
  type LiveVoiceContextSnapshot,
} from "./live-voice-context.js";
import { LiveVoiceDaemonContextProvider } from "./live-voice-daemon-context.js";

const ATTACHED_AGENT_ID = "agent-attached";

function snapshot(overrides: Partial<LiveVoiceContextSnapshot> = {}): LiveVoiceContextSnapshot {
  return {
    attachedAgentId: ATTACHED_AGENT_ID,
    agents: [
      {
        id: ATTACHED_AGENT_ID,
        provider: "codex",
        cwd: "/work/paseo",
        workspaceId: "ws-1",
        title: "Live voice work",
        lifecycle: "idle",
      },
    ],
    workspaces: [
      {
        workspaceId: "ws-1",
        name: "wrathful-seal",
        cwd: "/work/paseo",
        branch: "realtime-voice-actions",
      },
    ],
    paseoToolsAvailable: true,
    ...overrides,
  };
}

const logger = pino({ level: "silent" });

describe("live voice prompt", () => {
  it("tells the model it delegates to the attached session and can reach Paseo's own controls", () => {
    const prompt = buildLiveVoicePrompt(true);

    expect(prompt).toContain("You are the voice of Paseo.");
    expect(prompt).toContain("delegate to the attached session");
    // The whole point of phase 2: the model must know Paseo itself is actionable.
    expect(prompt).toMatch(/archive workspaces/i);
    expect(prompt).toMatch(/agent sessions/i);
    // Spoken-output discipline, since this prompt replaces codex's entire prompt.
    expect(prompt).toMatch(/no markdown/i);
  });

  it("does not promise Paseo control when the session has no Paseo tools", () => {
    const prompt = buildLiveVoicePrompt(false);

    expect(prompt).toContain("It cannot control Paseo itself on this daemon");
    expect(prompt).not.toMatch(/archive workspaces/i);
    // Code work is still delegable — only Paseo control is off the table.
    expect(prompt).toContain("read and change code");
  });
});

describe("live voice initial items", () => {
  it("puts the attached session first and labels the other sections", () => {
    const items = buildLiveVoiceInitialItems(
      snapshot({
        agents: [
          ...snapshot().agents,
          {
            id: "agent-other",
            provider: "claude",
            cwd: "/work/other",
            workspaceId: "ws-2",
            title: "Docs pass",
            lifecycle: "running",
          },
        ],
      }),
    );

    expect(items).toHaveLength(3);
    expect(items.every((item) => item.role === "developer")).toBe(true);
    expect(items[0]?.text).toContain("The agent session you are attached to:");
    expect(items[0]?.text).toContain("Live voice work");
    expect(items[0]?.text).not.toContain("Docs pass");
    expect(items[1]?.text).toContain("Other agent sessions on this daemon (1)");
    expect(items[1]?.text).toContain("Docs pass");
    expect(items[2]?.text).toContain("Workspaces on this daemon (1)");
    expect(items[2]?.text).toContain("realtime-voice-actions");
  });

  it("omits sections that have nothing in them", () => {
    const items = buildLiveVoiceInitialItems(snapshot({ workspaces: [] }));

    expect(items).toHaveLength(1);
    expect(items[0]?.text).toContain("attached to:");
  });

  it("reports a truncated list as truncated rather than silently cutting it", () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      workspaceId: `ws-${index}`,
      name: `workspace-${index}`,
      cwd: `/work/w${index}`,
      branch: null,
    }));

    const items = buildLiveVoiceInitialItems(snapshot({ workspaces: many }));
    const workspaceItem = items.find((item) => item.text.includes("Workspaces on this daemon"));

    expect(workspaceItem?.text).toContain("Workspaces on this daemon (25)");
    expect(workspaceItem?.text).toContain("...and 5 more.");
  });

  it("stays inside the provider's item and token limits with a large daemon", () => {
    const agents = Array.from({ length: 200 }, (_, index) => ({
      id: `agent-${index}`,
      provider: "codex",
      cwd: `/work/very/long/path/that/eats/budget/number-${index}`,
      workspaceId: `ws-${index}`,
      title: `A fairly long agent session title number ${index}`,
      lifecycle: "running",
    }));
    const workspaces = Array.from({ length: 200 }, (_, index) => ({
      workspaceId: `ws-${index}`,
      name: `a-reasonably-long-workspace-name-${index}`,
      cwd: `/work/very/long/path/that/eats/budget/number-${index}`,
      branch: `feature/some-long-branch-name-${index}`,
    }));

    const items = buildLiveVoiceInitialItems(
      snapshot({ agents: [...snapshot().agents, ...agents], workspaces }),
    );

    expect(items.length).toBeLessThanOrEqual(128);
    const estimated = items.reduce(
      (total, item) => total + Math.ceil(Buffer.byteLength(item.text, "utf8") / 4),
      0,
    );
    expect(estimated).toBeLessThan(8_192);
  });
});

describe("daemon context provider", () => {
  it("builds context from live state, skipping closed sessions and archived workspaces", async () => {
    const provider = new LiveVoiceDaemonContextProvider({
      agents: {
        hasPaseoMcpInjection: () => true,
        listAgents: () => [
          {
            id: ATTACHED_AGENT_ID,
            provider: "codex",
            cwd: "/work/paseo",
            workspaceId: "ws-1",
            lifecycle: "idle",
            config: { title: "Live voice work" },
          },
          {
            id: "agent-gone",
            provider: "codex",
            cwd: "/work/old",
            workspaceId: "ws-old",
            lifecycle: "closed",
            config: { title: "Finished" },
          },
        ],
      },
      workspaces: {
        list: async () => [
          {
            workspaceId: "ws-1",
            cwd: "/work/paseo",
            displayName: "paseo",
            title: "wrathful-seal",
            branch: "realtime-voice-actions",
            archivedAt: null,
          },
          {
            workspaceId: "ws-old",
            cwd: "/work/old",
            displayName: "old",
            title: null,
            branch: null,
            archivedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      logger,
    });

    const context = await provider.build(ATTACHED_AGENT_ID);

    expect(context?.prompt).toContain("You are the voice of Paseo.");
    const text = (context?.initialItems ?? []).map((item) => item.text).join("\n");
    expect(text).toContain("Live voice work");
    expect(text).toContain("wrathful-seal");
    expect(text).not.toContain("Finished");
    expect(text).not.toContain("/work/old");
    // Only the attached session exists, so there is no "other sessions" section.
    expect(text).not.toContain("Other agent sessions");
  });

  it("reflects a daemon that does not inject Paseo tools into sessions", async () => {
    const provider = new LiveVoiceDaemonContextProvider({
      agents: { hasPaseoMcpInjection: () => false, listAgents: () => [] },
      workspaces: { list: async () => [] },
      logger,
    });

    const context = await provider.build(ATTACHED_AGENT_ID);

    expect(context?.prompt).toContain("It cannot control Paseo itself on this daemon");
  });

  it("prefers the workspace title over its derived display name", async () => {
    const provider = new LiveVoiceDaemonContextProvider({
      agents: { hasPaseoMcpInjection: () => true, listAgents: () => [] },
      workspaces: {
        list: async () => [
          {
            workspaceId: "ws-1",
            cwd: "/work/paseo",
            displayName: "derived-name",
            title: "  user-title  ",
            branch: null,
            archivedAt: null,
          },
        ],
      },
      logger,
    });

    const context = await provider.build(ATTACHED_AGENT_ID);

    const text = (context?.initialItems ?? []).map((item) => item.text).join("\n");
    expect(text).toContain("user-title");
    expect(text).not.toContain("derived-name");
  });
});

describe("start context", () => {
  it("pairs the prompt with the snapshot items", () => {
    const context = buildLiveVoiceStartContext(snapshot());

    expect(context.prompt).toBe(buildLiveVoicePrompt(true));
    expect(context.initialItems.length).toBeGreaterThan(0);
  });
});
