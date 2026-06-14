import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceDraftTabSetup,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "@/workspace-tabs/identity";
import type { WorkspaceFileTabTarget } from "@/workspace/file-open";

export interface WorkspaceDraftTabSetup {
  provider: AgentProvider;
  cwd: string;
  modeId: string | null;
  model: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown>;
}

export type WorkspaceTabTarget =
  | { kind: "draft"; draftId: string; setup?: WorkspaceDraftTabSetup }
  | { kind: "agent"; agentId: string }
  | { kind: "terminal"; terminalId: string }
  | { kind: "browser"; browserId: string }
  | WorkspaceFileTabTarget
  | { kind: "setup"; workspaceId: string };

export interface WorkspaceTab {
  tabId: string;
  target: WorkspaceTabTarget;
  createdAt: number;
}

export interface WorkspaceTabsCoreState {
  uiTabsByWorkspace: Record<string, WorkspaceTab[]>;
  tabOrderByWorkspace: Record<string, string[]>;
  focusedTabIdByWorkspace: Record<string, string>;
}

export const initialWorkspaceTabsCoreState: WorkspaceTabsCoreState = {
  uiTabsByWorkspace: {},
  tabOrderByWorkspace: {},
  focusedTabIdByWorkspace: {},
};

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildWorkspaceTabPersistenceKey(input: {
  serverId: string;
  workspaceId: string;
}): string | null {
  const serverId = trimNonEmpty(input.serverId);
  const workspaceId = trimNonEmpty(input.workspaceId);
  if (!serverId || !workspaceId) {
    return null;
  }
  // workspaceId is opaque; do not parse this key back into a path.
  return `${serverId}:${workspaceId}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined;
}

function normalizeTabOrder(list: unknown): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const next: string[] = [];
  const used = new Set<string>();
  for (const value of list) {
    const tabId = trimNonEmpty(typeof value === "string" ? value : null);
    if (!tabId || used.has(tabId)) {
      continue;
    }
    used.add(tabId);
    next.push(tabId);
  }
  return next;
}

function ensureInOrder(input: { current: string[]; tabId: string }): string[] {
  if (input.current.includes(input.tabId)) {
    return input.current;
  }
  return [...input.current, input.tabId];
}

function retargetTabAtIndex(
  tab: WorkspaceTab,
  index: number,
  targetIndex: number,
  normalizedTarget: WorkspaceTabTarget,
): WorkspaceTab {
  return index === targetIndex ? { ...tab, target: normalizedTarget } : tab;
}

function buildNextTabsForEnsure(args: {
  currentTabs: WorkspaceTab[];
  existingIndex: number;
  effectiveTabId: string;
  normalizedTarget: WorkspaceTabTarget;
  createdAt: number;
}): WorkspaceTab[] {
  const { currentTabs, existingIndex, effectiveTabId, normalizedTarget, createdAt } = args;
  if (existingIndex < 0) {
    return [...currentTabs, { tabId: effectiveTabId, target: normalizedTarget, createdAt }];
  }
  const existing = currentTabs[existingIndex];
  if (existing && workspaceTabTargetsEqual(existing.target, normalizedTarget)) {
    return currentTabs;
  }
  return currentTabs.map((tab, index) =>
    retargetTabAtIndex(tab, index, existingIndex, normalizedTarget),
  );
}

export interface EnsureTabInput {
  serverId: string;
  workspaceId: string;
  target: WorkspaceTabTarget;
  now: number;
}

export interface EnsureTabResult {
  state: WorkspaceTabsCoreState;
  tabId: string | null;
}

export function applyEnsureTab(
  state: WorkspaceTabsCoreState,
  input: EnsureTabInput,
): EnsureTabResult {
  const key = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  const normalizedTarget = normalizeWorkspaceTabTarget(input.target);
  if (!key || !normalizedTarget) {
    return { state, tabId: null };
  }

  const deterministicTabId = buildDeterministicWorkspaceTabId(normalizedTarget);
  const currentTabs = state.uiTabsByWorkspace[key] ?? [];
  const tabWithSameTarget =
    currentTabs.find((tab) => workspaceTabTargetsEqual(tab.target, normalizedTarget)) ?? null;
  const effectiveTabId = tabWithSameTarget?.tabId ?? deterministicTabId;

  const currentOrder = state.tabOrderByWorkspace[key] ?? [];
  const nextOrder = ensureInOrder({ current: currentOrder, tabId: effectiveTabId });
  const existingIndex = currentTabs.findIndex((tab) => tab.tabId === effectiveTabId);
  const nextTabs = buildNextTabsForEnsure({
    currentTabs,
    existingIndex,
    effectiveTabId,
    normalizedTarget,
    createdAt: input.now,
  });

  const uiTabsByWorkspace =
    nextTabs === currentTabs
      ? state.uiTabsByWorkspace
      : { ...state.uiTabsByWorkspace, [key]: nextTabs };
  const tabOrderByWorkspace =
    nextOrder === currentOrder
      ? state.tabOrderByWorkspace
      : { ...state.tabOrderByWorkspace, [key]: nextOrder };

  if (
    uiTabsByWorkspace === state.uiTabsByWorkspace &&
    tabOrderByWorkspace === state.tabOrderByWorkspace
  ) {
    return { state, tabId: effectiveTabId };
  }

  return {
    state: { ...state, uiTabsByWorkspace, tabOrderByWorkspace },
    tabId: effectiveTabId,
  };
}

export interface FocusTabInput {
  serverId: string;
  workspaceId: string;
  tabId: string;
}

export function applyFocusTab(
  state: WorkspaceTabsCoreState,
  input: FocusTabInput,
): WorkspaceTabsCoreState {
  const key = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  const normalizedTabId = trimNonEmpty(input.tabId);
  if (!key || !normalizedTabId) {
    return state;
  }
  if (state.focusedTabIdByWorkspace[key] === normalizedTabId) {
    return state;
  }
  return {
    ...state,
    focusedTabIdByWorkspace: {
      ...state.focusedTabIdByWorkspace,
      [key]: normalizedTabId,
    },
  };
}

export function applyOpenOrFocusTab(
  state: WorkspaceTabsCoreState,
  input: EnsureTabInput,
): EnsureTabResult {
  const ensured = applyEnsureTab(state, input);
  if (!ensured.tabId) {
    return ensured;
  }
  const focused = applyFocusTab(ensured.state, {
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    tabId: ensured.tabId,
  });
  return { state: focused, tabId: ensured.tabId };
}

export interface OpenDraftTabInput {
  serverId: string;
  workspaceId: string;
  draftId: string;
  now: number;
}

export function applyOpenDraftTab(
  state: WorkspaceTabsCoreState,
  input: OpenDraftTabInput,
): EnsureTabResult {
  const normalizedDraftId = trimNonEmpty(input.draftId);
  if (!normalizedDraftId) {
    return { state, tabId: null };
  }
  return applyOpenOrFocusTab(state, {
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    target: { kind: "draft", draftId: normalizedDraftId },
    now: input.now,
  });
}

export interface CloseTabInput {
  serverId: string;
  workspaceId: string;
  tabId: string;
}

export function applyCloseTab(
  state: WorkspaceTabsCoreState,
  input: CloseTabInput,
): WorkspaceTabsCoreState {
  const key = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  const normalizedTabId = trimNonEmpty(input.tabId);
  if (!key || !normalizedTabId) {
    return state;
  }

  const currentTabs = state.uiTabsByWorkspace[key] ?? [];
  const nextTabs = currentTabs.filter((tab) => tab.tabId !== normalizedTabId);
  const currentOrder = state.tabOrderByWorkspace[key] ?? [];
  const nextOrder = currentOrder.filter((value) => value !== normalizedTabId);

  let nextUiTabsByWorkspace: Record<string, WorkspaceTab[]>;
  if (nextTabs.length === 0) {
    const { [key]: _removed, ...rest } = state.uiTabsByWorkspace;
    nextUiTabsByWorkspace = rest;
  } else if (nextTabs.length === currentTabs.length) {
    nextUiTabsByWorkspace = state.uiTabsByWorkspace;
  } else {
    nextUiTabsByWorkspace = { ...state.uiTabsByWorkspace, [key]: nextTabs };
  }

  let nextTabOrderByWorkspace: Record<string, string[]>;
  if (nextOrder.length === 0) {
    const { [key]: _removed, ...rest } = state.tabOrderByWorkspace;
    nextTabOrderByWorkspace = rest;
  } else if (nextOrder.length === currentOrder.length) {
    nextTabOrderByWorkspace = state.tabOrderByWorkspace;
  } else {
    nextTabOrderByWorkspace = { ...state.tabOrderByWorkspace, [key]: nextOrder };
  }

  const currentFocused = state.focusedTabIdByWorkspace[key] ?? null;
  const nextFocused =
    currentFocused !== normalizedTabId ? currentFocused : (nextOrder[nextOrder.length - 1] ?? null);
  const nextFocusedByWorkspace = (() => {
    if (!nextFocused) {
      const { [key]: _removed, ...rest } = state.focusedTabIdByWorkspace;
      return rest;
    }
    return { ...state.focusedTabIdByWorkspace, [key]: nextFocused };
  })();

  const tabsChanged = nextTabs.length !== currentTabs.length;
  const orderChanged = nextOrder.length !== currentOrder.length;
  const focusChanged =
    (state.focusedTabIdByWorkspace[key] ?? null) !== (nextFocusedByWorkspace[key] ?? null);

  if (!tabsChanged && !orderChanged && !focusChanged) {
    return state;
  }

  return {
    uiTabsByWorkspace: nextUiTabsByWorkspace,
    tabOrderByWorkspace: nextTabOrderByWorkspace,
    focusedTabIdByWorkspace: nextFocusedByWorkspace,
  };
}

export interface RetargetTabInput {
  serverId: string;
  workspaceId: string;
  tabId: string;
  target: WorkspaceTabTarget;
}

export function applyRetargetTab(
  state: WorkspaceTabsCoreState,
  input: RetargetTabInput,
): EnsureTabResult {
  const key = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  const normalizedTabId = trimNonEmpty(input.tabId);
  const normalizedTarget = normalizeWorkspaceTabTarget(input.target);
  if (!key || !normalizedTabId || !normalizedTarget) {
    return { state, tabId: null };
  }

  const currentTabs = state.uiTabsByWorkspace[key] ?? [];
  const index = currentTabs.findIndex((tab) => tab.tabId === normalizedTabId);
  if (index < 0) {
    return { state, tabId: null };
  }

  const currentTarget = currentTabs[index]?.target;
  if (currentTarget && workspaceTabTargetsEqual(currentTarget, normalizedTarget)) {
    return { state, tabId: null };
  }

  const nextTabs = currentTabs.map((tab, tabIndex) =>
    tabIndex === index ? Object.assign({}, tab, { target: normalizedTarget }) : tab,
  );

  return {
    state: {
      ...state,
      uiTabsByWorkspace: { ...state.uiTabsByWorkspace, [key]: nextTabs },
    },
    tabId: normalizedTabId,
  };
}

export interface ReorderTabsInput {
  serverId: string;
  workspaceId: string;
  tabIds: string[];
}

export function applyReorderTabs(
  state: WorkspaceTabsCoreState,
  input: ReorderTabsInput,
): WorkspaceTabsCoreState {
  const key = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  if (!key) {
    return state;
  }

  const normalized = normalizeTabOrder(input.tabIds);
  const current = state.tabOrderByWorkspace[key] ?? [];
  if (current.length === normalized.length) {
    let same = true;
    for (let i = 0; i < current.length; i += 1) {
      if (current[i] !== normalized[i]) {
        same = false;
        break;
      }
    }
    if (same) {
      return state;
    }
  }

  return {
    ...state,
    tabOrderByWorkspace: {
      ...state.tabOrderByWorkspace,
      [key]: normalized,
    },
  };
}

export interface PurgeWorkspaceInput {
  serverId: string;
  workspaceId: string;
}

export function applyPurgeWorkspace(
  state: WorkspaceTabsCoreState,
  input: PurgeWorkspaceInput,
): WorkspaceTabsCoreState {
  const key = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  if (!key) {
    return state;
  }
  if (
    !(key in state.uiTabsByWorkspace) &&
    !(key in state.tabOrderByWorkspace) &&
    !(key in state.focusedTabIdByWorkspace)
  ) {
    return state;
  }
  const { [key]: _tabs, ...remainingUiTabsByWorkspace } = state.uiTabsByWorkspace;
  const { [key]: _order, ...remainingTabOrderByWorkspace } = state.tabOrderByWorkspace;
  const { [key]: _focused, ...remainingFocusedTabIdByWorkspace } = state.focusedTabIdByWorkspace;
  return {
    ...state,
    uiTabsByWorkspace: remainingUiTabsByWorkspace,
    tabOrderByWorkspace: remainingTabOrderByWorkspace,
    focusedTabIdByWorkspace: remainingFocusedTabIdByWorkspace,
  };
}

export function selectWorkspaceTabs(
  state: WorkspaceTabsCoreState,
  input: { serverId: string; workspaceId: string },
): WorkspaceTab[] {
  const key = buildWorkspaceTabPersistenceKey(input);
  if (!key) {
    return [];
  }
  return state.uiTabsByWorkspace[key] ?? [];
}

interface MigrationRawSources {
  rawUiTabsByWorkspace: Record<string, unknown>;
  rawFocused: Record<string, unknown>;
  rawOrder: Record<string, unknown>;
  legacyOrder: Record<string, unknown>;
}

function extractMigrationRawSources(persistedState: unknown): MigrationRawSources {
  const top = toObjectRecord(persistedState) ?? {};
  const rawState = toObjectRecord(top.state) ?? top;

  return {
    rawUiTabsByWorkspace:
      toObjectRecord(
        rawState.uiTabsByWorkspace ??
          rawState.openTabsByWorkspace ??
          top.uiTabsByWorkspace ??
          top.openTabsByWorkspace,
      ) ?? {},
    rawFocused:
      toObjectRecord(
        rawState.focusedTabIdByWorkspace ??
          rawState.lastFocusedTabByWorkspace ??
          top.focusedTabIdByWorkspace,
      ) ?? {},
    rawOrder: toObjectRecord(rawState.tabOrderByWorkspace ?? top.tabOrderByWorkspace) ?? {},
    legacyOrder:
      toObjectRecord(
        rawState.tabOrderByWorkspace ??
          rawState.tabOrderLegacyByWorkspace ??
          top.tabOrderLegacyByWorkspace,
      ) ?? {},
  };
}

function coerceWorkspaceTabTarget(raw: Record<string, unknown>): WorkspaceTabTarget | null {
  const kind = typeof raw.kind === "string" ? raw.kind : null;
  if (kind === "draft" && typeof raw.draftId === "string") {
    const setup = normalizeWorkspaceDraftTabSetup(raw.setup);
    return normalizeWorkspaceTabTarget({
      kind: "draft",
      draftId: raw.draftId,
      ...(setup ? { setup } : {}),
    });
  }
  if (kind === "agent" && typeof raw.agentId === "string") {
    return normalizeWorkspaceTabTarget({ kind: "agent", agentId: raw.agentId });
  }
  if (kind === "terminal" && typeof raw.terminalId === "string") {
    return normalizeWorkspaceTabTarget({ kind: "terminal", terminalId: raw.terminalId });
  }
  if (kind === "browser" && typeof raw.browserId === "string") {
    return normalizeWorkspaceTabTarget({ kind: "browser", browserId: raw.browserId });
  }
  if (kind === "file" && typeof raw.path === "string") {
    return normalizeWorkspaceTabTarget({
      kind: "file",
      path: raw.path,
      lineStart: typeof raw.lineStart === "number" ? raw.lineStart : undefined,
      lineEnd: typeof raw.lineEnd === "number" ? raw.lineEnd : undefined,
    });
  }
  if (kind === "setup" && typeof raw.workspaceId === "string") {
    return normalizeWorkspaceTabTarget({ kind: "setup", workspaceId: raw.workspaceId });
  }
  return null;
}

function migrateSingleTab(rawTab: unknown, now: number): WorkspaceTab | null {
  const record = toObjectRecord(rawTab);
  if (!record) {
    return null;
  }
  const rawTarget = toObjectRecord(record.target);
  const normalizedTarget = rawTarget ? coerceWorkspaceTabTarget(rawTarget) : null;
  if (!normalizedTarget) {
    return null;
  }
  const rawTabId = trimNonEmpty(typeof record.tabId === "string" ? record.tabId : null);
  const tabId = rawTabId ?? buildDeterministicWorkspaceTabId(normalizedTarget);
  const rawCreatedAt = record.createdAt;
  return {
    tabId,
    target: normalizedTarget,
    createdAt: typeof rawCreatedAt === "number" ? rawCreatedAt : now,
  };
}

interface MigratedTabsForKey {
  nextUiTabs: WorkspaceTab[];
  orderFromTabs: string[];
}

function migrateUiTabsForKey(rawEntries: unknown, now: number): MigratedTabsForKey {
  const entries = Array.isArray(rawEntries) ? rawEntries : [];
  const nextUiTabs: WorkspaceTab[] = [];
  const orderFromTabs: string[] = [];
  const usedOrder = new Set<string>();

  for (const rawTab of entries) {
    const migrated = migrateSingleTab(rawTab, now);
    if (!migrated) {
      continue;
    }
    if (!usedOrder.has(migrated.tabId)) {
      usedOrder.add(migrated.tabId);
      orderFromTabs.push(migrated.tabId);
    }
    nextUiTabs.push(migrated);
  }

  return { nextUiTabs, orderFromTabs };
}

function mergeExplicitTabOrder(
  tabOrderByWorkspace: Record<string, string[]>,
  rawOrder: Record<string, unknown>,
): void {
  for (const key in rawOrder) {
    const normalizedOrder = normalizeTabOrder(rawOrder[key]);
    if (normalizedOrder.length === 0) {
      continue;
    }
    const existing = tabOrderByWorkspace[key] ?? [];
    tabOrderByWorkspace[key] = normalizeTabOrder([...existing, ...normalizedOrder]);
  }
}

function convertLegacyOrderEntry(entry: unknown): string | null {
  const raw = typeof entry === "string" ? entry.trim() : "";
  if (!raw) {
    return null;
  }
  if (raw.startsWith("agent:")) {
    const agentId = raw.slice("agent:".length).trim();
    return agentId ? `agent_${agentId}` : null;
  }
  if (raw.startsWith("terminal:")) {
    const terminalId = raw.slice("terminal:".length).trim();
    return terminalId ? `terminal_${terminalId}` : null;
  }
  return null;
}

function normalizeLegacyOrderList(list: unknown[]): string[] {
  const result: string[] = [];
  for (const entry of list) {
    const converted = convertLegacyOrderEntry(entry);
    if (converted) {
      result.push(converted);
    }
  }
  return result;
}

function mergeLegacyTabOrder(
  tabOrderByWorkspace: Record<string, string[]>,
  legacyOrder: Record<string, unknown>,
): void {
  for (const key in legacyOrder) {
    const list = legacyOrder[key];
    if (!Array.isArray(list) || list.length === 0) {
      continue;
    }
    const normalizedLegacyOrder = normalizeLegacyOrderList(list);
    if (normalizedLegacyOrder.length === 0) {
      continue;
    }
    const existing = tabOrderByWorkspace[key] ?? [];
    tabOrderByWorkspace[key] = normalizeTabOrder([...existing, ...normalizedLegacyOrder]);
  }
}

function resolveFocusedTabId(rawValue: unknown): string | null {
  if (typeof rawValue === "string") {
    return trimNonEmpty(rawValue);
  }
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }
  const value = rawValue as {
    kind?: string;
    agentId?: string;
    terminalId?: string;
    draftId?: string;
  };
  if (value.kind === "agent" && typeof value.agentId === "string" && value.agentId.trim()) {
    return `agent_${value.agentId.trim()}`;
  }
  if (
    value.kind === "terminal" &&
    typeof value.terminalId === "string" &&
    value.terminalId.trim()
  ) {
    return `terminal_${value.terminalId.trim()}`;
  }
  if (value.kind === "draft" && typeof value.draftId === "string" && value.draftId.trim()) {
    return value.draftId.trim();
  }
  return null;
}

function migrateFocusedTabIds(
  focusedTabIdByWorkspace: Record<string, string>,
  rawFocused: Record<string, unknown>,
): void {
  for (const key in rawFocused) {
    const resolved = resolveFocusedTabId(rawFocused[key]);
    if (resolved) {
      focusedTabIdByWorkspace[key] = resolved;
    }
  }
}

export function migrateWorkspaceTabsState(
  persistedState: unknown,
  options: { now: number },
): WorkspaceTabsCoreState {
  const { rawUiTabsByWorkspace, rawFocused, rawOrder, legacyOrder } =
    extractMigrationRawSources(persistedState);

  const uiTabsByWorkspace: Record<string, WorkspaceTab[]> = {};
  const tabOrderByWorkspace: Record<string, string[]> = {};
  const focusedTabIdByWorkspace: Record<string, string> = {};

  for (const key in rawUiTabsByWorkspace) {
    const { nextUiTabs, orderFromTabs } = migrateUiTabsForKey(
      rawUiTabsByWorkspace[key],
      options.now,
    );
    if (nextUiTabs.length > 0) {
      uiTabsByWorkspace[key] = nextUiTabs;
    }
    if (orderFromTabs.length > 0) {
      tabOrderByWorkspace[key] = orderFromTabs;
    }
  }

  mergeExplicitTabOrder(tabOrderByWorkspace, rawOrder);
  mergeLegacyTabOrder(tabOrderByWorkspace, legacyOrder);
  migrateFocusedTabIds(focusedTabIdByWorkspace, rawFocused);

  return {
    uiTabsByWorkspace,
    tabOrderByWorkspace,
    focusedTabIdByWorkspace,
  };
}

export function partializeWorkspaceTabsState(
  state: WorkspaceTabsCoreState,
  options: { now: number },
): WorkspaceTabsCoreState {
  const nextUiTabsByWorkspace: Record<string, WorkspaceTab[]> = {};
  for (const key in state.uiTabsByWorkspace) {
    const tabs = (state.uiTabsByWorkspace[key] ?? [])
      .map((tab) => {
        const normalizedTarget = normalizeWorkspaceTabTarget(tab.target);
        const normalizedTabId = trimNonEmpty(tab.tabId);
        if (!normalizedTarget || !normalizedTabId) {
          return null;
        }
        return {
          tabId: normalizedTabId,
          target: normalizedTarget,
          createdAt: typeof tab.createdAt === "number" ? tab.createdAt : options.now,
        } satisfies WorkspaceTab;
      })
      .filter((tab): tab is WorkspaceTab => tab !== null);
    if (tabs.length > 0) {
      nextUiTabsByWorkspace[key] = tabs;
    }
  }

  const nextTabOrderByWorkspace: Record<string, string[]> = {};
  for (const key in state.tabOrderByWorkspace) {
    const order = normalizeTabOrder(state.tabOrderByWorkspace[key]);
    if (order.length > 0) {
      nextTabOrderByWorkspace[key] = order;
    }
  }

  const nextFocusedTabIdByWorkspace: Record<string, string> = {};
  for (const key in state.focusedTabIdByWorkspace) {
    const focusedTabId = trimNonEmpty(state.focusedTabIdByWorkspace[key]);
    if (focusedTabId) {
      nextFocusedTabIdByWorkspace[key] = focusedTabId;
    }
  }

  return {
    uiTabsByWorkspace: nextUiTabsByWorkspace,
    tabOrderByWorkspace: nextTabOrderByWorkspace,
    focusedTabIdByWorkspace: nextFocusedTabIdByWorkspace,
  };
}
