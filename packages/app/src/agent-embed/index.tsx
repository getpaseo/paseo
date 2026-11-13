import { useId, useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  ALL_COMPOSER_CONTROLS,
  ComposerControlsScopeProvider,
  type ComposerControlsScope,
} from "@/composer/controls-scope";
import { AgentPanelContent, type ConversationSurface } from "@/panels/agent-panel";
import { createPaneFocusContextValue, PaneFocusProvider } from "@/panels/pane-context";
import { RetainedChatContent } from "@/panels/retained-chat-content";
import { useSessionStore } from "@/stores/session-store";
import { useViewedAgent } from "@/timeline/use-viewed-agent";

export interface AgentEmbedComposer {
  controls: ComposerControlsScope;
  placeholder: string | undefined;
}

export interface AgentEmbedProps {
  serverId: string;
  agentId: string;
  /** `null` shows the timeline without a composer. */
  composer: AgentEmbedComposer | null;
  testID?: string;
}

/**
 * An agent's conversation outside the workspace: the agent tab's own chain, with its loading,
 * catch-up, error and archived states, rendered for a plugin surface.
 *
 * The embed is a viewer like the workspace sheet, so the agent's timeline stays live while it is
 * mounted and shares the tab's observation when the agent is also open in a tab.
 *
 * An embed with a composer is where the user acts on the agent, so it clears "needs attention"
 * as a focused tab does. An embed without a composer never clears it: a plugin can show many at
 * once, and a glance at a preview is not the user handling the agent. Permissions and questions
 * stay answerable either way, as in the workspace sheet.
 */
export function AgentEmbed({ serverId, agentId, composer, testID }: AgentEmbedProps) {
  const viewerId = `embed:${useId()}`;
  useViewedAgent({ sourceId: viewerId, serverId, agentId });
  const isInteractive = composer !== null;
  const placeholder = composer?.placeholder;
  const surface = useMemo<ConversationSurface>(
    () => ({
      kind: "embed",
      id: viewerId,
      composer: isInteractive ? { placeholder } : null,
    }),
    [isInteractive, placeholder, viewerId],
  );
  const focus = useMemo(
    () => createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: isInteractive }),
    [isInteractive],
  );
  const target = useMemo(() => ({ kind: "agent" as const, agentId }), [agentId]);
  const workspaceId = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return (
      session?.agents.get(agentId)?.workspaceId ??
      session?.agentDetails.get(agentId)?.workspaceId ??
      ""
    );
  });

  return (
    <View style={styles.root} testID={testID}>
      <PaneFocusProvider value={focus}>
        <ComposerControlsScopeProvider value={composer?.controls ?? ALL_COMPOSER_CONTROLS}>
          <RetainedChatContent>
            <AgentPanelContent
              serverId={serverId}
              workspaceId={workspaceId}
              target={target}
              surface={surface}
              isPaneFocused={isInteractive}
            />
          </RetainedChatContent>
        </ComposerControlsScopeProvider>
      </PaneFocusProvider>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
});
