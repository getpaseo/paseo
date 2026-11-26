import type { ClientForgeHostSnapshot } from "@/git/client-forge-registry";
import { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { getForgePresentation } from "@/git/forge";
import { PullRequestStateIcon } from "@/git/pull-request-state-icon";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { getHostProjectSourceDirectory, type HostProjectListItem } from "@/projects/host-projects";
import { ICON_SIZE } from "@/styles/theme";
import { pickerItemLabel, type PickerItem } from "../../new-workspace-picker-item";
import type { ExistingWorktree } from "../existing-worktrees";
import {
  addProjectIcon,
  branchIcon,
  existingWorktreeIcon,
  folderIcon,
  ProjectIcon,
  pullRequestIcon,
} from "./icons";

interface OptionRowState {
  option: ComboboxOption;
  selected: boolean;
  active: boolean;
  onPress: () => void;
}

function IconBox({ children }: { children: ReactElement }): ReactElement {
  return <View style={styles.iconBox}>{children}</View>;
}

export function ProjectOption({
  option,
  selected,
  active,
  onPress,
  project,
  iconDataUri,
  selectedServerId,
  disabled,
}: OptionRowState & {
  project: HostProjectListItem | undefined;
  iconDataUri: string | null;
  selectedServerId: string;
  disabled: boolean;
}): ReactElement {
  const leadingSlot = useMemo(
    () =>
      project ? (
        <IconBox>
          <ProjectIcon
            projectViewKey={project.viewKey}
            projectName={project.projectName}
            iconDataUri={iconDataUri}
          />
        </IconBox>
      ) : undefined,
    [iconDataUri, project],
  );
  if (!project) return <View key={option.id} />;
  return (
    <ComboboxItem
      testID={`new-workspace-project-picker-option-${project.viewKey}`}
      label={project.projectName}
      description={
        getHostProjectSourceDirectory(project, selectedServerId) ?? project.iconWorkingDir
      }
      selected={selected}
      active={active}
      disabled={disabled}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

export function AddProjectOption({ onPress }: { onPress: () => void }): ReactElement {
  const { t } = useTranslation();
  const openProjectKeys = useShortcutKeys("new-agent");
  const shortcut = useMemo(
    () => (openProjectKeys ? <Shortcut chord={openProjectKeys} /> : null),
    [openProjectKeys],
  );
  return (
    <ComboboxItem
      testID="new-workspace-project-picker-add-project"
      label={t("sidebar.actions.addProject")}
      onPress={onPress}
      leadingSlot={addProjectIcon}
      trailingSlot={shortcut}
    />
  );
}

const ISOLATION_LEADING: Record<string, ReactElement> = {
  local: <IconBox>{folderIcon}</IconBox>,
  worktree: <IconBox>{branchIcon}</IconBox>,
  existing: <IconBox>{existingWorktreeIcon}</IconBox>,
};

export function IsolationOption({
  option,
  selected,
  active,
  onPress,
  disabled,
}: OptionRowState & { disabled: boolean }): ReactElement {
  return (
    <ComboboxItem
      testID={`workspace-create-isolation-${option.id}`}
      label={option.label}
      description={option.description}
      selected={selected}
      active={active}
      disabled={disabled}
      onPress={onPress}
      leadingSlot={ISOLATION_LEADING[option.id]}
    />
  );
}

const branchLeading = <IconBox>{branchIcon}</IconBox>;
const pullRequestLeading = <IconBox>{pullRequestIcon}</IconBox>;

type PullRequestState = "open" | "merged" | "closed";
const PULL_REQUEST_STATES: Record<string, PullRequestState> = {
  open: "open",
  opened: "open",
  merged: "merged",
  closed: "closed",
};

function PullRequestLeading({ state }: { state: string }): ReactElement {
  const known = PULL_REQUEST_STATES[state.toLowerCase()];
  if (!known) return pullRequestLeading;
  return (
    <IconBox>
      <PullRequestStateIcon state={known} size={ICON_SIZE.sm} />
    </IconBox>
  );
}

function WorktreeAge({ createdAt }: { createdAt: Date | null }): ReactElement {
  return <Text style={styles.divergenceLabel}>{useCompactTimeAgo(createdAt)}</Text>;
}

export function WorktreeOption({
  option,
  selected,
  active,
  onPress,
  worktree,
  disabled,
}: OptionRowState & { worktree: ExistingWorktree | undefined; disabled: boolean }): ReactElement {
  const createdAt = worktree?.createdAt ?? null;
  const trailingSlot = useMemo(() => <WorktreeAge createdAt={createdAt} />, [createdAt]);
  if (!worktree) return <View key={option.id} />;
  return (
    <ComboboxItem
      testID={`new-workspace-worktree-picker-option-${worktree.name}`}
      label={worktree.name}
      selected={selected}
      active={active}
      disabled={disabled}
      onPress={onPress}
      leadingSlot={branchLeading}
      trailingSlot={trailingSlot}
    />
  );
}

/** Where a branch is already checked out, when checking it out means working there. */
export type BranchHolder = "project-directory" | "worktree" | null;

export function RefOption({
  option,
  selected,
  active,
  onPress,
  item,
  clientForgeHost,
  heldIn,
  disabled,
}: OptionRowState & {
  item: PickerItem | undefined;
  clientForgeHost: ClientForgeHostSnapshot;
  heldIn: BranchHolder;
  disabled: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const branchNote = item?.kind === "branch" ? item.divergenceLabel : undefined;
  const heldLabel = {
    "project-directory": t("newWorkspace.refPicker.inProjectDirectory"),
    worktree: t("newWorkspace.refPicker.inWorktree"),
  };
  const divergenceLabel = heldIn ? heldLabel[heldIn] : branchNote;
  const trailingSlot = useMemo(
    () =>
      divergenceLabel ? <Text style={styles.divergenceLabel}>{divergenceLabel}</Text> : undefined,
    [divergenceLabel],
  );
  const pullRequestState = item?.kind === "github-pr" ? item.item.state : null;
  const pullRequestLeadingSlot = useMemo(
    () => (pullRequestState === null ? undefined : <PullRequestLeading state={pullRequestState} />),
    [pullRequestState],
  );
  if (!item) return <View key={option.id} />;

  if (item.kind === "branch") {
    return (
      <ComboboxItem
        testID={`new-workspace-ref-picker-branch-${item.name}`}
        label={item.name}
        selected={selected}
        active={active}
        disabled={disabled}
        onPress={onPress}
        leadingSlot={branchLeading}
        trailingSlot={trailingSlot}
        accessibilityLabel={item.accessibilityLabel}
      />
    );
  }
  // The number is the row's identity and the title its name, so they read as two things.
  const { numberPrefix } = getForgePresentation(item.item.forge ?? "github", clientForgeHost);
  return (
    <ComboboxItem
      testID={`new-workspace-ref-picker-pr-${item.item.number}`}
      labelPrefix={`${numberPrefix}${item.item.number}`}
      label={item.item.title}
      selected={selected}
      active={active}
      disabled={disabled}
      onPress={onPress}
      leadingSlot={pullRequestLeadingSlot}
      accessibilityLabel={pickerItemLabel(item, clientForgeHost)}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  iconBox: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
  },
  divergenceLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
}));
