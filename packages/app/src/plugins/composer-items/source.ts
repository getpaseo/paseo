import type { PluginComposer, PluginComposerSelector } from "@getpaseo/plugin/client";
import type { PluginComposersSource } from "@getpaseo/plugin/client/host";
import { agentComposer } from "@/composer/agent-composer";
import type { ComposerState } from "@/composer/model";
import { queryClient } from "@/data/query-client";
import { useDraftStore } from "@/stores/draft-store";
import { useSessionStore } from "@/stores/session-store";
import { getFocusedAgent, subscribeFocusedAgent } from "../focused-agent";
import type { InstalledPlugin } from "../types";
import { toPluginComposer } from "./model";

const NO_COMPOSERS: readonly PluginComposer[] = Object.freeze([]);
const sources = new WeakMap<InstalledPlugin, PluginComposersSource>();

/**
 * The composers a plugin reaches by reference: one per running agent, open in a tab or not. The
 * same source serves `useComposers` in every surface and `composers()` in every command.
 */
export function pluginComposersSource(plugin: InstalledPlugin): PluginComposersSource {
  let source = sources.get(plugin);
  if (!source) {
    source = createSource(plugin);
    sources.set(plugin, source);
  }
  return source;
}

function createSource(plugin: InstalledPlugin): PluginComposersSource {
  const { serverId } = plugin;
  // Handles and result arrays are reused while nothing they read has changed, so a subscriber
  // that re-reads on every notification renders only when its composers did change.
  const handles = new WeakMap<ComposerState, PluginComposer>();
  const results = new WeakMap<PluginComposer, readonly PluginComposer[]>();

  function runningAgentId(agentId: string): string | null {
    const session = useSessionStore.getState().sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId) ?? null;
    return agent && !agent.archivedAt ? agent.id : null;
  }

  function focusedAgentId(): string | null {
    const focused = getFocusedAgent();
    return focused?.serverId === serverId ? focused.agentId : null;
  }

  return {
    subscribe(listener) {
      const stops = [
        useSessionStore.subscribe(listener),
        useDraftStore.subscribe(listener),
        subscribeFocusedAgent(listener),
        // The model catalog arrives as an update. A query another component creates while it
        // renders is announced too, and a subscriber that updates then makes React warn.
        queryClient.getQueryCache().subscribe((event) => {
          if (event.type === "updated") listener();
        }),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
    resolve(selector: PluginComposerSelector) {
      const requested = "agentId" in selector ? selector.agentId : focusedAgentId();
      const agentId = requested === null ? null : runningAgentId(requested);
      if (agentId === null) return NO_COMPOSERS;
      const model = agentComposer(serverId, agentId);
      const state = model.getState();
      let composer = handles.get(state);
      if (!composer) {
        composer = toPluginComposer({ plugin, model, state });
        handles.set(state, composer);
      }
      let result = results.get(composer);
      if (!result) {
        result = Object.freeze([composer]);
        results.set(composer, result);
      }
      return result;
    },
  };
}
