import type {
  AgentSnapshotPayload,
  CreationSnapshot,
  WorkspaceCreateResponse,
} from "@getpaseo/protocol/messages";
import type { CreateAgentRequestOptions, CreateWorkspaceRequestOptions } from "../daemon-client.js";

type Kind = CreationSnapshot["kind"];
type Observer = (snapshot: CreationSnapshot) => void;
export interface CreationResult {
  agent?: AgentSnapshotPayload | null;
  workspace?: WorkspaceCreateResponse["payload"]["workspace"];
  creation?: CreationSnapshot;
  error: string | null;
  errorCode?: string;
  setupTerminalId?: string | null;
  setupSkippedReason?: string;
  requestId?: string;
}
interface Dependencies {
  supports: () => boolean;
  connected: () => boolean;
  requestId: () => string;
  request: (kind: Kind, input: Record<string, unknown>) => Promise<CreationResult>;
  subscribe: (kind: Kind, key: string, enabled?: boolean) => Promise<CreationSnapshot | null>;
  legacyAgent: (input: CreateAgentRequestOptions) => Promise<AgentSnapshotPayload>;
  legacyWorkspace: (
    input: CreateWorkspaceRequestOptions,
  ) => Promise<WorkspaceCreateResponse["payload"]>;
  sendMessage: (
    id: string,
    text: string,
    options: {
      messageId: string;
      images?: CreateAgentRequestOptions["images"];
      attachments?: CreateAgentRequestOptions["attachments"];
    },
  ) => Promise<unknown>;
}
interface Operation {
  kind: Kind;
  key: string;
  fingerprint: string;
  input: Record<string, unknown>;
  observers: Set<Observer>;
  snapshot?: CreationSnapshot;
  result: Promise<CreationResult>;
  resolve: (result: CreationResult) => void;
  reject: (error: Error) => void;
  settled: boolean;
  modern: boolean;
  recovering: boolean;
}

/** Client-owned observation and compatibility. UI callbacks never advance creation. */
export class CreationClient {
  private readonly operations = new Map<string, Operation>();
  constructor(private readonly deps: Dependencies) {}

  createAgent(input: CreateAgentRequestOptions): Promise<CreationResult> {
    const { onEvent, ...request } = input;
    return this.start("agent", request, onEvent, () => this.legacyAgent(request));
  }
  createWorkspace(input: CreateWorkspaceRequestOptions): Promise<CreationResult> {
    const { onEvent, ...request } = input;
    return this.start("workspace", request, onEvent, async (operation) => {
      if (request.workspaceId || request.agent?.agentId)
        throw new Error("Update the host to use caller-selected creation IDs.");
      const { agent, ...workspaceInput } = request;
      const workspace = await this.deps.legacyWorkspace(workspaceInput);
      if (workspace.error || !workspace.workspace) return workspace;
      this.receive({
        kind: "workspace",
        idempotencyKey: operation.key,
        revision: 1,
        phase: "workspace_ready",
        workspaceId: workspace.workspace.id,
        agentId: null,
        workspace: workspace.workspace,
        setupSkippedReason: workspace.setupSkippedReason,
        error: null,
      });
      if (!agent) return workspace;
      const sourceCwd =
        request.source.kind === "directory" ? request.source.path : request.source.cwd;
      const cwd = sourceCwd
        ? remapDirectory(agent.config!.cwd, sourceCwd, workspace.workspace.workspaceDirectory!)
        : workspace.workspace.workspaceDirectory!;
      const created = await this.legacyAgent({
        ...agent,
        config: { ...agent.config!, cwd },
        workspaceId: workspace.workspace.id,
        idempotencyKey: `${operation.key}:agent`,
      });
      return { ...workspace, agent: created.agent };
    });
  }

  private async legacyAgent(input: CreateAgentRequestOptions): Promise<CreationResult> {
    if (input.agentId) throw new Error("Update the host to use caller-selected creation IDs.");
    // COMPAT(creationLifecycle): added in v0.8.0, remove after 2027-03-11 once the daemon floor supports creationLifecycle.
    // Old keyed creates reject initialPrompt. Keep this adaptation private to the SDK.
    if (input.idempotencyKey) {
      const { initialPrompt = "", images, attachments, ...creation } = input;
      const hasPrompt = Boolean(initialPrompt.trim() || images?.length || attachments?.length);
      if (hasPrompt && input.outputSchema)
        throw new Error("Update the host to create a keyed agent with structured initial output.");
      const agent = await this.deps.legacyAgent(creation);
      if (hasPrompt)
        await this.deps.sendMessage(agent.id, initialPrompt, {
          messageId: input.clientMessageId ?? `${input.idempotencyKey}:initial-message`,
          images,
          attachments,
        });
      return { agent, error: null };
    }
    return { agent: await this.deps.legacyAgent(input), error: null };
  }

