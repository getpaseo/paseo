import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

import { Session, type SessionOptions } from "./session.js";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import type { RecentDirectorySource } from "../utils/recent-directory-sources/index.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import {
  createMessageReceiptsStub,
  createProviderSnapshotManagerStub,
  createTestCreationService,
} from "./test-utils/session-stubs.js";

interface Harness {
  session: Session;
  emitted: SessionOutboundMessage[];
}

function createHarness(recentDirectorySources: readonly RecentDirectorySource[]): Harness {
  const emitted: SessionOutboundMessage[] = [];
  const logger = {
    child: () => logger,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const session = new Session({
    messageReceipts: createMessageReceiptsStub(),
    creationService: createTestCreationService(),
    clientId: "test",
    permissions: OWNER_PERMISSIONS,
    appVersion: null,
    onMessage: (m) => emitted.push(m),
    logger: createStub<SessionOptions["logger"]>(logger),
    downloadTokenStore: createStub<SessionOptions["downloadTokenStore"]>({}),
    pushNotifications: createStub<SessionOptions["pushNotifications"]>({}),
    paseoHome: mkdtempSync(path.join(tmpdir(), "paseo-directory-test-")),
    recentDirectorySources,
    agentManager: createStub<SessionOptions["agentManager"]>({
      subscribe: () => () => {},
      listAgents: () => [],
      getAgent: () => null,
    }),
    agentStorage: createStub<SessionOptions["agentStorage"]>({
      list: async () => [],
      get: async () => null,
    }),
    projectRegistry: createStub<SessionOptions["projectRegistry"]>({
      subscribeToMutations: () => () => {},
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => [],
      get: async () => null,
    }),
    workspaceRegistry: createStub<SessionOptions["workspaceRegistry"]>({
      subscribeToMutations: () => () => {},
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => [],
      get: async () => null,
    }),
    filesystem: { isDirectory: async () => true },
    scheduleService: createStub<SessionOptions["scheduleService"]>({}),
    checkoutDiffManager: createStub<SessionOptions["checkoutDiffManager"]>({
      subscribe: async () => ({
        initial: { cwd: "/tmp", files: [], error: null },
        unsubscribe: () => {},
      }),
      scheduleRefreshForCwd: () => {},
      onWorkspaceStateMayHaveChanged: () => {},
      invalidateForge: () => {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      }),
      dispose: () => {},
    }),
    workspaceGitService: createNoopWorkspaceGitService(),
    daemonConfigStore: createStub<SessionOptions["daemonConfigStore"]>({
      get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
      onChange: () => () => {},
    }),
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    terminalManager: null,
  });

  return { session, emitted };
}

async function requestSuggestions(
  session: Session,
  emitted: SessionOutboundMessage[],
  request: { query: string; limit?: number; requestId: string },
): Promise<Extract<SessionOutboundMessage, { type: "directory_suggestions_response" }>["payload"]> {
  await asInternals<{ handleMessage(m: unknown): Promise<unknown> }>(session).handleMessage({
    type: "directory_suggestions_request",
    includeFiles: false,
    includeDirectories: true,
    ...request,
  });
  const response = emitted.find(
    (message) =>
      message.type === "directory_suggestions_response" &&
      message.payload.requestId === request.requestId,
  );
  if (!response || response.type !== "directory_suggestions_response") {
    throw new Error("no directory_suggestions_response emitted");
  }
  return response.payload;
}

describe("Session directory suggestions with a recent source", () => {
  let home: string;

  beforeEach(() => {
    home = realpathSync.native(mkdtempSync(path.join(tmpdir(), "paseo-directory-home-")));
    mkdirSync(path.join(home, "a", "hertzbeat"), { recursive: true });
    mkdirSync(path.join(home, "Documents", "dev", "github", "hertzbeat"), { recursive: true });
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  test("puts a visited directory ahead of an equal-strength scan match", async () => {
    const visited = path.join(home, "Documents", "dev", "github", "hertzbeat");
    const source: RecentDirectorySource = {
      id: "stub",
      isAvailable: () => true,
      query: async () => [visited],
    };
    const { session, emitted } = createHarness([source]);

    const payload = await requestSuggestions(session, emitted, {
      query: "hertzbeat",
      limit: 20,
      requestId: "req-recent",
    });

    expect(payload.error).toBeNull();
    expect(payload.entries[0]).toEqual({ path: visited, kind: "directory" });
    expect(payload.directories[0]).toBe(visited);
  });

  test("returns only scan results when no recent source is configured", async () => {
    const { session, emitted } = createHarness([]);

    const payload = await requestSuggestions(session, emitted, {
      query: "hertzbeat",
      limit: 20,
      requestId: "req-scan",
    });

    expect(payload.error).toBeNull();
    expect(payload.directories).toEqual(
      expect.arrayContaining([
        path.join(home, "a", "hertzbeat"),
        path.join(home, "Documents", "dev", "github", "hertzbeat"),
      ]),
    );
  });
});
