import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useFetchQuery } from "@/data/query";
import { createNameId } from "mnemonic-id";
import type {
  DaemonClient,
  CreateWorkspaceRequestOptions,
} from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import { WorktreeFields } from "./worktree-fields";
import type { WorktreeBranchPickerProps } from "./worktree-branch-picker";
import {
  openWorktreeForm,
  worktreeFormError,
  worktreeFormSource,
  type ExistingWorktree,
  type WorktreeFormModel,
} from "./worktree-form-model";
import {
  buildPickerOptionData,
  type PickerItem,
  type BranchPickerDetail,
} from "../new-workspace-picker-item";
import type { ForgeSearchItem } from "@getpaseo/protocol/messages";

/** Adapts host data into the form model without reconstructing an in-progress form. */
export function useWorktreeOptions(input: {
  supported: boolean;
  enabled: boolean;
  pickerOpen: boolean;
  canCreateWorktree: boolean;
  showRefPicker: boolean;
  isolationLabel: string;
  serverId: string;
  cwd: string | null;
  withClient: () => DaemonClient;
  item: PickerItem | null;
  isolation: "local" | "worktree";
  compact: boolean;
  pending: boolean;
}) {
  const [model] = useState(() => openWorktreeForm(createNameId()));
  const state = useSyncExternalStore(model.subscribe, model.getState);
  const scope = `${input.serverId}:${input.cwd ?? ""}`;
  useEffect(() => () => model.close(), [model]);
  useEffect(() => {
    model.applyScope(scope);
  }, [model, scope]);
  const baseItem = useMemo(
    () => normalizeCheckoutItem(input.item, input.supported && state.mode === "checkout"),
    [input.item, input.supported, state.mode],
  );
  useEffect(() => {
    model.applyRef(baseItem);
  }, [model, baseItem]);
  const existing = state.scope === scope ? state.existing : null;
  const listAvailability = worktreeListAvailability(input, existing !== null);
  const query = useFetchQuery({
    queryKey: ["new-workspace-worktrees", input.serverId, input.cwd],
    queryFn: async () => {
      if (!input.cwd) throw new Error("Choose a project");
      const result = await input
        .withClient()
        .getPaseoWorktreeList({ cwd: input.cwd, includeAll: true });
      if (result.error) throw new Error(result.error.message);
      return result.worktrees;
    },
    enabled: listAvailability.enabled,
    // Previous-repository rows must not remain selectable while a new repository loads.
    dataShape: "value",
    staleTimeMs: 15_000,
  });
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const select = useCallback(
    (id: string) => {
      model.selectExisting(
        query.data?.find((entry) => `existing:${entry.worktreePath}` === id) ?? null,
      );
    },
    [model, query.data],
  );
  // Re-read occupancy on submit; cached rows cannot authorize creating or adopting a checkout.
  const prepareSource = useCallback(
    async (request: {
      createsWorktree: boolean;
      projectId: string;
      refName?: string;
    }): Promise<CreateWorkspaceRequestOptions["source"] | undefined> => {
      if (!request.createsWorktree && !existing) return undefined;
      if (!input.supported) {
        if (model.requiresCapability()) {
          throw new Error("Update this host to use the selected worktree options.");
        }
        return undefined;
      }
      const result = await refetch();
      if (result.error) throw result.error;
      if (existing && !result.data?.some((entry) => entry.worktreePath === existing.worktreePath)) {
        throw new Error("The selected worktree no longer exists. Choose another worktree.");
      }
      if (!existing && baseItem?.kind === "github-pr") return undefined;
      model.applyRef(baseItem);
      if (!existing) {
        const error = worktreeFormError(model.getState(), result.data ?? []);
        if (error) throw new Error(error);
      }
      return worktreeFormSource(
        { ...model.getState(), existing },
        {
          cwd: input.cwd!,
          projectId: request.projectId,
          refName: request.refName,
        },
      );
    },
    [input.supported, input.cwd, existing, baseItem, model, refetch],
  );
  const showFields =
    input.supported &&
    input.isolation === "worktree" &&
    !existing &&
    baseItem?.kind !== "github-pr";
  return {
    baseItem,
    existing,
    select,
    prepareSource,
    checkoutMode: input.supported && state.mode === "checkout",
    ...worktreePickerPresentation(state.mode, showFields, model.setMode),
    showRefPicker:
      input.showRefPicker && !existing && !(input.supported && state.mode === "checkout"),
    isolationProps: {
      selectedId: existing ? `existing:${existing.worktreePath}` : input.isolation,
      selectedLabel: existing
        ? `${existing.branchName ?? "Detached HEAD"} · ${existing.worktreePath}`
        : input.isolationLabel,
      emptyText: query.isFetching ? "Loading worktrees…" : undefined,
      footer: (
        <WorktreeListStatus
          supported={listAvailability.visible}
          loading={query.isFetching}
          error={query.error}
          onRetry={retry}
        />
      ),
    },
    options: existingWorktreeOptions(query.data),
    fields: (
      <WorktreeFields
        visible={showFields}
        model={model}
        compact={input.compact}
        disabled={input.pending}
      />
    ),
    error: <WorktreeLoadError supported={listAvailability.visible} error={query.error} />,
  };
}

