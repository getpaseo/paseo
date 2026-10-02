import type { AgentManager, AgentManagerEvent } from "./agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import { isSetupPrompt, resolveLegacyPromptTitle } from "./agent/create-agent-title.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";
import type { GeneratedWorkspaceName } from "./worktree-branch-name-generator.js";

interface ContextualTitleOptions {
  agentManager: Pick<AgentManager, "subscribe" | "getTimeline" | "notifyAgentState">;
  agentStorage: Pick<AgentStorage, "get" | "applyContextualTitle">;
  workspaceRegistry: Pick<WorkspaceRegistry, "update">;
  generate: (input: {
    agent: StoredAgentRecord;
    prompt: string;
  }) => Promise<GeneratedWorkspaceName | null>;
  emitWorkspaceUpdate: (workspaceId: string) => Promise<void>;
  onError: (error: unknown) => void;
}

export function canGenerateContextualTitle(
  record: StoredAgentRecord,
  firstPrompt: string,
): boolean {
  if (record.titleSource === "manual" || record.titleSource === "generated" || record.internal)
    return false;
  if (record.titleSource === "provisional" || !record.title) return true;
  return record.title === resolveLegacyPromptTitle(firstPrompt);
}

export class ContextualTitles {
  private readonly unsubscribe: () => void;
  private readonly pending = new Map<string, Promise<void>>();
  private disposed = false;
  constructor(private readonly options: ContextualTitleOptions) {
    this.unsubscribe = options.agentManager.subscribe((event) => this.observe(event), {
      replayState: false,
    });
  }

  private observe(event: AgentManagerEvent): void {
    if (
      this.disposed ||
      event.type !== "agent_stream" ||
      event.event.type !== "timeline" ||
      event.event.item.type !== "user_message"
    )
      return;
    const text = event.event.item.text;
    if (!text.trim() || isSetupPrompt(text)) return;
    const prior = this.pending.get(event.agentId) ?? Promise.resolve();
    const next = prior
      .then(() => this.generate(event.agentId, text))
      .catch((error) => this.options.onError(error));
    this.pending.set(event.agentId, next);
    void next.finally(() => {
      if (this.pending.get(event.agentId) === next) this.pending.delete(event.agentId);
    });
  }

  private async generate(agentId: string, text: string): Promise<void> {
    if (this.disposed) return;
    const record = await this.options.agentStorage.get(agentId);
    if (
      !record ||
      record.internal ||
      record.titleSource === "manual" ||
      record.titleSource === "generated"
    )
      return;
    const items = this.options.agentManager.getTimeline(agentId);
    const messages = items.flatMap((item) => (item.type === "user_message" ? [item.text] : []));
    const firstPrompt = messages[0] ?? text;
    if (!canGenerateContextualTitle(record, firstPrompt)) return;
    const previousContext = messages.slice(0, 2).filter((message) => message !== text);
    const prompt = [...previousContext, text].map((message) => message.slice(0, 2000)).join("\n\n");
    const generated = await this.options.generate({ agent: record, prompt });
    if (this.disposed || !generated?.title?.trim()) return;
    const title = generated.title.trim();
    const applied = await this.options.agentStorage.applyContextualTitle(
      agentId,
      title,
      record.title ?? null,
      "generated",
    );
    if (!applied) return;
    this.options.agentManager.notifyAgentState(agentId);
    if (!record.workspaceId) return;
    const provisional = resolveLegacyPromptTitle(firstPrompt);
    let changed = false;
    await this.options.workspaceRegistry.update(record.workspaceId, (current) => {
      if (
        current.titleSource === "manual" ||
        current.titleSource === "generated" ||
        (current.title && current.title !== provisional && current.title !== record.title)
      )
        return current;
      changed = true;
      return { ...current, title, titleSource: "generated", updatedAt: new Date().toISOString() };
    });
    if (changed) await this.options.emitWorkspaceUpdate(record.workspaceId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribe();
    await Promise.allSettled(this.pending.values());
  }
}
