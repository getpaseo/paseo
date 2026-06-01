import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Logger } from "pino";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  ListModelsOptions,
  ListModesOptions,
  AgentSlashCommand,
} from "../agent-sdk-types.js";
import { runProviderTurn } from "./provider-runner.js";
import { isCommandAvailable } from "../../../utils/executable.js";

const ANTIGRAVITY_PROVIDER = "antigravity";
const ANTIGRAVITY_BINARY = process.env.ANTIGRAVITY_COMMAND ?? "agy";
const CONVERSATIONS_DIR = join(homedir(), ".gemini", "antigravity-cli", "conversations");

interface AntigravitySettings {
  model?: string;
  [key: string]: unknown;
}

function updateSettingsModel(model: string, logger: Logger) {
  const settingsPath = join(homedir(), ".gemini", "antigravity-cli", "settings.json");
  try {
    let settings: AntigravitySettings = {};
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as AntigravitySettings;
    }
    if (settings.model !== model) {
      settings.model = model;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
      logger.info({ model }, "antigravity: updated model in settings.json");
    }
  } catch (err) {
    logger.error({ err }, "antigravity: failed to update settings.json model");
  }
}

export const ANTIGRAVITY_MODE_DEFAULT = "default";
export const ANTIGRAVITY_MODE_BYPASS = "bypass";

const MODES: AgentMode[] = [
  {
    id: ANTIGRAVITY_MODE_DEFAULT,
    label: "Default",
    description: "Ask for permission before executing tools",
    icon: "ShieldAlert",
    colorTier: "moderate",
  },
  {
    id: ANTIGRAVITY_MODE_BYPASS,
    label: "Full Access",
    description: "Auto-approve all tool calls (skips permission prompts)",
    icon: "ShieldOff",
    colorTier: "dangerous",
    isUnattended: true,
  },
];

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

function listConversationIds(): Set<string> {
  try {
    const files = readdirSync(CONVERSATIONS_DIR);
    return new Set(files.filter((f) => f.endsWith(".pb")).map((f) => f.slice(0, -3)));
  } catch {
    return new Set();
  }
}

function promptToText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
}

interface AntigravityAgentSessionOptions {
  conversationId: string | null;
  modeId: string;
  config: AgentSessionConfig;
  logger: Logger;
}

class AntigravityAgentSession implements AgentSession {
  readonly provider = ANTIGRAVITY_PROVIDER;
  readonly capabilities = CAPABILITIES;

  private _conversationId: string | null;
  private _modeId: string;
  private _config: AgentSessionConfig;
  private _logger: Logger;
  private _subscribers: Set<(event: AgentStreamEvent) => void> = new Set();
  private _activeProcess: ChildProcess | null = null;
  private _activeTurnId: string | null = null;
  private _sessionId: string = randomUUID();
  /**
   * Accumulated raw stdout from all prior turns. Because `agy --conversation`
   * replays the full conversation history on every invocation, we strip this
   * prefix to extract only the new response (same technique as openab/agy-acp).
   */
  private _prevOutput: string = "";

  constructor(options: AntigravityAgentSessionOptions) {
    this._conversationId = options.conversationId;
    this._modeId = options.modeId;
    this._config = options.config;
    this._logger = options.logger;
  }

  get id(): string | null {
    return this._conversationId;
  }