/** Local uses no worktree data until its picker opens; cached failures stay scoped to that choice. */
function worktreeListAvailability(
  input: {
    supported: boolean;
    enabled: boolean;
    canCreateWorktree: boolean;
    cwd: string | null;
    pickerOpen: boolean;
    isolation: "local" | "worktree";
  },
  hasExisting: boolean,
) {
  const needed = input.pickerOpen || input.isolation === "worktree" || hasExisting;
  return {
    visible: input.supported && needed,
    enabled:
      input.supported && input.enabled && input.canCreateWorktree && Boolean(input.cwd) && needed,
  };
}

/** Keeps branch intent, visible prefix and accessible base-ref label consistent. */
function worktreePickerPresentation(
  mode: "branch-off" | "checkout",
  visible: boolean,
  onChange: WorktreeFormModel["setMode"],
) {
  if (!visible) return { branchMode: null, refLabel: null, refPrefix: null };
  return {
    branchMode: { value: mode, onChange },
    refLabel: "Base branch",
    refPrefix: "from",
  };
}

/** Checkout chooses a named branch; base-ref provenance only applies to branch-off. */
function normalizeCheckoutItem(item: PickerItem | null, checkout: boolean): PickerItem | null {
  if (!checkout || item?.kind !== "branch") return item;
  const name = item.refName.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "");
  return { ...item, name, refName: `refs/heads/${name}`, accessibilityLabel: `${name}, branch` };
}

/** Reuses the branch picker while keeping checkout choices distinct from base refs and PRs. */
export function worktreePickerOptions(input: {
  branchDetails: BranchPickerDetail[];
  prItems: ForgeSearchItem[];
  baseItem: PickerItem | null;
  checkout: boolean;
}) {
  return buildPickerOptionData({
    branchDetails: input.checkout
      ? input.branchDetails.map((detail) => ({ ...detail, hasLocal: true, hasRemote: false }))
      : input.branchDetails,
    prItems: input.checkout ? [] : input.prItems,
    baseItem: normalizeCheckoutItem(input.baseItem, input.checkout),
  });
}

export const NEW_BRANCH_OPTION_ID = "new-branch";

/** The combined branch choice has one new-branch row followed by actual existing branches. */
export function worktreeBranchChoiceOptions(input: {
  branchDetails: BranchPickerDetail[];
  baseItem: PickerItem | null;
  checkout: boolean;
}) {
  const data = worktreePickerOptions({
    ...input,
    // A branch-off base can refer to upstream rather than an available checkout branch.
    baseItem: input.checkout ? input.baseItem : null,
    checkout: true,
    prItems: [],
  });
  return {
    ...data,
    options: [{ id: NEW_BRANCH_OPTION_ID, label: "New branch" }, ...data.options],
    selectedOptionId: input.checkout ? data.selectedOptionId : NEW_BRANCH_OPTION_ID,
  };
}

/** Adapts combined branch choices into explicit mode and ref changes without resetting names. */
export function useWorktreeBranchChoice(input: {
  branchMode: { value: "branch-off" | "checkout"; onChange: WorktreeFormModel["setMode"] } | null;
  branchDetails: BranchPickerDetail[];
  baseItem: PickerItem | null;
  onSelectItem: (item: PickerItem) => void;
  onSearchQueryChange: (query: string) => void;
  onOpenChange: (open: boolean) => void;
}): WorktreeBranchPickerProps | null {
  const { branchMode, branchDetails, baseItem, onSelectItem, onSearchQueryChange, onOpenChange } =
    input;
  const checkout = branchMode?.value === "checkout";
  const choices = useMemo(
    () => worktreeBranchChoiceOptions({ branchDetails, baseItem, checkout }),
    [branchDetails, baseItem, checkout],
  );
  const onSelect = useCallback(
    (id: string) => {
      if (!branchMode) return;
      if (id === NEW_BRANCH_OPTION_ID) {
        branchMode.onChange("branch-off");
        return;
      }
      const item = choices.itemById.get(id);
      if (!item) return;
      branchMode.onChange("checkout");
      onSelectItem(item);
    },
    [branchMode, choices.itemById, onSelectItem],
  );
  if (!branchMode) return null;
  return {
    options: choices.options,
    value: choices.selectedOptionId,
    label:
      choices.options.find((option) => option.id === choices.selectedOptionId)?.label ??
      "New branch",
    onSelect,
    onSearchQueryChange,
    onOpenChange,
  };
}

/** Branch and absolute path distinguish checkout rows, including detached worktrees. */
function existingWorktreeOptions(entries: readonly ExistingWorktree[] = []) {
  return entries.map((entry) => ({
    id: `existing:${entry.worktreePath}`,
    label: `${entry.branchName ?? `Detached ${entry.head?.slice(0, 8) ?? "HEAD"}`} · ${entry.worktreePath}`,
  }));
}

function WorktreeLoadError({ supported, error }: { supported: boolean; error: Error | null }) {
  if (!supported || !error) return null;
  return (
    <Text testID="new-workspace-worktree-list-error" style={styles.error}>
      {error.message}
    </Text>
  );
}
const styles = StyleSheet.create((theme) => ({
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    padding: theme.spacing[3],
  },
}));

/** Loading stays distinct from a loaded repository with no additional checkouts. */
function WorktreeListStatus({
  supported,
  loading,
  error,
  onRetry,
}: {
  supported: boolean;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  if (!supported) return null;
  if (loading) return <Text style={styles.status}>Loading worktrees…</Text>;
  if (error)
    return (
      <Button variant="ghost" onPress={onRetry}>
        Retry loading worktrees
      </Button>
    );
  return null;
}
