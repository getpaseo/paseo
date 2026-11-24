import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { CheckoutWorktree, TerminalProfile } from "@getpaseo/protocol/messages";
import { Combobox, type ComboboxOption, type ComboboxProps } from "@/components/ui/combobox";
import { HostStatusDot } from "@/components/host-status-dot";
import { HostPicker } from "@/components/hosts/host-picker";
import type { LaunchTarget } from "@/new-workspace-launch/target";
import type { HostProjectListItem } from "@/projects/host-projects";
import type { HostProfile } from "@/types/host-connection";
import { shortenPath } from "@/utils/shorten-path";
import {
  branchNameFromRef,
  refListOptions,
  type PickerItem,
  type RefAction,
} from "../../new-workspace-picker-item";
import type { ExistingWorktree } from "../existing-worktrees";
import { worktreeHoldingBranch } from "../setup-model";
import {
  FIELD_BADGE_HEIGHT,
  FIELD_HEIGHT,
  FieldTrigger,
  type FieldTriggerVariant,
} from "./field-trigger";
import {
  branchIcon,
  existingWorktreeIcon,
  folderIcon,
  ProjectIcon,
  pullRequestIcon,
} from "./icons";
import { LaunchControl } from "./launch-control";
import {
  AddProjectOption,
  IsolationOption,
  ProjectOption,
  RefOption,
  WorktreeOption,
  type BranchHolder,
} from "./options";
import { RefPickerToolbar, type RefList } from "./ref-picker-toolbar";

type Isolation = "local" | "worktree";
/** The Isolation field's choice. Existing worktree creates a local workspace at the worktree. */
export type IsolationChoice = Isolation | "existing";
type RenderOption = NonNullable<ComboboxProps["renderOption"]>;

interface PickerControl {
  anchorRef: RefObject<View | null>;
  open: () => void;
  openState: boolean;
  onOpenChange: (open: boolean) => void;
}

export interface NewWorkspaceFormProps {
  isCompact: boolean;
  isPending: boolean;
  /** Plugin fields, drawn after the base ref. */
  pluginItems: ReactNode;
  project: PickerControl & {
    options: ComboboxOption[];
    projectByOptionId: Map<string, HostProjectListItem>;
    iconDataByProjectViewKey: Map<string, string | null>;
    selectedProject: HostProjectListItem | null;
    selectedOptionId: string;
    triggerLabel: string;
    selectedServerId: string;
    /** COMPAT(workspaceMultiplicity): without it only worktree-capable projects are selectable. */
    supportsWorkspaceMultiplicity: boolean;
    onSelect: (id: string) => void;
    onAddProject: () => void;
  };
  host: PickerControl & {
    allHosts: HostProfile[];
    selectedServerId: string;
    onSelect: (id: string) => void;
    onAddHost: () => void;
  };
  isolation: PickerControl & {
    choice: IsolationChoice;
    canCreateWorktree: boolean;
    onSelect: (isolation: Isolation) => void;
    /** The project's worktrees other than its own directory, newest first. */
    existingWorktrees: readonly ExistingWorktree[];
    existingWorktreePath: string | null;
    onChooseExistingWorktree: (path: string) => void;
  };
  base: PickerControl & {
    selectedSourceDirectory: string | null;
    selectedItem: PickerItem | null;
    triggerLabel: string;
    options: ComboboxOption[];
    itemById: Map<string, PickerItem>;
    selectedOptionId: string;
    onSelect: (id: string) => void;
    setSearchQuery: (query: string) => void;
    emptyText: string;
    showRefPicker: boolean;
    /** Every git worktree of the project, to say where a branch is already checked out. */
    worktrees: readonly CheckoutWorktree[];
    actionFor: Record<RefList, RefAction>;
    onActionChange: (list: RefList, action: RefAction) => void;
    /** Whether the host lets the user pick the action; otherwise each list keeps its default. */
    canChooseAction: boolean;
    /** Selects the forge's change-request words, such as "Merge requests" on GitLab. */
    changeRequestContext: "mr" | undefined;
  };
  launch: {
    serverId: string;
    target: LaunchTarget;
    onChange: (target: LaunchTarget) => void;
    profiles: readonly TerminalProfile[];
    disabled: boolean;
  };
}

function hostOptionTestID(serverId: string): string {
  return `new-workspace-host-picker-option-${serverId}`;
}

