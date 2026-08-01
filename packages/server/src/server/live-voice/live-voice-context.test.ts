import { describe, expect, it } from "vitest";
import pino from "pino";

import {
  buildLiveVoiceInitialItems,
  buildLiveVoicePrompt,
  buildLiveVoiceStartContext,
  type LiveVoiceContextSnapshot,
} from "./live-voice-context.js";
import { LiveVoiceDaemonContextProvider } from "./live-voice-daemon-context.js";
import { buildVoiceModeSystemPrompt } from "../voice-config.js";

const AGENT_ID = "agent-1";

function snapshot(overrides: Partial<LiveVoiceContextSnapshot> = {}): LiveVoiceContextSnapshot {
  return {
    agents: [
      {
        id: AGENT_ID,
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
  it("tells the model it routes work to sessions and can reach Paseo's own controls", () => {
    const prompt = buildLiveVoicePrompt({ paseoToolsAvailable: true });

    expect(prompt).toContain("You are the voice of Paseo");
    expect(prompt).toContain("prompt an existing agent session");
    // The whole point of phase 2: the model must know Paseo itself is actionable.
    expect(prompt).toMatch(/archive workspaces/i);
    expect(prompt).toMatch(/agent sessions/i);
    expect(prompt).toContain("list_hosts");
    expect(prompt).toContain("run_paseo_tool_on_host");
    expect(prompt).toMatch(/credentials and connection endpoints are intentionally unavailable/i);
    // Its own session is not a project session, and must not be used as one.
    expect(prompt).toMatch(/never do coding work yourself/i);
    expect(prompt).not.toMatch(/attached/i);
    // Spoken-output discipline, since this prompt replaces codex's entire prompt.
    expect(prompt).toMatch(/no markdown/i);
  });

  it("requires user-requested agent creation to stay visible in Paseo", () => {
    const prompt = buildLiveVoicePrompt({ paseoToolsAvailable: true });

    expect(prompt).toMatch(/spawn, start, create, or delegate to an agent/i);
    expect(prompt).toContain("list_hosts");
    expect(prompt).toContain("create_workspace");
    expect(prompt).toContain("create_agent");
    expect(prompt).toMatch(/pass the returned workspaceId to create_agent/i);
    expect(prompt).toMatch(/spawn_agent/i);
    expect(prompt).toMatch(/Agent tool/i);
    expect(prompt).toMatch(/collaboration primitives/i);
    expect(prompt).toMatch(/never silently fall back/i);
    expect(prompt).toMatch(/both workspaceId and agentId/i);
    expect(prompt).toMatch(/visible workspace and agent titles/i);
  });

  it("keeps Live Voice creation guidance out of ordinary voice-mode prompts", () => {
    const prompt = buildVoiceModeSystemPrompt("Base system prompt", true);

    expect(prompt).not.toContain("list_hosts");
    expect(prompt).not.toContain("create_workspace");
    expect(prompt).not.toContain("spawn_agent");
    expect(prompt).not.toContain("collaboration primitives");
  });

  it("admits it cannot act on Paseo when it has no Paseo tools", () => {
    const prompt = buildLiveVoicePrompt({ paseoToolsAvailable: false });

    expect(prompt).toContain("you cannot act on Paseo");
    expect(prompt).not.toMatch(/archive workspaces/i);
    // Describing current state is still honest and still on the table.
    expect(prompt).toContain("describe what is running from the state below");
    expect(prompt).toMatch(/never promise work/i);
  });

  it("keeps the local-only instructions for a legacy client without routing capability", () => {
    const prompt = buildLiveVoicePrompt({
      paseoToolsAvailable: true,
      crossHostRoutingAvailable: false,
    });

    expect(prompt).toContain("Your session has Paseo's tools for this machine");
    expect(prompt).toContain("cannot route work to another Paseo host");
    expect(prompt).not.toContain("run_paseo_tool_on_host");
  });

  it("names the read tools so answering a question does not cost a session a turn", () => {
    const prompt = buildLiveVoicePrompt({ paseoToolsAvailable: true });

    expect(prompt).toContain("get_agent_activity");
    expect(prompt).toContain("list_pending_permissions");
    expect(prompt).toMatch(/read it instead of prompting it/i);
  });

  it("says nothing about unrequested reports when the client is not sending them", () => {
    const prompt = buildLiveVoicePrompt({ paseoToolsAvailable: true });

    expect(prompt).not.toContain("Reports about work you did not start");
  });

  it("tells the model it may stay silent about work it did not start", () => {
    const prompt = buildLiveVoicePrompt({
      paseoToolsAvailable: true,
      ambientAgentReports: true,
    });

    expect(prompt).toContain("Reports about work you did not start");
    expect(prompt).toMatch(/silence is a valid response/i);
  });

  it("quotes the user's own instruction and puts it above the model's judgement", () => {
    const prompt = buildLiveVoicePrompt({
      paseoToolsAvailable: true,
      ambientAgentReports: true,
      ambientAgentGuidance: "Only interrupt me for permission requests.",
    });

    expect(prompt).toContain('"Only interrupt me for permission requests."');
    expect(prompt).toContain("Follow that over your own judgement");
  });

  it("drops guidance that has nothing to shape", () => {
    const prompt = buildLiveVoicePrompt({
      paseoToolsAvailable: true,
      ambientAgentReports: true,
      ambientAgentGuidance: "   ",
    });

    expect(prompt).toContain("Reports about work you did not start");
    expect(prompt).not.toContain("The user has told you how they want these handled");
  });

  it("bounds guidance so it cannot crowd out the state snapshot", () => {
    const prompt = buildLiveVoicePrompt({
      paseoToolsAvailable: true,
      ambientAgentReports: true,
      ambientAgentGuidance: "x".repeat(5_000),
    });

    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(10_000);
  });
});

describe("live voice initial items", () => {
  it("lists every session in one section, then the workspaces", () => {
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

    expect(items).toHaveLength(2);
    expect(items.every((item) => item.role === "developer")).toBe(true);
    // No session is singled out as "attached": the call belongs to the daemon.
    expect(items[0]?.text).toContain("Agent sessions on this daemon (2)");
    expect(items[0]?.text).toContain("Live voice work");
    expect(items[0]?.text).toContain("Docs pass");
    expect(items[1]?.text).toContain("Workspaces on this daemon (1)");
    expect(items[1]?.text).toContain("realtime-voice-actions");
  });

  it("omits sections that have nothing in them", () => {
    const items = buildLiveVoiceInitialItems(snapshot({ workspaces: [] }));

    expect(items).toHaveLength(1);
    expect(items[0]?.text).toContain("Agent sessions on this daemon (1)");
  });

  it("produces no items at all on a daemon with nothing running", () => {
    expect(buildLiveVoiceInitialItems(snapshot({ agents: [], workspaces: [] }))).toEqual([]);
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
            id: AGENT_ID,
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

    const context = await provider.build();

    expect(context?.prompt).toContain("You are the voice of Paseo");
    const text = (context?.initialItems ?? []).map((item) => item.text).join("\n");
    expect(text).toContain("Live voice work");
    expect(text).toContain("wrathful-seal");
    expect(text).not.toContain("Finished");
    expect(text).not.toContain("/work/old");
    expect(text).toContain("Agent sessions on this daemon (1)");
  });

  it("reflects a daemon that does not inject Paseo tools into sessions", async () => {
    const provider = new LiveVoiceDaemonContextProvider({
      agents: { hasPaseoMcpInjection: () => false, listAgents: () => [] },
      workspaces: { list: async () => [] },
      logger,
    });

    const context = await provider.build();

    expect(context?.prompt).toContain("you cannot act on Paseo");
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

    const context = await provider.build();

    const text = (context?.initialItems ?? []).map((item) => item.text).join("\n");
    expect(text).toContain("user-title");
    expect(text).not.toContain("derived-name");
  });
});

describe("start context", () => {
  it("pairs the prompt with the snapshot items", () => {
    const context = buildLiveVoiceStartContext(snapshot());

    expect(context.prompt).toBe(buildLiveVoicePrompt({ paseoToolsAvailable: true }));
    expect(context.initialItems.length).toBeGreaterThan(0);
  });
});
