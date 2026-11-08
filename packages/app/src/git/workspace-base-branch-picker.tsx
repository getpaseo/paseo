import { useCallback, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { GitBranch } from "lucide-react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { Combobox, ComboboxItem, type ComboboxProps } from "@/components/ui/combobox";
import { ToolbarLabelSelectTrigger } from "@/components/ui/toolbar-label-trigger";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { invalidateCheckoutGitQueriesForClient } from "./query-keys";

interface Props {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  baseRef: string;
}

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedGitBranch = withUnistyles(GitBranch);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function refLabel(ref: string): string {
  return ref.replace(/^refs\/(heads|remotes)\//, "");
}

export function WorkspaceBaseBranchPicker({ serverId, workspaceId, cwd, baseRef }: Props) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  // COMPAT(workspaceBaseBranch): added after v0.11.2, remove gate after 2027-10-14.
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.workspaceBaseBranch === true,
  );
  const queryClient = useQueryClient();
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search, 200);
  const branches = useFetchQuery({
    queryKey: ["workspaceBaseBranches", serverId, cwd, query],
    queryFn: async () => {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      const result = await client.getBranchSuggestions({
        cwd,
        refMode: "exact",
        query,
        limit: 200,
      });
      if (result.error) throw new Error(result.error);
      return result.branches;
    },
    enabled: open && supported && connected && Boolean(client),
    retry: false,
    dataShape: "value",
    staleTimeMs: 0,
  });
  const mutation = useMutation({
    mutationFn: async (ref: string) => {
      if (!client || !workspaceId) throw new Error(t("common.errors.daemonClientUnavailable"));
      return client.setWorkspaceBaseBranch({ workspaceId, baseRef: ref });
    },
    onSuccess: async () => {
      setOpen(false);
      await invalidateCheckoutGitQueriesForClient(queryClient, { serverId, cwd });
    },
  });
  const options = useMemo(
    () => (branches.data ?? []).map((ref) => ({ id: ref, label: refLabel(ref) })),
    [branches.data],
  );
  const error = mutation.error ?? branches.error;
  const title = t("workspace.git.diff.baseBranch.title");
  const label = refLabel(baseRef).replace(/^origin\//, "");

  const { reset, mutate, isPending } = mutation;
  const { refetch, isError } = branches;
  const handleOpen = useCallback(() => {
    reset();
    setSearch("");
    setOpen(true);
  }, [reset]);
  const handleSelect = useCallback(
    (ref: string) => {
      if (!isPending) mutate(ref);
    },
    [isPending, mutate],
  );
  const handleRetry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const branchIcon = useMemo(() => <ThemedGitBranch size={14} uniProps={mutedColor} />, []);
  const renderOption = useCallback<NonNullable<ComboboxProps["renderOption"]>>(
    ({ option, selected, active, onPress }) => (
      <ComboboxItem
        label={option.label}
        leadingSlot={branchIcon}
        selected={selected}
        active={active}
        onPress={onPress}
        disabled={isPending}
      />
    ),
    [isPending, branchIcon],
  );
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        {isPending ? <ThemedLoadingSpinner size="small" uniProps={mutedColor} /> : null}
        {error ? (
          <Text accessibilityRole="alert" testID="workspace-base-branch-error" style={styles.error}>
            {error.message}
          </Text>
        ) : null}
        {isError ? (
          <Button variant="outline" onPress={handleRetry}>
            {t("common.actions.retry")}
          </Button>
        ) : null}
      </View>
    ),
    [t, isPending, error, isError, handleRetry],
  );

  if (!supported || !workspaceId) return <Text style={styles.text}>{label}</Text>;

  return (
    <View ref={anchorRef} collapsable={false} style={styles.anchor}>
      <ToolbarLabelSelectTrigger
        testID="workspace-base-branch-trigger"
        label={label}
        open={open}
        disabled={!connected || mutation.isPending}
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={handleOpen}
      />
      <Combobox
        options={options}
        value={baseRef}
        onSelect={handleSelect}
        keepOpenOnSelect
        searchable
        onSearchQueryChange={setSearch}
        searchPlaceholder={t("branchSwitcher.searchPlaceholder")}
        emptyText={branches.isFetching ? t("common.states.loading") : t("branchSwitcher.empty")}
        title={title}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
        desktopPreventInitialFlash
        desktopMinWidth={300}
        renderOption={renderOption}
        footer={error || isPending ? footer : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The branch name truncates first so a short base like "main" stays readable; the cap lets
  // a long base still truncate instead of overflowing the header.
  anchor: { flexShrink: 0, minWidth: 0, maxWidth: "40%" },
  footer: { padding: theme.spacing[3], gap: theme.spacing[2] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