function isProjectSelectable(
  project: HostProjectListItem,
  supportsWorkspaceMultiplicity: boolean,
): boolean {
  return (
    supportsWorkspaceMultiplicity ||
    project.hosts.some((host) => host.worktreeSupport !== "unsupported")
  );
}

function useProjectPicker(
  project: NewWorkspaceFormProps["project"],
  isPending: boolean,
): { renderOption: RenderOption; footer: ReactNode } {
  const { projectByOptionId, iconDataByProjectViewKey, selectedServerId } = project;
  const { supportsWorkspaceMultiplicity, onAddProject } = project;
  const renderOption = useCallback<RenderOption>(
    (row) => {
      const item = projectByOptionId.get(row.option.id);
      return (
        <ProjectOption
          {...row}
          project={item}
          iconDataUri={item ? (iconDataByProjectViewKey.get(item.viewKey) ?? null) : null}
          selectedServerId={selectedServerId}
          disabled={isPending || !item || !isProjectSelectable(item, supportsWorkspaceMultiplicity)}
        />
      );
    },
    [
      iconDataByProjectViewKey,
      isPending,
      projectByOptionId,
      selectedServerId,
      supportsWorkspaceMultiplicity,
    ],
  );
  const footer = useMemo(() => <AddProjectOption onPress={onAddProject} />, [onAddProject]);
  return { renderOption, footer };
}

function useIsolationPicker(input: {
  isolation: NewWorkspaceFormProps["isolation"];
  projectDirectory: string | null;
  isPending: boolean;
}): {
  /** The trigger's value and icon for the choice. */
  value: string;
  icon: ReactElement;
  options: ComboboxOption[];
  onSelect: (id: string) => void;
  renderOption: RenderOption;
} {
  const { t } = useTranslation();
  const { isolation, projectDirectory, isPending } = input;
  const { canCreateWorktree, choice, existingWorktrees, onSelect, onOpenChange } = isolation;
  const { existingWorktreePath, onChooseExistingWorktree } = isolation;
  const newestWorktree = existingWorktrees[0];
  // The worktree options are omitted entirely (not disabled) when they cannot apply: a project
  // that is not a git checkout has no worktrees, and one with none has nothing to reuse.
  const options = useMemo<ComboboxOption[]>(() => {
    const local = {
      id: "local",
      label: t("newWorkspace.isolation.local"),
      description: projectDirectory ? shortenPath(projectDirectory) : undefined,
    };
    if (!canCreateWorktree) return [local];
    const worktree = { id: "worktree", label: t("newWorkspace.isolation.worktree") };
    if (!newestWorktree) return [local, worktree];
    return [local, worktree, { id: "existing", label: t("newWorkspace.isolation.existing") }];
  }, [canCreateWorktree, newestWorktree, projectDirectory, t]);
  const handleSelect = useCallback(
    (id: string) => {
      // The newest worktree is the likeliest one to return to, so it is the first pick.
      if (id === "existing" && newestWorktree) {
        onChooseExistingWorktree(existingWorktreePath ?? newestWorktree.path);
      } else if (id === "local" || id === "worktree") {
        onSelect(id);
      }
      onOpenChange(false);
    },
    [existingWorktreePath, newestWorktree, onChooseExistingWorktree, onOpenChange, onSelect],
  );
  const renderOption = useCallback<RenderOption>(
    (row) => <IsolationOption {...row} disabled={isPending} />,
    [isPending],
  );
  const value = {
    local: t("newWorkspace.isolation.local"),
    worktree: t("newWorkspace.isolation.worktree"),
    existing: t("newWorkspace.isolation.existing"),
  }[choice];
  const icon = { local: folderIcon, worktree: branchIcon, existing: existingWorktreeIcon }[choice];
  return { value, icon, options, onSelect: handleSelect, renderOption };
}

/** Picks which existing worktree the workspace works in. */
function useWorktreePicker(isolation: NewWorkspaceFormProps["isolation"], isPending: boolean) {
  const { existingWorktrees, existingWorktreePath, onChooseExistingWorktree } = isolation;
  const anchorRef = useRef<View>(null);
  const [openState, setOpenState] = useState(false);
  const selected = existingWorktrees.find((worktree) => worktree.path === existingWorktreePath);
  const options = useMemo<ComboboxOption[]>(
    () => existingWorktrees.map((worktree) => ({ id: worktree.path, label: worktree.name })),
    [existingWorktrees],
  );
  const open = useCallback(() => setOpenState(true), []);
  const onSelect = useCallback(
    (path: string) => {
      onChooseExistingWorktree(path);
      setOpenState(false);
    },
    [onChooseExistingWorktree],
  );
  const renderOption = useCallback<RenderOption>(
    (row) => (
      <WorktreeOption
        {...row}
        worktree={existingWorktrees.find((worktree) => worktree.path === row.option.id)}
        disabled={isPending}
      />
    ),
    [existingWorktrees, isPending],
  );
  return {
    anchorRef,
    openState,
    onOpenChange: setOpenState,
    open,
    selected,
    options,
    onSelect,
    renderOption,
  };
}

