import type { PluginComposer, PluginComposerSelector } from "@getpaseo/plugin/client";
import type { PluginComposersSource } from "@getpaseo/plugin/client/host";
import { agentComposer } from "@/composer/agent-composer";
import type { ComposerState } from "@/composer/model";
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

  /** The running agent a selector names now, or null. */
  function namedAgentId(selector: PluginComposerSelector): string | null {
    const requested = "agentId" in selector ? selector.agentId : focusedAgentId();
    return requested === null ? null : runningAgentId(requested);
  }

  return {
    subscribe(selector, listener) {
      // Watching a composer is what keeps its model catalog current, so the subscription holds
      // the model the selector names now and moves with it as focus and agents change.
      let held: { agentId: string; stop: () => void } | null = null;
      function hold() {
        const agentId = namedAgentId(selector);
        if (held?.agentId === agentId) return;
        held?.stop();
        held = agentId
          ? { agentId, stop: agentComposer(serverId, agentId).subscribe(listener) }
          : null;
      }
      hold();
      const stops = [
        useSessionStore.subscribe(() => {
          hold();
          listener();
        }),
        subscribeFocusedAgent(() => {
          hold();
          listener();
        }),
      ];
      return () => {
        for (const stop of stops) stop();
        held?.stop();
        held = null;
      };
    },
    resolve(selector: PluginComposerSelector) {
      const agentId = namedAgentId(selector);
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
