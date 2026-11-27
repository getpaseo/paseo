export interface WorkspaceSelectionState {
  active: boolean;
  selectedKeys: ReadonlySet<string>;
  anchorKey: string | null;
  /**
   * Selection as it stood before the current run of Shift+clicks from `anchorKey`. Each Shift+click
   * rebuilds the selection from this base, so a closer Shift+click shrinks the range like Finder.
   * Null until the first Shift+click after the anchor moves.
   */
  rangeBaseKeys: ReadonlySet<string> | null;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

export const INITIAL_WORKSPACE_SELECTION_STATE: WorkspaceSelectionState = {
  active: false,
  selectedKeys: EMPTY_KEYS,
  anchorKey: null,
  rangeBaseKeys: null,
};

export function enterWorkspaceSelection(workspaceKey: string): WorkspaceSelectionState {
  return {
    active: true,
    selectedKeys: new Set([workspaceKey]),
    anchorKey: workspaceKey,
    rangeBaseKeys: null,
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
    rangeBaseKeys: null,
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
  const anchorIndex = state.anchorKey ? orderedVisibleKeys.indexOf(state.anchorKey) : -1;
  const targetIndex = orderedVisibleKeys.indexOf(targetKey);
  if (anchorIndex < 0 || targetIndex < 0) {
    const next = new Set(state.selectedKeys);
    next.add(targetKey);
    return { active: true, selectedKeys: next, anchorKey: targetKey, rangeBaseKeys: null };
  }

  const rangeBaseKeys = state.rangeBaseKeys ?? state.selectedKeys;
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  const next = new Set(rangeBaseKeys);
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
    rangeBaseKeys,
  };
}

export function reconcileWorkspaceSelection(
  state: WorkspaceSelectionState,
  availableKeys: ReadonlySet<string>,
): WorkspaceSelectionState {
  if (!state.active) return state;

  const selectedKeys = keepAvailableKeys(state.selectedKeys, availableKeys);
  const rangeBaseKeys = state.rangeBaseKeys
    ? keepAvailableKeys(state.rangeBaseKeys, availableKeys)
    : null;
  const anchorKey = state.anchorKey && availableKeys.has(state.anchorKey) ? state.anchorKey : null;
  if (
    selectedKeys === state.selectedKeys &&
    rangeBaseKeys === state.rangeBaseKeys &&
    anchorKey === state.anchorKey
  ) {
    return state;
  }

  return { active: true, selectedKeys, anchorKey, rangeBaseKeys };
}

function keepAvailableKeys(
  keys: ReadonlySet<string>,
  availableKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  for (const key of keys) {
    if (!availableKeys.has(key)) {
      return new Set([...keys].filter((candidate) => availableKeys.has(candidate)));
    }
  }
  return keys;
}

export function exitWorkspaceSelection(): WorkspaceSelectionState {
  return INITIAL_WORKSPACE_SELECTION_STATE;
}