function refListOf(item: PickerItem | null | undefined): RefList {
  return item?.kind ?? "branch";
}

/** Where a checkout of `item` would work, when a worktree already has the branch. */
function branchHolderOf(
  item: PickerItem | undefined,
  action: RefAction,
  worktrees: readonly CheckoutWorktree[],
): BranchHolder {
  if (item?.kind !== "branch" || action !== "checkout") return null;
  const holder = worktreeHoldingBranch(worktrees, branchNameFromRef(item.refName));
  if (!holder) return null;
  return holder.containsCwd ? "project-directory" : "worktree";
}

/**
 * The ref picker's two lists, the action control, and what the trigger says. Branching off reads
 * "from <ref>" on a badge, which has no label of its own; working on the pick names what it is.
 */
function useRefPicker(base: NewWorkspaceFormProps["base"], isPending: boolean) {
  const { t } = useTranslation();
  const { options: allOptions, itemById, selectedItem, selectedOptionId, worktrees } = base;
  const { open: openPicker, onSelect, actionFor, onActionChange } = base;
  const context = base.changeRequestContext;
  const [list, setList] = useState<RefList>("branch");
  const action = actionFor[list];
  const options = useMemo(
    () => refListOptions({ options: allOptions, itemById, selectedOptionId, kind: list, action }),
    [action, allOptions, itemById, list, selectedOptionId],
  );
  // Opens on the list the current pick is in.
  const open = useCallback(() => {
    setList(refListOf(selectedItem));
    openPicker();
  }, [openPicker, selectedItem]);
  const handleActionChange = useCallback(
    (next: RefAction) => onActionChange(list, next),
    [list, onActionChange],
  );
  const renderOption = useCallback<RenderOption>(
    (row) => {
      const item = itemById.get(row.option.id);
      return (
        <RefOption
          {...row}
          item={item}
          heldIn={branchHolderOf(item, action, worktrees)}
          disabled={isPending}
        />
      );
    },
    [action, isPending, itemById, worktrees],
  );
  const toolbar = useMemo(
    () => (
      <RefPickerToolbar
        list={list}
        onListChange={setList}
        action={action}
        onActionChange={handleActionChange}
        canChooseAction={base.canChooseAction}
        changeRequestContext={context}
      />
    ),
    [action, base.canChooseAction, context, handleActionChange, list],
  );
  const shown = itemById.get(selectedOptionId);
  const shownList = refListOf(shown);
  const shownAction = actionFor[shownList];
  const icon = shownList === "github-pr" ? pullRequestIcon : branchIcon;
  const checksOutBranch = shown?.kind === "branch" && shownAction === "checkout";
  const trigger =
    shownAction === "branch-off"
      ? { label: t("newWorkspace.refPicker.base"), qualifier: t("newWorkspace.refPicker.from") }
      : {
          label:
            shownList === "github-pr"
              ? t("newWorkspace.refPicker.pullRequest", { context })
              : t("newWorkspace.refPicker.branch"),
          qualifier: undefined,
        };
  return {
    options,
    open,
    onSelect,
    renderOption,
    toolbar,
    searchPlaceholder:
      list === "github-pr"
        ? t("newWorkspace.refPicker.searchPullRequests", { context })
        : t("newWorkspace.refPicker.searchBranches"),
    trigger: {
      ...trigger,
      icon,
      // A checkout works on the branch itself, so its origin and local rows read the same.
      value: checksOutBranch ? branchNameFromRef(shown.refName) : base.triggerLabel,
    },
  };
}

/**
 * The New workspace setup fields, one trigger per field, each opening its picker. Compact: a stack
 * of full-width fields with the label inside. Desktop: one meta row of badges. Either way, a field
 * that does not apply to the selected project is left out. Host always shows, even with one host, so
 * its Add host action keeps multi-host discoverable.
 */
