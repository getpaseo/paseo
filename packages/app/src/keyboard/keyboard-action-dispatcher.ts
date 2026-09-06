export type KeyboardActionScope = "global" | "message-input" | "sidebar" | "workspace";

export type WorkspacePanelTarget = "changes" | "files" | "pull-request";
export type WorkspacePanelPlacement = "supporting" | "side-pane" | "focused-pane";

export type KeyboardActionId =
  | "agent.interrupt"
  | "message-input.focus"
  | "message-input.send"
  | "message-input.dictation-toggle"
  | "message-input.dictation-cancel"
  | "message-input.dictation-confirm"
  | "message-input.voice-toggle"
  | "message-input.voice-mute-toggle"
  | "message-input.mode-cycle"
  | "workspace.agent.new"
  | "workspace.tab.menu.open"
  | "workspace.tab.target.agent"
  | "workspace.tab.target.browser"
  | "workspace.tab.target.changes"
  | "workspace.tab.target.files"
  | "workspace.tab.close-current"
  | "workspace.tab.navigate-index"
  | "workspace.tab.navigate-relative"
  | "workspace.tab.open"
  | "workspace.tab.rename-current"
  | "workspace.tab.reload-current"
  | "workspace.tab.copy-resume-command"
  | "workspace.tab.copy-id"
  | "workspace.tab.copy-file-path"
  | "workspace.tab.close-left"
  | "workspace.tab.close-right"
  | "workspace.tab.close-others"
  | "workspace.pane.split.right"
  | "workspace.pane.split.down"
  | "workspace.pane.focus.left"
  | "workspace.pane.focus.right"
  | "workspace.pane.focus.up"
  | "workspace.pane.focus.down"
  | "workspace.pane.move-tab.left"
  | "workspace.pane.move-tab.right"
  | "workspace.pane.move-tab.up"
  | "workspace.pane.move-tab.down"
  | "workspace.pane.close"
  | "workspace.focus.toggle"
  | "workspace.terminal.new"
  | "workspace.browser.new"
  | "sidebar.toggle.right"
  | "sidebar.toggle.both"
  | "workspace.new"
  | "workspace.project.pick"
  | "worktree.new"
  | "workspace.archive"
  | "workspace.pin"
  // Command-center only: no keybind, so these are absent from route-shortcut.ts.
  | "workspace.rename"
  | "workspace.setup.show";