  private emit(event: AgentStreamEvent): void {
    for (const sub of this._subscribers) {
      sub(event);
    }
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this._subscribers.add(callback);
    return () => this._subscribers.delete(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    // No history retrieval support for agy
  }

  async startTurn(
    prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    const turnId = randomUUID();
    this._activeTurnId = turnId;

    // Update settings.json with the chosen model before spawning agy
    const model =
      this._config.model === "gemini"
        ? "Gemini 3.5 Flash (Medium)"
        : (this._config.model ?? "Gemini 3.5 Flash (Medium)");
    updateSettingsModel(model, this._logger);

    const args: string[] = [];
    if (this._conversationId) {
      args.push("--conversation", this._conversationId);
    }
    if (this._modeId === ANTIGRAVITY_MODE_BYPASS) {
      args.push("--dangerously-skip-permissions");
      if (this._config.cwd) {
        args.push("--add-dir", this._config.cwd);
      }
    }
    args.push("--print", promptToText(prompt));

    // Snapshot existing conversations to detect the newly created one.
    const preConversations = listConversationIds();

    this.emit({ type: "turn_started", provider: ANTIGRAVITY_PROVIDER, turnId });

    const proc = spawn(ANTIGRAVITY_BINARY, args, {
      cwd: this._config.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this._activeProcess = proc;
    // Drain stderr to prevent the OS pipe buffer from filling up and
    // blocking the child process (64 KB on Linux). We don't surface it
    // to the user but could log it at trace level in future.
    proc.stderr?.resume();

    let fullOutput = "";
    let deltaText = "";
    const prevOutput = this._prevOutput;
    let mismatchDetected = false;
    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

    rl.on("line", (line) => {
      if (this._activeTurnId !== turnId) {
        return;
      }
      fullOutput += `${line}\n`;
      // While still buffering the prior-turn replay, don't emit anything.
      if (fullOutput.length < prevOutput.length) {
        return;
      }
      // Once we have enough output to compare, check the prefix.
      if (!fullOutput.startsWith(prevOutput)) {
        // agy output is not append-only — suppress streaming to avoid
        // broadcasting the full conversation history as the new response.
        mismatchDetected = true;
        return;
      }
      // Strip the replayed prior turns so only the new response is shown.
      const candidate = fullOutput.slice(prevOutput.length).trimStart();
      if (candidate === deltaText) {
        return;
      }
      deltaText = candidate;
      this.emit({
        type: "timeline",
        item: { type: "assistant_message", text: deltaText },
        provider: ANTIGRAVITY_PROVIDER,
        turnId,
        timestamp: new Date().toISOString(),
      });
    });

    proc.on("close", (code) => {
      if (this._activeTurnId !== turnId) {
        return;
      }
      this._activeProcess = null;

      if (!this._conversationId) {
        const postConversations = listConversationIds();
        const newIds = [...postConversations].filter((id) => !preConversations.has(id));
        if (newIds.length === 1) {
          this._conversationId = newIds[0];
        } else if (newIds.length > 1) {
          // Concurrent sessions created multiple .pb files; refuse to bind to avoid
          // associating with the wrong conversation (same guard as openab/agy-acp).
          this._logger.warn(
            { newIds },
            "antigravity: multiple new conversation files appeared; cannot determine which belongs to this session. Session continuity disabled.",
          );
        }
      }

      if (mismatchDetected) {
        // agy stdout was not append-only — delta extraction failed. Fail the
        // turn so the user gets a clear error rather than seeing replayed history.
        // Do NOT update _prevOutput: stale baseline is better than a corrupt one.
        this._logger.warn(
          "antigravity: agy stdout was not append-only; turn failed to avoid replaying prior conversation.",
        );
        this.emit({
          type: "turn_failed",
          provider: ANTIGRAVITY_PROVIDER,
          error: "agy output was not append-only; session continuity may be broken",
          turnId,
        });
        return;
      }

      // Update the accumulated-output baseline for the next turn's delta extraction.
      this._prevOutput = fullOutput;

      if (code === 0 || code === null) {
        this.emit({ type: "turn_completed", provider: ANTIGRAVITY_PROVIDER, turnId });
      } else {
        this.emit({
          type: "turn_failed",
          provider: ANTIGRAVITY_PROVIDER,
          error: `agy exited with code ${code}`,
          turnId,
        });
      }
    });

    proc.on("error", (err) => {
      if (this._activeTurnId !== turnId) {
        return;
      }
      this._activeProcess = null;
      this.emit({
        type: "turn_failed",
        provider: ANTIGRAVITY_PROVIDER,
        error: `Failed to spawn agy: ${err.message}`,
        turnId,
      });
    });

    return { turnId };
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, opts) => this.startTurn(p, opts),
      subscribe: (cb) => this.subscribe(cb),
      getSessionId: () => this._conversationId ?? this._sessionId,
    });
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: ANTIGRAVITY_PROVIDER,
      sessionId: this._conversationId,
      model:
        this._config.model === "gemini"
          ? "Gemini 3.5 Flash (Medium)"
          : (this._config.model ?? "Gemini 3.5 Flash (Medium)"),
      modeId: this._modeId,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return MODES;
  }

  async getCurrentMode(): Promise<string | null> {
    return this._modeId;
  }

  async setMode(modeId: string): Promise<void> {
    this._modeId = modeId;
    this.emit({
      type: "mode_changed",
      provider: ANTIGRAVITY_PROVIDER,
      currentModeId: modeId,
      availableModes: MODES,
    });
  }

