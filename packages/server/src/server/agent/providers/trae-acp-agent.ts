import type { Logger } from "pino";

import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { forkTraeSessionFiles, resolveTraeSessionsDir } from "./trae-session-fork.js";
import type {
  AgentForkOptions,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
} from "../agent-sdk-types.js";

interface TraeACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

const TRAE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;

export class TraeACPAgentClient extends GenericACPAgentClient {
  constructor(options: TraeACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      // traecli publishes slash commands and skills asynchronously via available_commands_update.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: TRAE_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
      // Trae supports a real provider-native fork: we duplicate its on-disk
      // session directory into a new id and load it (see forkSession).
      capabilityOverrides: { supportsFork: true },
    });
  }

  /**
   * Real Trae fork: duplicate the persisted session directory on disk into a
   * NEW session id (full conversation context preserved via the events log),
   * then load the forked id as an independent session. The original session is
   * never mutated, so the two run in parallel.
   *
   * `upToMessageId` is accepted for interface compatibility but not used to
   * truncate: Trae's event log is an opaque replay stream that cannot be safely
   * truncated, so the fork duplicates the whole conversation and the branch
   * continues from its end.
   */
  async forkSession(
    handle: AgentPersistenceHandle,
    _options: AgentForkOptions,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const newId = forkTraeSessionFiles({
      sessionsDir: resolveTraeSessionsDir(),
      sourceId: handle.sessionId,
      titleSuffix: " (fork)",
    });
    const forkedHandle: AgentPersistenceHandle = {
      ...handle,
      sessionId: newId,
      nativeHandle: newId,
    };
    return this.resumeSession(forkedHandle, overrides, launchContext);
  }
}