export type KeyboardActionDefinition =
  | { id: "agent.interrupt"; scope: KeyboardActionScope }
  | { id: "message-input.focus"; scope: KeyboardActionScope }
  | { id: "message-input.send"; scope: KeyboardActionScope }
  | { id: "message-input.dictation-toggle"; scope: KeyboardActionScope }
  | { id: "message-input.dictation-cancel"; scope: KeyboardActionScope }
  | { id: "message-input.dictation-confirm"; scope: KeyboardActionScope }
  | { id: "message-input.voice-toggle"; scope: KeyboardActionScope }
  | { id: "message-input.voice-mute-toggle"; scope: KeyboardActionScope }
  | { id: "message-input.mode-cycle"; scope: KeyboardActionScope }
  | { id: "workspace.agent.new"; scope: KeyboardActionScope }
  | { id: "workspace.tab.menu.open"; scope: KeyboardActionScope }
  | { id: "workspace.tab.target.agent"; scope: KeyboardActionScope }
  | { id: "workspace.tab.target.browser"; scope: KeyboardActionScope }
  | { id: "workspace.tab.target.changes"; scope: KeyboardActionScope }
  | { id: "workspace.tab.target.files"; scope: KeyboardActionScope }
  | { id: "workspace.tab.close-current"; scope: KeyboardActionScope }
  | { id: "workspace.tab.navigate-index"; scope: KeyboardActionScope; index: number }
  | { id: "workspace.tab.navigate-relative"; scope: KeyboardActionScope; delta: 1 | -1 }
  | {
      id: "workspace.tab.open";
      scope: KeyboardActionScope;
      target: WorkspacePanelTarget;
      placement: WorkspacePanelPlacement;
    }
  | { id: "workspace.tab.rename-current"; scope: KeyboardActionScope }
  | { id: "workspace.tab.reload-current"; scope: KeyboardActionScope }
  | { id: "workspace.tab.copy-resume-command"; scope: KeyboardActionScope }
  | { id: "workspace.tab.copy-id"; scope: KeyboardActionScope }
  | { id: "workspace.tab.copy-file-path"; scope: KeyboardActionScope }
  | { id: "workspace.tab.close-left"; scope: KeyboardActionScope }
  | { id: "workspace.tab.close-right"; scope: KeyboardActionScope }
  | { id: "workspace.tab.close-others"; scope: KeyboardActionScope }
  | { id: "workspace.pane.split.right"; scope: KeyboardActionScope }
  | { id: "workspace.pane.split.down"; scope: KeyboardActionScope }
  | { id: "workspace.pane.focus.left"; scope: KeyboardActionScope }
  | { id: "workspace.pane.focus.right"; scope: KeyboardActionScope }
  | { id: "workspace.pane.focus.up"; scope: KeyboardActionScope }
  | { id: "workspace.pane.focus.down"; scope: KeyboardActionScope }
  | { id: "workspace.pane.move-tab.left"; scope: KeyboardActionScope }
  | { id: "workspace.pane.move-tab.right"; scope: KeyboardActionScope }
  | { id: "workspace.pane.move-tab.up"; scope: KeyboardActionScope }
  | { id: "workspace.pane.move-tab.down"; scope: KeyboardActionScope }
  | { id: "workspace.pane.close"; scope: KeyboardActionScope }
  | { id: "workspace.focus.toggle"; scope: KeyboardActionScope }
  | { id: "workspace.terminal.new"; scope: KeyboardActionScope }
  | { id: "workspace.browser.new"; scope: KeyboardActionScope }
  | { id: "sidebar.toggle.right"; scope: KeyboardActionScope }
  | { id: "sidebar.toggle.both"; scope: KeyboardActionScope }
  | { id: "workspace.new"; scope: KeyboardActionScope }
  | { id: "workspace.project.pick"; scope: KeyboardActionScope }
  | { id: "worktree.new"; scope: KeyboardActionScope }
  | { id: "workspace.archive"; scope: KeyboardActionScope }
  | { id: "workspace.pin"; scope: KeyboardActionScope }
  | { id: "workspace.rename"; scope: KeyboardActionScope }
  | { id: "workspace.setup.show"; scope: KeyboardActionScope };

export interface KeyboardActionHandler {
  handlerId: string;
  actions: readonly KeyboardActionId[];
  enabled: boolean;
  priority: number;
  isActive?: () => boolean;
  handle: (action: KeyboardActionDefinition) => boolean;
}

type KeyboardActionRegistryEntry = KeyboardActionHandler & {
  registeredAt: number;
};

export function createKeyboardActionDispatcher() {
  let nextRegistrationOrder = 1;
  const handlers = new Map<string, KeyboardActionRegistryEntry>();

  return {
    registerHandler(handler: KeyboardActionHandler) {
      const entry: KeyboardActionRegistryEntry = {
        ...handler,
        registeredAt: nextRegistrationOrder++,
      };
      handlers.set(handler.handlerId, entry);

      return () => {
        const current = handlers.get(handler.handlerId);
        if (current !== entry) {
          return;
        }
        handlers.delete(handler.handlerId);
      };
    },

    dispatch(action: KeyboardActionDefinition): boolean {
      const candidates = Array.from(handlers.values())
        .filter((handler) => handler.actions.includes(action.id))
        .filter((handler) => handler.enabled)
        .filter((handler) => (handler.isActive ? handler.isActive() : true))
        .sort((left, right) => {
          if (left.priority !== right.priority) {
            return right.priority - left.priority;
          }
          return right.registeredAt - left.registeredAt;
        });

      for (const handler of candidates) {
        if (handler.handle(action)) {
          return true;
        }
      }

      return false;
    },
  };
}