  private start(
    kind: Kind,
    input: Record<string, unknown>,
    observer: Observer | undefined,
    legacy: (operation: Operation) => Promise<CreationResult>,
  ): Promise<CreationResult> {
    const key =
      typeof input.idempotencyKey === "string" ? input.idempotencyKey : this.deps.requestId();
    const identity = JSON.stringify([kind, key]);
    const { requestId: _requestId, ...intent } = input;
    const fingerprint = JSON.stringify(intent, (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
    );
    const previous = this.operations.get(identity);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        return Promise.reject(new Error(`${kind}_request_key_conflict`));
      if (observer) {
        previous.observers.add(observer);
        if (previous.snapshot) this.notify(observer, previous.snapshot);
      }
      return previous.result;
    }
    let resolve!: Operation["resolve"];
    let reject!: Operation["reject"];
    const result = new Promise<CreationResult>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const operation: Operation = {
      kind,
      key,
      input: { ...input, idempotencyKey: key },
      fingerprint,
      observers: new Set(observer ? [observer] : []),
      result,
      resolve,
      reject,
      settled: false,
      modern: this.deps.supports(),
      recovering: false,
    };
    this.operations.set(identity, operation);
    if (operation.modern) void this.submit(operation);
    else
      void legacy(operation).then(
        (value) => this.finish(operation, value),
        (error) => this.fail(operation, error),
      );
    return result;
  }

  private async submit(operation: Operation): Promise<void> {
    try {
      const result = await this.deps.request(operation.kind, {
        ...operation.input,
        subscribe: true,
      });
      if (result.creation) this.receive(result.creation);
      this.finish(operation, result);
    } catch (error) {
      if (operation.settled || !this.deps.connected()) return;
      this.fail(operation, error);
    }
  }
  receive(snapshot: CreationSnapshot): void {
    const operation = this.operations.get(JSON.stringify([snapshot.kind, snapshot.idempotencyKey]));
    if (!operation || (operation.snapshot && operation.snapshot.revision >= snapshot.revision))
      return;
    operation.snapshot = snapshot;
    for (const observer of operation.observers) this.notify(observer, snapshot);
    if (operation.recovering && (snapshot.phase === "completed" || snapshot.phase === "failed")) {
      this.finish(operation, {
        agent: snapshot.agent,
        workspace: snapshot.workspace,
        creation: snapshot,
        setupSkippedReason: snapshot.setupSkippedReason,
        error: snapshot.error,
        errorCode: snapshot.errorCode,
      });
    }
  }
  private async recover(operation: Operation): Promise<void> {
    operation.recovering = true;
    const snapshot = await this.deps.subscribe(operation.kind, operation.key);
    if (!snapshot) {
      await this.submit(operation);
      return;
    }
    this.receive(snapshot);
    if (snapshot.phase === "completed" || snapshot.phase === "failed") {
      this.finish(operation, {
        agent: snapshot.agent,
        workspace: snapshot.workspace,
        creation: snapshot,
        setupSkippedReason: snapshot.setupSkippedReason,
        error: snapshot.error,
        errorCode: snapshot.errorCode,
      });
    }
  }

  reconnect(): void {
    for (const operation of this.operations.values()) {
      if (operation.settled || !operation.modern) continue;
      void this.recover(operation).catch((error) => {
        if (this.deps.connected()) this.fail(operation, error);
      });
    }
  }
  close(): void {
    for (const operation of this.operations.values())
      if (!operation.settled) this.fail(operation, new Error("Daemon client closed"));
    this.operations.clear();
  }
  private finish(operation: Operation, result: CreationResult): void {
    if (operation.settled) return;
    operation.settled = true;
    if (operation.recovering)
      void this.deps.subscribe(operation.kind, operation.key, false).catch(() => undefined);
    operation.resolve(result);
    operation.observers.clear();
    this.operations.delete(JSON.stringify([operation.kind, operation.key]));
  }
  private fail(operation: Operation, error: unknown): void {
    if (operation.settled) return;
    operation.settled = true;
    operation.reject(error instanceof Error ? error : new Error(String(error)));
    operation.observers.clear();
    this.operations.delete(JSON.stringify([operation.kind, operation.key]));
  }
  private notify(observer: Observer, snapshot: CreationSnapshot): void {
    try {
      observer(snapshot);
    } catch {
      /* Observation does not control execution. */
    }
  }
}

function remapDirectory(cwd: string, source: string, target: string): string {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/$/, "");
  const normalized = normalize(cwd),
    root = normalize(source);
  if (normalized === root) return target;
  if (!normalized.startsWith(`${root}/`))
    throw new Error("Agent directory must be inside the workspace source");
  return `${normalize(target)}${normalized.slice(root.length)}`;
}
