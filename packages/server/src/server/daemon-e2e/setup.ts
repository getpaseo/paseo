import "dotenv/config";
import { beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
import { agentConfigs } from "./agent-configs.js";

// Re-export for backward compatibility - prefer using agentConfigs instead
export const CODEX_TEST_MODEL = agentConfigs.codex.model;
export const CODEX_TEST_THINKING_OPTION_ID = agentConfigs.codex.thinkingOptionId;

// Re-export agent configs
export {
  agentConfigs,
  getFullAccessConfig,
  getAskModeConfig,
  allProviders,
  type AgentProvider,
  type AgentTestConfig,
} from "./agent-configs.js";

export function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

// Shared daemon context for all e2e tests
let sharedCtx: DaemonTestContext | null = null;

export function getTestContext(): DaemonTestContext {
  if (!sharedCtx) {
    throw new Error("Test context not initialized. Did you call setupDaemonE2E()?");
  }
  return sharedCtx;
}

export function setupDaemonE2E(): void {
  beforeAll(async () => {
    sharedCtx = await createDaemonTestContext();
  }, 30000);

  afterAll(async () => {
    if (sharedCtx) {
      await sharedCtx.cleanup();
      sharedCtx = null;
    }
  }, 60000);
}
