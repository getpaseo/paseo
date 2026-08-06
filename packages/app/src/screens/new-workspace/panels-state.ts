export type NewWorkspacePanelKind = "terminal" | "browser";

export interface NewWorkspacePanel {
  panelId: string;
  kind: NewWorkspacePanelKind;
  terminalId?: string;
  browserId?: string;
  createdAt: number;
}

export interface NewWorkspacePanelsState {
  panels: NewWorkspacePanel[];
  // null active means the composer (chat) view is active.
  activePanelId: string | null;
}

export const initialPanelsState: NewWorkspacePanelsState = {
  panels: [],
  activePanelId: null,
};

export type NewWorkspacePanelsAction =
  | { type: "add-terminal"; terminalId: string; createdAt: number }
  | { type: "add-browser"; browserId: string; createdAt: number }
  | { type: "activate"; panelId: string }
  | { type: "activate-composer" }
  | { type: "close"; panelId: string };

export function panelsReducer(
  state: NewWorkspacePanelsState,
  action: NewWorkspacePanelsAction,
): NewWorkspacePanelsState {
  switch (action.type) {
    case "add-terminal": {
      if (state.panels.some((panel) => panel.terminalId === action.terminalId)) {
        return state;
      }
      const panel: NewWorkspacePanel = {
        panelId: action.terminalId,
        kind: "terminal",
        terminalId: action.terminalId,
        createdAt: action.createdAt,
      };
      return { panels: [...state.panels, panel], activePanelId: panel.panelId };
    }
    case "add-browser": {
      if (state.panels.some((panel) => panel.browserId === action.browserId)) {
        return state;
      }
      const panel: NewWorkspacePanel = {
        panelId: action.browserId,
        kind: "browser",
        browserId: action.browserId,
        createdAt: action.createdAt,
      };
      return { panels: [...state.panels, panel], activePanelId: panel.panelId };
    }
    case "activate": {
      if (!state.panels.some((panel) => panel.panelId === action.panelId)) {
        return state;
      }
      return { ...state, activePanelId: action.panelId };
    }
    case "activate-composer":
      return { ...state, activePanelId: null };
    case "close": {
      if (!state.panels.some((panel) => panel.panelId === action.panelId)) {
        return state;
      }
      const panels = state.panels.filter((panel) => panel.panelId !== action.panelId);
      let activePanelId = state.activePanelId;
      if (state.activePanelId === action.panelId) {
        activePanelId = panels.length > 0 ? panels[panels.length - 1].panelId : null;
      }
      return { panels, activePanelId };
    }
  }
}

export function selectActivePanel(state: NewWorkspacePanelsState): NewWorkspacePanel | null {
  return state.panels.find((panel) => panel.panelId === state.activePanelId) ?? null;
}
