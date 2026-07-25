import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import pino from "pino";

import type {
  AgentPersistenceHandle,
  AgentPermissionResponse,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../../../agent-sdk-types.js";
import type { PaseoToolCatalog } from "../../../tools/types.js";
import {
  OmpAgentClient,
  OmpAgentSession,
  type OmpNoTurnScheduler,
  type OmpProviderIdleScheduler,
} from "../agent.js";
import type { OmpAgentMessage, OmpRpcSlashCommand } from "../rpc-types.js";
import { FakeOmp } from "./fake-omp.js";

const CWD = "/tmp/paseo-omp-agent-test";

interface OmpHistoryMessage {
  id: string;
  text: string;
}

interface OmpResumeHistory {
  user: OmpHistoryMessage;
  assistant: OmpHistoryMessage;
}

async function writeOmpHistory(history: OmpResumeHistory): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-omp-resume-"));
  const sessionFile = join(directory, "session.jsonl");
  const entries = [
    { type: "session", id: "session-root", parentId: null },
    {
      type: "message",
      id: history.user.id,
      parentId: "session-root",
      message: { role: "user", content: history.user.text },
    },
    {
      type: "message",
      id: history.assistant.id,
      parentId: history.user.id,
      message: {
        role: "assistant",
        content: [{ type: "text", text: history.assistant.text }],
        responseId: history.assistant.id,
      },
    },
  ];
  await writeFile(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
  return sessionFile;
}

export class OmpHarness {
  private readonly omp = new FakeOmp();
  private readonly client: OmpAgentClient;
  private readonly events: AgentStreamEvent[] = [];
  private session: OmpAgentSession | null = null;

  constructor(
    options: {
      providerIdleScheduler?: OmpProviderIdleScheduler;
      noTurnScheduler?: OmpNoTurnScheduler;
    } = {},
  ) {
    this.client = new OmpAgentClient({
      logger: pino({ level: "silent" }),
      runtime: this.omp,
      providerIdleScheduler: options.providerIdleScheduler,
      noTurnScheduler: options.noTurnScheduler,
    });
  }

  queueCommands(commands: OmpRpcSlashCommand[]): void {
    this.omp.queueCommands(commands);
  }

  failEventSubscription(error: Error): void {
    this.omp.failNextSubagentSubscription("events", error);
  }

  async start(
    config: Partial<AgentSessionConfig> = {},
    paseoTools?: PaseoToolCatalog,
  ): Promise<void> {
    const session = await this.client.createSession(
      { provider: "omp", cwd: CWD, ...config },
      paseoTools ? { paseoTools } : undefined,
    );
    if (!(session instanceof OmpAgentSession)) {
      throw new Error("OMP client returned a non-OMP session");
    }
    this.session = session;
    this.session.subscribe((event) => this.events.push(event));
  }

  async resume(
    history: OmpResumeHistory,
    overrides: Partial<AgentSessionConfig> = {},
  ): Promise<void> {
    const sessionFile = await writeOmpHistory(history);
    const handle: AgentPersistenceHandle = {
      provider: "omp",
      sessionId: "omp-session-1",
      nativeHandle: sessionFile,
      metadata: { cwd: CWD },
    };
    const session = await this.client.resumeSession(handle, overrides);
    if (!(session instanceof OmpAgentSession)) {
      throw new Error("OMP client returned a non-OMP session");
    }
    this.session = session;
    this.session.subscribe((event) => this.events.push(event));
  }

  launchConfiguration(): {
    cwd: string;
    protocolMode?: string;
    modeId?: string;
    session?: string;
    argv: string[];
  } {
    const launch = this.omp.recordedLaunches[0];
    if (!launch) throw new Error("OMP harness has not launched");
    return {
      cwd: launch.cwd,
      protocolMode: launch.protocolMode,
      modeId: launch.modeId,
      ...(launch.session ? { session: launch.session } : {}),
      argv: launch.argv,
    };
  }

  registeredHostTools() {
    return this.omp.latestSession().hostToolSetRequests;
  }

  capabilities() {
    return this.client.capabilities;
  }

  async runPrompt(
    input: string,
    output: string,
    providerStatesAfterEnd: Array<{ isStreaming: boolean; isCompacting: boolean }> = [],
  ): Promise<unknown> {
    const session = this.requireSession();
    const promptStarted = this.omp.latestSession().nextPrompt();
    const run = session.run(input);
    await promptStarted;
    const runtime = this.omp.latestSession();
    runtime.beginTurn();
    runtime.acceptPrompt(input, "user-1");
    runtime.streamAssistantText(output);
    runtime.queueStateReports(
      providerStatesAfterEnd.map((state) => ({ ...runtime.state, ...state })),
    );
    runtime.finishTurn();
    return await run;
  }

  async runPromptWithCustomMessage(
    input: string,
    customMessage: Extract<OmpAgentMessage, { role: "custom" }>,
    output: string,
  ): Promise<unknown> {
    const session = this.requireSession();
    const promptStarted = this.omp.latestSession().nextPrompt();
    const run = session.run(input);
    await promptStarted;
    const runtime = this.omp.latestSession();
    runtime.beginTurn();
    runtime.acceptPrompt(input, "user-1");
    runtime.emit({ type: "message_end", message: customMessage });
    runtime.streamAssistantText(output);
    runtime.finishTurn();
    return await run;
  }

  async startPromptWithEmptyAgentEnd(
    input: string,
    output: string,
  ): Promise<{ completion: Promise<unknown> }> {
    const session = this.requireSession();
    const promptStarted = this.omp.latestSession().nextPrompt();
    const completion = session.run(input);
    await promptStarted;
    const runtime = this.omp.latestSession();
    runtime.beginTurn();
    runtime.acceptPrompt(input, "user-1");
    runtime.streamAssistantText(output);
    runtime.finishTurnWithEmptyAgentEnd();
    return { completion };
  }

  async runPromptAfterExtensionNotice(
    input: string,
    output: string,
    display?: boolean,
  ): Promise<unknown> {
    const session = this.requireSession();
    const promptStarted = this.omp.latestSession().nextPrompt();
    const run = session.run(input);
    await promptStarted;
    const runtime = this.omp.latestSession();
    const message = {
      role: "custom" as const,
      content: "extension inventory changed",
      ...(display === undefined ? {} : { display }),
    };
    runtime.beginTurn();
    runtime.acceptPrompt(input, "user-1");
    runtime.emit({ type: "message_end", message });
    runtime.finishTurn(message);
    runtime.beginTurn();
    runtime.streamAssistantText(output);
    runtime.finishTurn();
    return await run;
  }

  async startPromptUntilProviderIdle(
    input: string,
    output: string,
    providerState: { isStreaming: boolean; isCompacting: boolean },
  ): Promise<{ completion: Promise<unknown> }> {
    const session = this.requireSession();
    const promptStarted = this.omp.latestSession().nextPrompt();
    const run = session.run(input);
    await promptStarted;
    const runtime = this.omp.latestSession();
    runtime.beginTurn();
    runtime.acceptPrompt(input, "user-1");
    runtime.streamAssistantText(output);
    runtime.state = { ...runtime.state, ...providerState };
    runtime.finishTurn();
    return { completion: run };
  }

  waitForProviderStateChecks(count: number): Promise<void> {
    return this.omp.latestSession().waitForStateRequests(count);
  }

  reportProviderState(state: { isStreaming: boolean; isCompacting: boolean }): void {
    const runtime = this.omp.latestSession();
    runtime.state = { ...runtime.state, ...state };
  }

  failProviderStateChecks(error: Error | null): void {
    this.omp.latestSession().getStateError = error;
  }

  async runPromptAfterFalseLocalOnlyHint(input: string, output: string): Promise<unknown> {
    const session = this.requireSession();
    const runtime = this.omp.latestSession();
    runtime.promptAck = { agentInvoked: false };
    const promptStarted = runtime.nextPrompt();
    const run = session.run(input);
    await promptStarted;
    runtime.acceptPrompt(input, "user-1");
    await new Promise<void>((resolve) => setImmediate(resolve));
    runtime.beginTurn();
    runtime.streamAssistantText(output);
    runtime.finishTurn();
    return await run;
  }

  async runPromptWithoutTurn(input: string): Promise<unknown> {
    const session = this.requireSession();
    this.omp.latestSession().promptAck = { agentInvoked: false };
    return await session.run(input);
  }

  async startPromptWithFalseLocalOnlyResult(
    input: string,
  ): Promise<{ completed: () => boolean; completion: Promise<unknown> }> {
    const session = this.requireSession();
    const runtime = this.omp.latestSession();
    runtime.promptAck = { requestId: "prompt-local-only" };
    const promptStarted = runtime.nextPrompt();
    const completion = session.run(input);
    let isCompleted = false;
    void completion.then(
      () => {
        isCompleted = true;
        return undefined;
      },
      () => {
        isCompleted = true;
        return undefined;
      },
    );
    await promptStarted;
    await waitForImmediate();
    runtime.emit({
      type: "prompt_result",
      id: "prompt-local-only",
      agentInvoked: false,
    });
    return { completed: () => isCompleted, completion };
  }

  async runPromptAfterCorrelatedTrueResult(
    input: string,
    output: string,
  ): Promise<{ completedBeforeTurn: boolean; result: unknown }> {
    const session = this.requireSession();
    const runtime = this.omp.latestSession();
    runtime.promptAck = { requestId: "prompt-invoked", agentInvoked: false };
    const promptStarted = runtime.nextPrompt();
    const run = session.run(input);
    let completed = false;
    void run.then(
      () => {
        completed = true;
        return undefined;
      },
      () => {
        completed = true;
        return undefined;
      },
    );
    await promptStarted;
    runtime.emit({
      type: "prompt_result",
      id: "prompt-invoked",
      agentInvoked: true,
    });
    await waitForImmediate();
    await waitForImmediate();
    const completedBeforeTurn = completed;
    runtime.acceptPrompt(input, "user-1");
    runtime.beginTurn();
    runtime.streamAssistantText(output);
    runtime.finishTurn();
    return { completedBeforeTurn, result: await run };
  }

  async runPromptAfterDelayedFalseLocalOnlyResult(
    input: string,
    output: string,
  ): Promise<{ completedBeforeTurn: boolean; result: unknown }> {
    const session = this.requireSession();
    const runtime = this.omp.latestSession();
    runtime.promptAck = { requestId: "prompt-1" };
    const promptStarted = runtime.nextPrompt();
    const run = session.run(input);
    let completed = false;
    void run.then(
      () => {
        completed = true;
        return undefined;
      },
      () => {
        completed = true;
        return undefined;
      },
    );
    await promptStarted;
    await waitForImmediate();
    runtime.emit({
      type: "prompt_result",
      id: "prompt-1",
      agentInvoked: false,
    });
    await waitForImmediate();
    const completedBeforeTurn = completed;
    runtime.acceptPrompt(input, "user-1");
    runtime.beginTurn();
    runtime.streamAssistantText(output);
    runtime.finishTurn();
    return { completedBeforeTurn, result: await run };
  }

  async runAutonomousTurn(output: string): Promise<void> {
    const runtime = this.omp.latestSession();
    runtime.beginTurn();
    runtime.streamAssistantText(output);
    runtime.finishTurn();
    await waitForImmediate();
  }

  timeline(): AgentTimelineItem[] {
    return this.events.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
  }

  async history(): Promise<AgentTimelineItem[]> {
    const items: AgentTimelineItem[] = [];
    for await (const event of this.requireSession().streamHistory()) {
      if (event.type === "timeline") items.push(event.item);
    }
    return items;
  }

  completedTurnCount(): number {
    return this.events.filter((event) => event.type === "turn_completed").length;
  }

  requestToolApproval(input: {
    id: string;
    tool: "bash" | "edit" | "write";
    detail: string;
  }): void {
    this.omp.latestSession().requestToolApproval(input);
  }

  pendingPermissions() {
    return this.requireSession().getPendingPermissions();
  }

  async respondToPermission(id: string, response: AgentPermissionResponse): Promise<void> {
    await this.requireSession().respondToPermission(id, response);
  }

  extensionUiResponses() {
    return this.omp.latestSession().extensionUiResponses;
  }

  async availableModes() {
    return await this.requireSession().getAvailableModes();
  }

  async commands() {
    return await this.requireSession().listCommands();
  }

  async setMode(modeId: string) {
    return await this.requireSession().setMode(modeId);
  }

  async rewind(messageId: string, restoredPrompt: string): Promise<void> {
    this.omp.latestSession().branchResponse = { text: restoredPrompt };
    await this.requireSession().revertConversation({ messageId });
  }

  branchRequests(): string[] {
    return this.omp.latestSession().branchRequests;
  }

  async interruptActiveTurn(message: string): Promise<void> {
    await this.requireSession().startTurn(message);
    await this.requireSession().interrupt();
  }

  async requireStartTurn(message: string): Promise<void> {
    const promptStarted = this.omp.latestSession().nextPrompt();
    await this.requireSession().startTurn(message);
    await promptStarted;
  }

  async interrupt(): Promise<void> {
    await this.requireSession().interrupt();
  }

  wasAborted(): boolean {
    return this.omp.latestSession().abortRequested;
  }

  runtime() {
    return this.omp.latestSession();
  }

  runningToolCallIds(): string[] {
    const statusByCall = new Map<string, string>();
    for (const item of this.timeline()) {
      if (item.type === "tool_call") {
        statusByCall.set(item.callId, item.status);
      }
    }
    return [...statusByCall.entries()]
      .filter(([, status]) => status === "running")
      .map(([callId]) => callId);
  }

  subagentUpserts(): Array<{ id: string; status: string }> {
    return this.events.flatMap((event) =>
      event.type === "provider_subagent" && event.event.type === "upsert"
        ? [{ id: event.event.id, status: event.event.status }]
        : [],
    );
  }

  canceledTurnCount(): number {
    return this.events.filter((event) => event.type === "turn_canceled").length;
  }

  async close(): Promise<void> {
    await this.requireSession().close();
    await waitForImmediate();
  }

  isClosed(): boolean {
    return this.omp.latestSession().closed;
  }

  async waitForSubscriptionFallback(): Promise<string[]> {
    const runtime = this.omp.latestSession();
    await runtime.waitForSubagentSubscriptions(2);
    return runtime.subagentSubscriptionRequests;
  }

  private requireSession(): OmpAgentSession {
    if (!this.session) throw new Error("OMP harness has not started");
    return this.session;
  }
}