export function useNewWorkspaceForm(props: NewWorkspaceFormProps): ReactElement {
  const { t } = useTranslation();
  const { isCompact, isPending, pluginItems, project, host, isolation, base, launch } = props;
  const variant: FieldTriggerVariant = isCompact ? "field" : "badge";
  const projectPicker = useProjectPicker(project, isPending);
  const isolationPicker = useIsolationPicker({
    isolation,
    projectDirectory: base.selectedSourceDirectory,
    isPending,
  });
  const worktreePicker = useWorktreePicker(isolation, isPending);
  const refPicker = useRefPicker(base, isPending);

  const selectedHostLabel =
    host.allHosts.find((h) => h.serverId === host.selectedServerId)?.label ?? "Host";
  const selectedProject = project.selectedProject;
  const selectedProjectIconUri = selectedProject
    ? (project.iconDataByProjectViewKey.get(selectedProject.viewKey) ?? null)
    : null;
  const projectIcon = useMemo(
    () =>
      selectedProject ? (
        <ProjectIcon
          projectViewKey={selectedProject.viewKey}
          projectName={selectedProject.projectName}
          iconDataUri={selectedProjectIconUri}
        />
      ) : (
        folderIcon
      ),
    [selectedProject, selectedProjectIconUri],
  );
  const hostIcon = useMemo(
    () => <HostStatusDot serverId={host.selectedServerId} />,
    [host.selectedServerId],
  );
  const { choice } = isolation;

  const projectField = (
    <FieldTrigger
      ref={project.anchorRef}
      variant={variant}
      label={t("newWorkspace.fields.project")}
      accessibilityLabel="Workspace project"
      tooltip={t("newWorkspace.tooltips.project")}
      shortcutAction="new-workspace"
      icon={projectIcon}
      value={project.triggerLabel}
      onPress={project.open}
      disabled={isPending}
      testID="new-workspace-project-picker-trigger"
    />
  );
  const hostField = (
    <HostPicker
      hosts={host.allHosts}
      value={host.selectedServerId}
      onSelect={host.onSelect}
      open={host.openState}
      onOpenChange={host.onOpenChange}
      anchorRef={host.anchorRef}
      includeAddHost
      onAddHost={host.onAddHost}
      addHostTestID="new-workspace-host-picker-add-host"
      searchable={false}
      title={t("newWorkspace.fields.host")}
      desktopPlacement="bottom-start"
      desktopMinWidth={320}
      hostOptionTestID={hostOptionTestID}
    >
      <FieldTrigger
        ref={host.anchorRef}
        variant={variant}
        label={t("newWorkspace.fields.host")}
        tooltip={t("newWorkspace.tooltips.host")}
        icon={hostIcon}
        value={selectedHostLabel}
        onPress={host.open}
        disabled={isPending}
        testID="host-picker-trigger"
      />
    </HostPicker>
  );
  const isolationField = isolation.canCreateWorktree ? (
    <FieldTrigger
      ref={isolation.anchorRef}
      variant={variant}
      label={t("newWorkspace.isolation.label")}
      accessibilityLabel="Workspace isolation"
      tooltip={t("newWorkspace.tooltips.isolation")}
      icon={isolationPicker.icon}
      value={isolationPicker.value}
      onPress={isolation.open}
      disabled={isPending}
      testID="workspace-create-isolation-trigger"
    />
  ) : null;
  const worktreeField =
    choice === "existing" && worktreePicker.selected ? (
      <FieldTrigger
        ref={worktreePicker.anchorRef}
        variant={variant}
        label={t("newWorkspace.worktreePicker.title")}
        tooltip={t("newWorkspace.tooltips.worktree")}
        icon={branchIcon}
        value={worktreePicker.selected.name}
        onPress={worktreePicker.open}
        disabled={isPending}
        testID="new-workspace-worktree-picker-trigger"
      />
    ) : null;
  const refField =
    base.showRefPicker && !worktreeField ? (
      <FieldTrigger
        ref={base.anchorRef}
        variant={variant}
        label={refPicker.trigger.label}
        accessibilityLabel={t("newWorkspace.refPicker.startingRef")}
        tooltip={t("newWorkspace.tooltips.startingRef")}
        icon={refPicker.trigger.icon}
        qualifier={refPicker.trigger.qualifier}
        value={refPicker.trigger.value}
        onPress={refPicker.open}
        disabled={isPending || !base.selectedSourceDirectory}
        testID="new-workspace-ref-picker-trigger"
      />
    ) : null;
  // Which one shows follows the isolation; they share a slot.
  const baseField = worktreeField ?? refField;
  const launchField = (
    <LaunchControl
      variant={variant}
      serverId={launch.serverId}
      target={launch.target}
      onChange={launch.onChange}
      profiles={launch.profiles}
      disabled={launch.disabled}
    />
  );

  const pickers = (
    <>
      <Combobox
        options={project.options}
        value={project.selectedOptionId}
        onSelect={project.onSelect}
        searchable
        searchPlaceholder="Search projects"
        title={t("newWorkspace.fields.project")}
        open={project.openState}
        onOpenChange={project.onOpenChange}
        desktopPlacement="bottom-start"
        desktopMinWidth={360}
        anchorRef={project.anchorRef}
        emptyText="No projects available."
        renderOption={projectPicker.renderOption}
        footer={projectPicker.footer}
      />
      <Combobox
        options={isolationPicker.options}
        value={choice}
        onSelect={isolationPicker.onSelect}
        title={t("newWorkspace.isolation.label")}
        open={isolation.openState}
        onOpenChange={isolation.onOpenChange}
        searchable={false}
        desktopPlacement="bottom-start"
        anchorRef={isolation.anchorRef}
        desktopMinWidth={280}
        renderOption={isolationPicker.renderOption}
      />
      <Combobox
        options={refPicker.options}
        value={base.selectedOptionId}
        onSelect={refPicker.onSelect}
        searchable
        searchPlaceholder={refPicker.searchPlaceholder}
        title={t("newWorkspace.refPicker.title")}
        open={base.openState}
        onOpenChange={base.onOpenChange}
        onSearchQueryChange={base.setSearchQuery}
        desktopPlacement="bottom-start"
        desktopMinWidth={440}
        anchorRef={base.anchorRef}
        emptyText={base.emptyText}
        toolbar={refPicker.toolbar}
        renderOption={refPicker.renderOption}
      />
      <Combobox
        options={worktreePicker.options}
        value={worktreePicker.selected?.path ?? ""}
        onSelect={worktreePicker.onSelect}
        searchable
        searchPlaceholder={t("newWorkspace.worktreePicker.searchPlaceholder")}
        title={t("newWorkspace.worktreePicker.title")}
        open={worktreePicker.openState}
        onOpenChange={worktreePicker.onOpenChange}
        desktopPlacement="bottom-start"
        desktopMinWidth={360}
        anchorRef={worktreePicker.anchorRef}
        emptyText={t("newWorkspace.worktreePicker.empty")}
        renderOption={worktreePicker.renderOption}
      />
    </>
  );

  if (isCompact) {
    return (
      <View testID="new-workspace-ref-picker-row" style={styles.compactStack}>
        {projectField}
        {hostField}
        {isolationField}
        {baseField}
        {pluginItems}
        {launchField}
        {/* Isolation and Base come and go with the project; their rows stay reserved so the
            stack keeps one height and nothing above the composer jumps. */}
        {isolationField ? null : <View style={styles.reservedField} pointerEvents="none" />}
        {baseField ? null : <View style={styles.reservedField} pointerEvents="none" />}
        {pickers}
      </View>
    );
  }

  return (
    <View testID="new-workspace-ref-picker-row" style={styles.desktopRow} pointerEvents="box-none">
      <View style={styles.desktopControl}>{projectField}</View>
      <View style={styles.desktopControl}>{hostField}</View>
      {isolationField ? <View style={styles.desktopControl}>{isolationField}</View> : null}
      {baseField ? <View style={styles.desktopControl}>{baseField}</View> : null}
      {pluginItems}
      <View style={styles.launchSpacer} pointerEvents="none" />
      {launchField}
      {pickers}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  compactStack: {
    marginBottom: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  reservedField: {
    height: FIELD_HEIGHT,
  },
  desktopRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: FIELD_BADGE_HEIGHT,
    // Matches the gap between the composer and the Import session pill below it.
    marginBottom: theme.spacing[4],
    // The badge adds its own left padding; offset it so the project icon's left
    // edge lands exactly on the "New workspace" title's left edge. The trailing
    // inset mirrors it so the launch chip stops on the composer's inner content
    // rather than running out to the composer's border.
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  desktopControl: {
    minWidth: 0,
    flexShrink: 1,
  },
  // Pushes the launch control to the trailing edge of the desktop meta row.
  launchSpacer: {
    flex: 1,
  },
}));
