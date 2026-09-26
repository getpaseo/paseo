import { structuredOutput } from "./structured-output.js";
import type { SessionInfo, SessionMessageInfo } from "@opencode/client";

import { randomUUID } from "node:crypto";

import type {
  AgentPromptInput,
  AgentRunOptions,
  AgentStreamEvent,
  SteerActiveTurnOptions,
  SteerResult,
} from "../../../agent-sdk-types.js";

import { toDiagnosticErrorMessage } from "../../diagnostic-utils.js";

import { renderPromptAttachmentAsText } from "../../../prompt-attachments.js";

import { usageFromV2 } from "./mapping.js";

import { commands } from "./commands.js";

import type { V2Api } from "./api.js";
interface TurnSnapshot {
  info: SessionInfo;
  history: SessionMessageInfo[];
}
interface TurnOptions {
  client: V2Api;
  id: string;
  cwd: string;
  signal: AbortSignal;
  emit(event: AgentStreamEvent): void;
  reconcile(): Promise<TurnSnapshot>;
  clearPermissions(): Promise<void>;
}
interface Turn {
  output?: ReturnType<typeof structuredOutput>;
  id: string;
  submitted: Promise<void>;
  completion: Promise<void>;
}

export class SessionTurns {
  private turn: Turn | null = null;
  private stopping: Promise<void> | null = null;
  private stopFailed = false;
  executionError: string | null = null;
  constructor(private readonly options: TurnOptions) {}
  get id() {
    return this.turn?.id;
  }
  get hasStructuredOutput() {
    return Boolean(this.turn?.output);
  }
  fail(error: Error) {
    const turn = this.turn;
    this.turn = null;
    if (turn)
      this.options.emit({
        type: "turn_failed",
        provider: "opencode",
        turnId: turn.id,
        error: error.message,
      });
  }
  async startTurn(prompt: AgentPromptInput, options?: AgentRunOptions) {
    await this.stopping;
    if (this.options.signal.aborted) throw new Error("OpenCode session is closed");
    if (this.turn) throw new Error("OpenCode session already has an active turn");
    this.executionError = null;
    const id = randomUUID();
    const input = this.promptInput(prompt);
    let accept!: () => void;
    const submitted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const output =
      options?.outputSchema === undefined ? undefined : structuredOutput(options.outputSchema);
    const completion = this.submit(id, input, accept, options, output);
    this.turn = { id, submitted, completion, output };
    return { turnId: id };
  }
  private async submit(
    id: string,
    input: ReturnType<SessionTurns["promptInput"]>,
    accept: () => void,
    options?: AgentRunOptions,
    output?: ReturnType<typeof structuredOutput>,
  ) {
    // Defer until startTurn publishes ownership, including for immediately resolved test transports.
    await Promise.resolve();
    this.options.emit({ type: "turn_started", provider: "opencode", turnId: id });
    try {
      await this.dispatch(input, options, output);
      accept();
      await this.finish(id);
    } catch (error) {
      if (this.turn?.id === id) {
        this.turn = null;
        this.options.emit({
          type: "turn_failed",
          provider: "opencode",
          turnId: id,
          error: toDiagnosticErrorMessage(error),
        });
      }
    } finally {
      accept();
    }
  }
  private async dispatch(
    input: ReturnType<SessionTurns["promptInput"]>,
    options?: AgentRunOptions,
    output?: ReturnType<typeof structuredOutput>,
  ) {
    const command = input.text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (command?.[1] === "compact" || command?.[1] === "summarize") {
      await this.options.client.session.compact({ sessionID: this.options.id });
      return;
    }
    const selected = command
      ? (await commands(this.options.client, this.options.cwd)).find(
          (item) => item.name === command[1],
        )
      : undefined;
    if (selected && selected.kind !== "skill") {
      await this.options.client.session.command({
        sessionID: this.options.id,
        name: selected.name,
        text: command?.[2] ?? "",
        files: input.files,
      });
      return;
    }
    await this.options.client.session.prompt({
      sessionID: this.options.id,
      ...input,
      ...(selected?.kind === "skill"
        ? {
            skills: [{ id: selected.name }],
            text: command?.[2] ?? `Use the ${selected.name} skill.`,
          }
        : {}),
      metadata: {
        ...(options?.clientMessageId ? { paseoClientMessageId: options.clientMessageId } : {}),
        ...(output ? { paseoOutputSchema: output.schema } : {}),
      },
    });
  }
  private async finish(id: string) {
    await this.options.client.session.wait(
      { sessionID: this.options.id },
      { signal: this.options.signal },
    );
    const { info, history } = await this.options.reconcile();
    if (this.turn?.id !== id) return;
    if (info.outcome !== "failed" && info.outcome !== "interrupted")
      this.turn.output?.assert(history);
    const failure =
      info.outcome === "failed" ? (this.executionError ?? (await this.readExecutionError())) : null;
    if (this.turn?.id !== id) return;
    this.turn = null;
    if (info.outcome === "interrupted")
      this.options.emit({
        type: "turn_canceled",
        provider: "opencode",
        turnId: id,
        reason: "OpenCode interrupted execution",
      });
    else if (info.outcome === "failed")
      this.options.emit({
        type: "turn_failed",
        provider: "opencode",
        turnId: id,
        error: failure ?? "OpenCode execution failed",
      });
    else
      this.options.emit({
        type: "turn_completed",
        provider: "opencode",
        turnId: id,
        usage: usageFromV2(info),
      });
  }
  private async readExecutionError(): Promise<string> {
    let message = "OpenCode execution failed";
    for await (const event of this.options.client.session.log(
      { sessionID: this.options.id, follow: false },
      { signal: this.options.signal },
    )) {
      if (event.type === "session.execution.failed") message = event.data.error.message;
    }
    return message;
  }
  private promptInput(prompt: AgentPromptInput) {
    if (typeof prompt === "string") return { text: prompt, files: [] };
    const text: string[] = [];
    const files: Array<{ uri: string }> = [];
    for (const part of prompt) {
      if (part.type === "text") text.push(part.text);
      else if (part.type === "image")
        files.push({ uri: `data:${part.mimeType};base64,${part.data}` });
      else text.push(renderPromptAttachmentAsText(part));
    }
    return { text: text.join("\n"), files };
  }
  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    if (this.turn?.id !== options.expectedTurnId || this.stopping) return { status: "unavailable" };
    await this.options.client.session.prompt({
      sessionID: this.options.id,
      ...this.promptInput(prompt),
      delivery: "steer",
      metadata: options.clientMessageId
        ? { paseoClientMessageId: options.clientMessageId }
        : undefined,
    });
    if (options.clearPendingPermissions) await this.options.clearPermissions();
    return { status: "accepted" };
  }
  async interrupt() {
    if (!this.stopping || this.stopFailed) {
      this.stopFailed = false;
      const turn = this.turn;
      const stop = (async () => {
        // A stop sent before the queued prompt is accepted would interrupt an idle session.
        await turn?.submitted;
        await this.options.client.session.interrupt({ sessionID: this.options.id });
        await turn?.completion;
      })();
      this.stopping = stop;
      try {
        await stop;
        this.stopping = null;
      } catch (error) {
        this.stopFailed = true;
        throw error;
      }
    } else await this.stopping;
  }
  observeActiveTurn() {
    if (this.turn) return;
    const id = randomUUID();
    const completion = Promise.resolve()
      .then(() => this.finish(id))
      .catch((error: unknown) => {
        if (this.turn?.id !== id) return;
        this.turn = null;
        this.options.emit({
          type: "turn_failed",
          provider: "opencode",
          turnId: id,
          error: toDiagnosticErrorMessage(error),
        });
      });
    this.turn = { id, submitted: Promise.resolve(), completion };
    this.options.emit({ type: "turn_started", provider: "opencode", turnId: id });
  }
}
