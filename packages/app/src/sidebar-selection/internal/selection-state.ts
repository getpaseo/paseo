import { isShiftKeyDown } from "@/keyboard";

export interface WorkspaceSelectionState {
  active: boolean;
  selectedKeys: ReadonlySet<string>;
  anchorKey: string | null;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

export const INITIAL_WORKSPACE_SELECTION_STATE: WorkspaceSelectionState = {
  active: false,
  selectedKeys: EMPTY_KEYS,
  anchorKey: null,
};

export function enterWorkspaceSelection(workspaceKey: string): WorkspaceSelectionState {
  return {
    active: true,
    selectedKeys: new Set([workspaceKey]),
    anchorKey: workspaceKey,
  };
}

export function toggleWorkspaceSelection(
  state: WorkspaceSelectionState,
  workspaceKey: string,
): WorkspaceSelectionState {
  if (!state.active) {
    return enterWorkspaceSelection(workspaceKey);
  }
  const next = new Set(state.selectedKeys);
  if (!next.delete(workspaceKey)) {
    next.add(workspaceKey);
  }
  return {
    active: true,
    selectedKeys: next,
    anchorKey: workspaceKey,
  };
}

export function selectWorkspaceRange(
  state: WorkspaceSelectionState,
  targetKey: string,
  orderedVisibleKeys: readonly string[],
): WorkspaceSelectionState {
  if (!state.active) {
    return enterWorkspaceSelection(targetKey);
  }
  if (!state.anchorKey) {
    const next = new Set(state.selectedKeys);
    next.add(targetKey);
    return { active: true, selectedKeys: next, anchorKey: targetKey };
  }

  const anchorIndex = orderedVisibleKeys.indexOf(state.anchorKey);
  const targetIndex = orderedVisibleKeys.indexOf(targetKey);
  if (anchorIndex < 0 || targetIndex < 0) {
    const next = new Set(state.selectedKeys);
    next.add(targetKey);
    return { active: true, selectedKeys: next, anchorKey: targetKey };
  }

  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  const next = new Set(state.selectedKeys);
  for (let index = start; index <= end; index += 1) {
    const key = orderedVisibleKeys[index];
    if (key !== undefined) {
      next.add(key);
    }
  }
  return {
    active: true,
    selectedKeys: next,
    anchorKey: state.anchorKey,
  };
}

export function reconcileWorkspaceSelection(
  state: WorkspaceSelectionState,
  availableKeys: ReadonlySet<string>,
): WorkspaceSelectionState {
  if (!state.active) return state;

  let changed = false;
  const next = new Set<string>();
  for (const key of state.selectedKeys) {
    if (availableKeys.has(key)) {
      next.add(key);
    } else {
      changed = true;
    }
  }

  const nextAnchor = state.anchorKey && availableKeys.has(state.anchorKey) ? state.anchorKey : null;
  if (!changed && nextAnchor === state.anchorKey) {
    return state;
  }

  return {
    active: true,
    selectedKeys: changed ? next : state.selectedKeys,
    anchorKey: nextAnchor,
  };
}

export function exitWorkspaceSelection(): WorkspaceSelectionState {
  return INITIAL_WORKSPACE_SELECTION_STATE;
}

export function isShiftPressEvent(
  event: unknown,
  isHardwareShiftDown: () => boolean = isShiftKeyDown,
): boolean {
  if (typeof event === "object" && event !== null) {
    if (Reflect.get(event, "shiftKey") === true) return true;
    const nativeEvent = Reflect.get(event, "nativeEvent");
    if (
      typeof nativeEvent === "object" &&
      nativeEvent !== null &&
      Reflect.get(nativeEvent, "shiftKey") === true
    ) {
      return true;
    }
  }
  return isHardwareShiftDown();
}
