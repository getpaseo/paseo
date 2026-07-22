import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClientSideConnection, InitializeResponse } from "@agentclientprotocol/sdk";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { buildProviderRegistry } from "../provider-registry.js";
import type { SessionStateResponse, SpawnedACPProcess } from "./acp-agent.js";
import {
  applyDiskMeta,
  createGrokExtensionNotificationParser,
  formatGrokSubagentTitle,
  GrokACPAgentClient,
  parseGrokExtensionNotification,
  parseGrokInitialCommands,
  parseGrokSessionListPage,
  transformGrokSessionResponse,
  writeGrokThinkingOption,
} from "./grok-acp-agent.js";

class ProbeGrokClient extends GrokACPAgentClient {
  constructor(private readonly probe: SpawnedACPProcess) {
    super({
      logger: createTestLogger(),
      command: ["grok", "agent", "stdio"],
      providerId: "grok",
      label: "Grok",
    });
  }

  protected override async spawnProcess(): Promise<SpawnedACPProcess> {
    return this.probe;
  }

  protected override async closeProbe(): Promise<void> {}
}

describe("GrokACPAgentClient", () => {
  test("exposes Grok initialize commands with command and skill metadata", () => {
    const response = {
      _meta: {
        grokShell: true,
        availableCommands: [
          {
            name: "/plan",
            description: "Enter plan mode",
            input: { hint: "goal" },
          },
          {
            name: "review",
            description: "Review a change",
            input: { unstructured: { hint: "path" } },
            _meta: { scope: "workspace", path: "/tmp/skills/review" },
          },
        ],
      },
    } as unknown as InitializeResponse;

    expect(parseGrokInitialCommands(response)).toEqual([
      {
        name: "plan",
        description: "Enter plan mode",
        argumentHint: "goal",
        kind: "command",
      },
      {
        name: "review",
        description: "Review a change",
        argumentHint: "path",
        kind: "skill",
      },
    ]);
  });

  test("maps Grok reasoning modes into the standard ACP thinking selector", () => {
    const response = {
      sessionId: "session-1",
      models: {
        currentModelId: "grok-build",
        availableModels: [
          {
            modelId: "grok-build",
            name: "Grok Build",
            _meta: {
              reasoningEffort: "xhigh",
              reasoningEfforts: [
                {
                  id: "minimal",
                  value: "minimal",
                  label: "Minimal",
                  description: "Fastest response",
                  default: false,
                },
                {
                  id: "deep",
                  value: "xhigh",
                  label: "Deep",
                  description: "More reasoning",
                  default: true,
                },
              ],
            },
          },
        ],
      },
      _meta: {
        "x.ai/sessionConfig": {
          options: [
            {
              id: "grok-build",
              category: "model",
              label: "Grok Build",
              selected: true,
            },
            {
              id: "minimal",
              category: "mode",
              label: "Minimal",
              description: "Fastest response",
              selected: false,
            },
            {
              id: "deep",
              category: "mode",
              label: "Deep",
              description: "More reasoning",
              selected: true,
            },
          ],
        },
      },
    } as unknown as SessionStateResponse;

    expect(transformGrokSessionResponse(response)).toMatchObject({
      sessionId: "session-1",
      configOptions: [
        {
          type: "select",
          id: "_paseo.grok.reasoning_effort",
          name: "Reasoning effort",
          category: "thought_level",
          currentValue: "xhigh",
          options: [
            { value: "minimal", name: "Minimal", description: "Fastest response" },
            { value: "xhigh", name: "Deep", description: "More reasoning" },
          ],
        },
      ],
    });
  });

  test("writes Grok reasoning effort through session/set_model metadata", async () => {
    const setSessionModel = vi.fn().mockResolvedValue({});

    await writeGrokThinkingOption({
      connection: {
        unstable_setSessionModel: setSessionModel,
      } as unknown as ClientSideConnection,
      sessionId: "session-1",
      modelId: "grok-build",
      thinkingOptionId: "xhigh",
    });

    expect(setSessionModel).toHaveBeenCalledWith({
      sessionId: "session-1",
      modelId: "grok-build",
      _meta: { reasoningEffort: "xhigh" },
    });
  });

  test("formatGrokSubagentTitle folds model and effort into the title", () => {
    expect(formatGrokSubagentTitle({ baseTitle: "Explore" })).toBe("Explore");
    expect(formatGrokSubagentTitle({ baseTitle: "Explore", model: "grok-4.5" })).toBe(
      "Explore · grok-4.5",
    );
    expect(
      formatGrokSubagentTitle({
        baseTitle: "Explore",
        model: "grok-4.5",
        thinkingOptionId: "low",
      }),
    ).toBe("Explore · grok-4.5 · low");
  });

  test("maps Grok subagent lifecycle updates", () => {
    const context = { provider: "grok", sessionId: "parent-1", turnId: null };

    expect(
      parseGrokExtensionNotification(
        "_x.ai/session_notification",
        {
          sessionId: "parent-1",
          update: {
            sessionUpdate: "subagent_spawned",
            subagent_id: "child-1",
            child_session_id: "child-1",
            subagent_type: "explore",
            description: "Map the provider registry",
            model: "grok-4.5",
          },
        },
        context,
      ),
    ).toEqual([
      {
        type: "provider_subagent",
        provider: "grok",
        event: {
          type: "upsert",
          id: "child-1",
          title: "Map the provider registry · grok-4.5",
          description: "explore",
          status: "running",
        },
      },
    ]);

    expect(
      parseGrokExtensionNotification(
        "_x.ai/session_notification",
        {
          sessionId: "parent-1",
          update: {
            sessionUpdate: "subagent_finished",
            subagent_id: "child-1",
            child_session_id: "child-1",
            status: "completed",
            output: "Found the registry branch.",
          },
        },
        context,
      ),
    ).toEqual([
      {
        type: "provider_subagent",
        provider: "grok",
        event: {
          type: "timeline",
          id: "child-1",
          item: { type: "assistant_message", text: "Found the registry branch." },
        },
      },
      {
        type: "provider_subagent",
        provider: "grok",
        event: {
          type: "upsert",
          id: "child-1",
          title: "Map the provider registry · grok-4.5",
          description: "explore",
          status: "completed",
        },
      },
    ]);
  });

  test("unwraps leader notifications and rejects another parent session", () => {
    const context = { provider: "grok", sessionId: "parent-1", turnId: null };
    const nestedParams = {
      method: "x.ai/session_notification",
      params: {
        sessionId: "parent-1",
        update: {
          sessionUpdate: "subagent_progress",
          subagent_id: "child-1",
          child_session_id: "child-session-1",
        },
      },
    };

    expect(
      parseGrokExtensionNotification("_x.ai/session_notification", nestedParams, context),
    ).toEqual([
      {
        type: "provider_subagent",
        provider: "grok",
        event: { type: "upsert", id: "child-session-1", status: "running" },
      },
    ]);
    expect(
      parseGrokExtensionNotification(
        "x.ai/session_notification",
        {
          ...nestedParams.params,
          sessionId: "parent-2",
        },
        context,
      ),
    ).toBeNull();
  });

  test("subagent display state is isolated across parser instances", () => {
    const parserA = createGrokExtensionNotificationParser();
    const parserB = createGrokExtensionNotificationParser();
    const context = { provider: "grok", sessionId: "parent-1", turnId: null };
    const spawnParams = {
      sessionId: "parent-1",
      update: {
        sessionUpdate: "subagent_spawned",
        subagent_id: "shared-child",
        child_session_id: "shared-child",
        subagent_type: "explore",
        description: "Owned by A",
        model: "grok-from-a",
      },
    };

    parserA("_x.ai/session_notification", spawnParams, context);

    // Parser B never saw the spawn — progress falls back to bare upsert (no title from A).
    expect(
      parserB(
        "_x.ai/session_notification",
        {
          sessionId: "parent-1",
          update: {
            sessionUpdate: "subagent_progress",
            subagent_id: "shared-child",
            child_session_id: "shared-child",
          },
        },
        context,
      ),
    ).toEqual([
      {
        type: "provider_subagent",
        provider: "grok",
        event: { type: "upsert", id: "shared-child", status: "running" },
      },
    ]);

    // Parser A still has the spawn state for finish title folding.
    const finished = parserA(
      "_x.ai/session_notification",
      {
        sessionId: "parent-1",
        update: {
          sessionUpdate: "subagent_finished",
          subagent_id: "shared-child",
          child_session_id: "shared-child",
          status: "completed",
        },
      },
      context,
    );
    expect(finished).toEqual([
      {
        type: "provider_subagent",
        provider: "grok",
        event: {
          type: "upsert",
          id: "shared-child",
          title: "Owned by A · grok-from-a",
          description: "explore",
          status: "completed",
        },
      },
    ]);
  });

  test("applyDiskMeta does not touch the filesystem once model and effort are set", () => {
    const readDisk = vi.fn(() => ({ model: "should-not-run", thinkingOptionId: "x" }));
    const state = {
      baseTitle: "Explore",
      description: "explore",
      model: "grok-4.5",
      thinkingOptionId: "low",
    };

    expect(applyDiskMeta(state, "child-already-resolved", readDisk)).toBe(false);
    expect(readDisk).not.toHaveBeenCalled();
    expect(state.model).toBe("grok-4.5");
    expect(state.thinkingOptionId).toBe("low");
  });

  test("maps Grok's richer session list envelope for import", () => {
    expect(
      parseGrokSessionListPage({
        result: {
          sessions: [
            {
              sessionId: "session-1",
              cwd: "/work/project",
              title: null,
              summary: "Fix the registry",
              firstPrompt: "Please fix the registry",
              createdAt: "2026-07-19T10:00:00.000Z",
              updatedAt: "2026-07-19T11:00:00.000Z",
              lastActiveAt: "2026-07-19T12:00:00.000Z",
              source: "local",
            },
          ],
          nextCursor: "cursor-2",
          _meta: { "x.ai/partial": { conversations: false } },
        },
        error: null,
      }),
    ).toEqual({
      sessions: [
        {
          providerHandleId: "session-1",
          cwd: "/work/project",
          title: "Fix the registry",
          firstPromptPreview: "Please fix the registry",
          lastPromptPreview: null,
          lastActivityAt: new Date("2026-07-19T12:00:00.000Z"),
        },
      ],
      nextCursor: "cursor-2",
    });
  });

  test("uses Grok session discovery with pagination and cwd filtering", async () => {
    const extMethod = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          sessions: [
            {
              sessionId: "session-1",
              cwd: "/work/project",
              summary: "First session",
              lastActiveAt: "2026-07-19T12:00:00.000Z",
            },
          ],
          nextCursor: "cursor-2",
        },
        error: null,
      })
      .mockResolvedValueOnce({
        result: {
          sessions: [
            {
              sessionId: "session-2",
              cwd: "/work/project",
              summary: "Second session",
              lastActiveAt: "2026-07-19T13:00:00.000Z",
            },
          ],
        },
        error: null,
      });
    const client = new ProbeGrokClient({
      initialize: { _meta: { grokShell: true } },
      connection: { extMethod },
    } as unknown as SpawnedACPProcess);

    const sessions = await client.listImportableSessions({
      cwd: "/work/project",
      limit: 2,
    });

    expect(sessions.map((session) => session.providerHandleId)).toEqual(["session-1", "session-2"]);
    expect(extMethod).toHaveBeenNthCalledWith(1, "_x.ai/session/list", {
      cwd: "/work/project",
      limit: 2,
    });
    expect(extMethod).toHaveBeenNthCalledWith(2, "_x.ai/session/list", {
      cwd: "/work/project",
      cursor: "cursor-2",
      limit: 2,
    });
  });
  test("routes catalog Grok through auth-aware diagnostics without reading credentials", async () => {
    const grokHome = await mkdtemp(path.join(tmpdir(), "paseo-grok-auth-"));
    try {
      await writeFile(path.join(grokHome, "auth.json"), '{"access_token":"do-not-log"}');
      const logger = createTestLogger();
      const registry = buildProviderRegistry(logger, {
        providerOverrides: {
          grok: {
            extends: "acp",
            label: "Grok",
            command: [path.join(grokHome, "missing-grok"), "agent", "stdio"],
            env: { GROK_HOME: grokHome },
          },
        },
      });
      const client = registry.grok.createClient(logger);

      const { diagnostic } = await client.getDiagnostic!();

      expect(diagnostic).toContain(
        `Authentication: credentials found at ${path.join(grokHome, "auth.json")}`,
      );
      expect(diagnostic).not.toContain("do-not-log");
    } finally {
      await rm(grokHome, { recursive: true, force: true });
    }
  });

  test.each(["GROK_AUTH_PROVIDER_COMMAND", "GROK_DEPLOYMENT_KEY"] as const)(
    "recognizes %s without logging its credential value",
    async (envKey) => {
      const credential = "do-not-log-auth-value";
      const client = new GrokACPAgentClient({
        logger: createTestLogger(),
        command: ["/paseo-missing-grok", "agent", "stdio"],
        providerId: "grok",
        label: "Grok",
        env: { [envKey]: credential },
      });

      const { diagnostic } = await client.getDiagnostic();

      expect(diagnostic).toContain(`Authentication: configured via ${envKey}`);
      expect(diagnostic).not.toContain(credential);
    },
  );
});
