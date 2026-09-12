import { randomUUID } from "node:crypto";
import type { PluginSubagentEvent } from "@getpaseo/plugin/server";
import type { PluginSubagentReporter } from "@getpaseo/plugin/server";
import type { AgentProvider } from "../agent-sdk-types.js";
import type { ProviderSubagentStore, ProviderSubagentStoreEvent } from "./store.js";

interface ReporterParent {
  id: string;
  provider: AgentProvider;
  isCurrent(): boolean;
}

interface ReporterSource {
  parent: ReporterParent;
  pluginId: string;
  children: Map<string, string | null>;
}

export class PluginSubagentSources {
  private readonly sources = new Map<string, ReporterSource>();

  constructor(
    private readonly store: ProviderSubagentStore,
    private readonly publish: (event: ProviderSubagentStoreEvent) => void,
  ) {}

  open(pluginId: string, parent: ReporterParent): PluginSubagentReporter {
    const sourceId = `plugin/${encodeURIComponent(pluginId)}/${randomUUID()}/`;
    this.sources.set(sourceId, { parent, pluginId, children: new Map() });
    return {
      report: async (event) => {
        const source = this.sources.get(sourceId);
        if (!source || !source.parent.isCurrent()) {
          this.close(sourceId);
          throw new Error("Subagent reporter is closed");
        }
        this.report(sourceId, source, event);
      },
      close: async () => this.close(sourceId),
    };
  }

  deleteParent(parentAgentId: string): void {
    for (const [sourceId, source] of this.sources) {
      if (source.parent.id === parentAgentId) this.close(sourceId);
    }
  }

  private close(sourceId: string): void {
    const source = this.sources.get(sourceId);
    if (!source) return;
    this.sources.delete(sourceId);
    source.children.clear();
    for (const event of this.store.deleteSource(source.parent.id, sourceId)) this.publish(event);
  }

  private report(sourceId: string, source: ReporterSource, event: PluginSubagentEvent): void {
    const publicId = (id: string) => `${sourceId}${encodeURIComponent(id)}`;
    const apply = (input: PluginSubagentEvent) => {
      this.publish(this.store.apply(source.parent.id, source.parent.provider, input, sourceId));
    };
    if (event.type === "upsert") {
      const parentId =
        event.parentSubagentId === undefined
          ? (source.children.get(event.id) ?? null)
          : event.parentSubagentId;
      if (parentId !== null && !source.children.has(parentId)) {
        throw new Error("Subagent parent must be declared in this reporter first");
      }
      for (
        let ancestor = parentId;
        ancestor !== null;
        ancestor = source.children.get(ancestor) ?? null
      ) {
        if (ancestor === event.id) throw new Error("Subagent parent would create a cycle");
      }
      apply({
        ...event,
        id: publicId(event.id),
        parentSubagentId: parentId === null ? null : publicId(parentId),
      });
      source.children.set(event.id, parentId);
      return;
    }
    if (event.type === "timeline") {
      if (!source.children.has(event.id))
        throw new Error("Declare the subagent before reporting its timeline");
      const item =
        event.item.type === "plugin" ? { ...event.item, pluginId: source.pluginId } : event.item;
      apply({ ...event, id: publicId(event.id), item });
      return;
    }
    const removed = new Set([event.id]);
    // Parent links can change after declaration, so map insertion order is not tree order.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, parentId] of source.children) {
        if (parentId !== null && removed.has(parentId) && !removed.has(id)) {
          removed.add(id);
          changed = true;
        }
      }
    }
    for (const id of removed) {
      if (source.children.delete(id)) apply({ type: "remove", id: publicId(id) });
    }
  }
}
