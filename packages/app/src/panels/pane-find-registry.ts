import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";

export interface PaneFindController {
  openFind(): boolean;
  closeFind(): boolean;
}

export interface RegisterPaneFindInput {
  paneId: string;
  controller: PaneFindController;
}

export interface PaneFindRegistry {
  register(input: RegisterPaneFindInput): () => void;
  openFindInActivePane(): boolean;
  closeFindInPane(paneId: string): boolean;
}

export function createPaneFindRegistry(input: { getActivePaneId: () => string | null }) {
  const controllers = new Map<string, PaneFindController>();

  return {
    register({ paneId, controller }: RegisterPaneFindInput) {
      controllers.set(paneId, controller);

      return () => {
        if (controllers.get(paneId) === controller) {
          controller.closeFind();
          controllers.delete(paneId);
        }
      };
    },

    openFindInActivePane(): boolean {
      const activePaneId = input.getActivePaneId();
      if (!activePaneId) {
        return false;
      }
      return controllers.get(activePaneId)?.openFind() ?? false;
    },

    closeFindInPane(paneId: string): boolean {
      return controllers.get(paneId)?.closeFind() ?? false;
    },
  } satisfies PaneFindRegistry;
}

let activePaneId: string | null = null;

export const paneFindRegistry = createPaneFindRegistry({
  getActivePaneId: () => activePaneId,
});

export function createPaneFindPaneId(input: {
  serverId: string;
  workspaceId: string;
  paneId: string;
}): string {
  return `${input.serverId}:${input.workspaceId}:${input.paneId}`;
}

export function setActivePaneFindPaneId(paneId: string | null) {
  if (activePaneId && activePaneId !== paneId) {
    paneFindRegistry.closeFindInPane(activePaneId);
  }
  activePaneId = paneId;
}

export function clearActivePaneFindPaneId(paneId: string) {
  if (activePaneId === paneId) {
    paneFindRegistry.closeFindInPane(paneId);
    activePaneId = null;
  }
}

export function handlePaneFindKeyboardAction(action: KeyboardActionDefinition): boolean {
  if (action.id !== "workspace.find.open") {
    return false;
  }
  return paneFindRegistry.openFindInActivePane();
}
