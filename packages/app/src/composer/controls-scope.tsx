import { createContext, useContext, type ReactNode } from "react";
import { type ComposerInputMode, resolveComposerInputMode } from "./input-mode";

/**
 * Which of the chat composer's controls its host shows. The agent tab shows every control; a
 * plugin's embedded timeline can hide them one by one. A hidden control is not rendered at all,
 * so a hidden attachment control also refuses pasted and dropped files.
 */
export interface ComposerControlsScope {
  model: boolean;
  mode: boolean;
  thinking: boolean;
  /** The provider's own option controls, such as a fast-mode toggle. */
  options: boolean;
  attachments: boolean;
  voice: boolean;
  autocomplete: boolean;
  /**
   * Client slash commands, built-in (`/exit`, `/clear`) and plugin, run in the app. Off, every
   * text goes to the agent as typed.
   */
  clientCommands: boolean;
  /** The context window and cost meter beside Send. */
  usage: boolean;
  items: ComposerItemsScope;
}

/** The plugin composer items shown: every item, or only the named items of one plugin. */
export type ComposerItemsScope =
  | { kind: "all" }
  | { kind: "only"; pluginId: string; itemIds: readonly string[] };

export function showsComposerItem(
  scope: ComposerItemsScope,
  pluginId: string,
  itemId: string,
): boolean {
  if (scope.kind === "all") return true;
  return scope.pluginId === pluginId && scope.itemIds.includes(itemId);
}

export const ALL_COMPOSER_CONTROLS: ComposerControlsScope = {
  model: true,
  mode: true,
  thinking: true,
  options: true,
  attachments: true,
  voice: true,
  autocomplete: true,
  clientCommands: true,
  usage: true,
  items: { kind: "all" },
};

const ComposerControlsScopeContext = createContext<ComposerControlsScope>(ALL_COMPOSER_CONTROLS);

export function ComposerControlsScopeProvider({
  value,
  children,
}: {
  value: ComposerControlsScope;
  children: ReactNode;
}) {
  return (
    <ComposerControlsScopeContext.Provider value={value}>
      {children}
    </ComposerControlsScopeContext.Provider>
  );
}

export function useComposerControlsScope(): ComposerControlsScope {
  return useContext(ComposerControlsScopeContext);
}

/** The input mode's presentation, narrowed to the controls the surrounding scope shows. */
export function useComposerPresentation(inputMode: ComposerInputMode) {
  const scope = useComposerControlsScope();
  const mode = resolveComposerInputMode(inputMode);
  const hasItems = scope.items.kind === "all" || scope.items.itemIds.length > 0;
  const hasAgentControl = scope.model || scope.mode || scope.thinking || scope.options || hasItems;
  return {
    ...mode,
    showAttachments: mode.showAttachments && scope.attachments,
    showVoice: mode.showVoice && scope.voice,
    showAutocomplete: mode.showAutocomplete && scope.autocomplete,
    // Plugin items render inside the agent controls, so they keep the controls' slot.
    showAgentControls: mode.showAgentControls && hasAgentControl,
  };
}
