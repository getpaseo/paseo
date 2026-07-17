import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import type {
  AgentPersistenceHandle,
  AgentPermissionResponse,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "../../../agent-sdk-types.js";
import type { PaseoToolCatalog } from "../../../tools/types.js";
import { OmpAgentClient, OmpAgentSession, type OmpProviderIdleScheduler } from "../agent.js";
import type { OmpRpcSlashCommand } from "../rpc-types.js";
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

  constructor(options: { providerIdleScheduler?: OmpProviderIdleScheduler } = {}) {
    this.client = new OmpAgentClient({
      logger: pino({ level: "silent" }),
      runtime: this.omp,
      providerIdleScheduler: options.providerIdleScheduler,
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

  async runPromptAfterExtensionNotice(input: string, output: string): Promise<unknown> {
    const session = this.requireSession();
    const promptStarted = this.omp.latestSession().nextPrompt();
    const run = session.run(input);
    await promptStarted;
    const runtime = this.omp.latestSession();
    runtime.beginTurn();
    runtime.acceptPrompt(input, "user-1");
    runtime.acceptCustomMessage("extension inventory changed");
    runtime.finishTurn({ role: "custom", content: "extension inventory changed" });
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