  async setModel(modelId: string | null): Promise<void> {
    const normalizedModelId =
      typeof modelId === "string" && modelId.trim().length > 0 ? modelId : null;
    this._config.model = normalizedModelId ?? undefined;
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(
    _requestId: string,
    _response: AgentPermissionResponse,
  ): Promise<void> {}

  describePersistence(): AgentPersistenceHandle | null {
    if (!this._conversationId) {
      return null;
    }
    return {
      provider: ANTIGRAVITY_PROVIDER,
      sessionId: this._sessionId,
      nativeHandle: this._conversationId,
    };
  }

  async interrupt(): Promise<void> {
    if (this._activeProcess) {
      this._activeProcess.kill("SIGINT");
    }
  }

  async close(): Promise<void> {
    if (this._activeProcess) {
      this._activeProcess.kill();
    }
    this._subscribers.clear();
  }
}

interface AntigravityAgentClientOptions {
  logger: Logger;
}

export class AntigravityAgentClient implements AgentClient {
  readonly provider = ANTIGRAVITY_PROVIDER;
  readonly capabilities = CAPABILITIES;
  private readonly logger: Logger;

  constructor(options: AntigravityAgentClientOptions) {
    this.logger = options.logger;
  }

  async isAvailable(): Promise<boolean> {
    return isCommandAvailable(ANTIGRAVITY_BINARY);
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    const available = await this.isAvailable();
    if (!available) {
      return {
        diagnostic: `Antigravity: '${ANTIGRAVITY_BINARY}' binary not found. Install from https://antigravity.google/cli or run: curl -fsSL https://antigravity.google/cli/install.sh | bash`,
      };
    }
    return { diagnostic: `Antigravity: '${ANTIGRAVITY_BINARY}' binary found and ready.` };
  }

  async listModels(_options: ListModelsOptions): Promise<AgentModelDefinition[]> {
    return [
      {
        provider: ANTIGRAVITY_PROVIDER,
        id: "Gemini 3.5 Flash (Medium)",
        label: "Gemini 3.5 Flash (Medium)",
        description: "Google Gemini 3.5 Flash (Medium) via Antigravity CLI",
        isDefault: true,
      },
      {
        provider: ANTIGRAVITY_PROVIDER,
        id: "Gemini 3.5 Flash (High)",
        label: "Gemini 3.5 Flash (High)",
        description: "Google Gemini 3.5 Flash (High) via Antigravity CLI",
      },
      {
        provider: ANTIGRAVITY_PROVIDER,
        id: "Gemini 3.5 Flash (Low)",
        label: "Gemini 3.5 Flash (Low)",
        description: "Google Gemini 3.5 Flash (Low) via Antigravity CLI",
      },
      {
        provider: ANTIGRAVITY_PROVIDER,
        id: "Gemini 3.1 Pro (Low)",
        label: "Gemini 3.1 Pro (Low)",
        description: "Google Gemini 3.1 Pro (Low) via Antigravity CLI",
      },
      {
        provider: ANTIGRAVITY_PROVIDER,
        id: "Gemini 3.1 Pro (High)",
        label: "Gemini 3.1 Pro (High)",
        description: "Google Gemini 3.1 Pro (High) via Antigravity CLI",
      },
      {
        provider: ANTIGRAVITY_PROVIDER,
        id: "Claude Sonnet 4.6 (Thinking)",
        label: "Claude Sonnet 4.6 (Thinking)",
        description: "Anthropic Claude Sonnet 4.6 (Thinking) via Antigravity CLI",
      },
      {
        provider: ANTIGRAVITY_PROVIDER,
        id: "Claude Opus 4.6 (Thinking)",
        label: "Claude Opus 4.6 (Thinking)",
        description: "Anthropic Claude Opus 4.6 (Thinking) via Antigravity CLI",
      },
      {
        provider: ANTIGRAVITY_PROVIDER,
        id: "GPT-OSS 120B (Medium)",
        label: "GPT-OSS 120B (Medium)",
        description: "GPT-OSS 120B (Medium) via Antigravity CLI",
      },
    ];
  }

  async listModes(_options: ListModesOptions): Promise<AgentMode[]> {
    return MODES;
  }

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return new AntigravityAgentSession({
      conversationId: null,
      modeId: config.modeId ?? ANTIGRAVITY_MODE_DEFAULT,
      config,
      logger: this.logger,
    });
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const baseConfig: AgentSessionConfig = {
      provider: ANTIGRAVITY_PROVIDER,
      cwd: overrides?.cwd ?? homedir(),
      ...overrides,
    };
    return new AntigravityAgentSession({
      conversationId: handle.nativeHandle ?? null,
      modeId: baseConfig.modeId ?? ANTIGRAVITY_MODE_DEFAULT,
      config: baseConfig,
      logger: this.logger,
    });
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return [
      {
        name: "explain",
        description: "Explain code or active context",
        argumentHint: "[code/topic]",
      },
      {
        name: "usage",
        description: "Show model quota and usage status",
        argumentHint: "",
      },
      {
        name: "config",
        description: "Show active agent settings",
        argumentHint: "",
      },
      {
        name: "permissions",
        description: "Manage tool execution permission rules",
        argumentHint: "",
      },
    ];
  }
}
