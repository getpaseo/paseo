import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import {
  MenuHint,
  MenuItem,
  MenuSeparator,
  MenuTextField,
  useMenuContext,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import type { Theme } from "@/styles/theme";
import {
  normalizeProjectGroupName,
  projectGroupKey,
  setProjectGroup,
  setProjectGroupOnProjects,
  useKnownProjectGroups,
  type ProjectGroupOutcome,
} from "@/project-groups";
import { openProjectGroupCreateModal } from "./create-modal-store";

/** The `MenuSubTrigger` on a project's menu that opens the picker. */
export const PROJECT_GROUP_PAGE_ID = "projectGroup";
/** The page behind a group header's "Rename group" row. */
export const PROJECT_GROUP_RENAME_PAGE_ID = "projectGroupRename";

const MENU_ICON_SIZE = 14;
const ThemedPlus = withUnistyles(Plus);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const CREATE_LEADING = <ThemedPlus size={MENU_ICON_SIZE} uniProps={mutedMapping} />;

const NO_PAGES: readonly MenuPageDefinition[] = [];

/**
 * The page behind a project's `Group` row, for whichever menu is asking.
 *
 * The kebab dropdown and the row's context menu open the same thing; one hook keeps them from
 * drifting apart. "New group…" inside it opens `ProjectGroupCreateModal`, a sheet rather than a
 * pushed page — naming a group and picking its members needs more room than a menu column gives.
 */
export function useProjectGroupMenuPages(
  project: SidebarProjectEntry | null,
): readonly MenuPageDefinition[] {
  const { t } = useTranslation();
  return useMemo(() => {
    if (!project) return NO_PAGES;
    return [
      {
        id: PROJECT_GROUP_PAGE_ID,
        title: t("sidebar.project.group.menu"),
        content: <ProjectGroupPickerPage project={project} />,
      },
    ];
  }, [project, t]);
}

/**
 * The rename page for a group header's menu. `resolveMembers` is called when the rename starts
 * rather than when the page rendered, so it sees whatever the hosts had confirmed by then.
 */
export function useProjectGroupRenamePages(input: {
  name: string;
  resolveMembers: () => readonly SidebarProjectEntry[];
}): readonly MenuPageDefinition[] {
  const { t } = useTranslation();
  return useMemo(
    () => [
      {
        id: PROJECT_GROUP_RENAME_PAGE_ID,
        title: t("sidebar.project.group.rename"),
        hoverIntent: false,
        content: <ProjectGroupRenamePage name={input.name} resolveMembers={input.resolveMembers} />,
      },
    ],
    [input.resolveMembers, input.name, t],
  );
}

export function projectGroupOutcomeMessage(
  t: (key: string) => string,
  outcome: ProjectGroupOutcome,
): string | null {
  switch (outcome.kind) {
    case "applied":
      return null;
    case "needs_host_update":
      return t("sidebar.project.group.updateHost");
    case "host_disconnected":
      return t("sidebar.project.group.hostDisconnected");
    case "failed":
      return t("sidebar.project.group.failed");
  }
}

/**
 * One in-flight group write and what the page shows about it.
 *
 * `run` answers "did a host apply this": false when the press was dropped as a duplicate and
 * false when the write failed, so a caller can only follow it with work that a refusal must not
 * do. The page stays open while the write runs and after it fails; only a host that said yes ends
 * the menu. A surface that closed on press would unmount the pending row and the error hint
 * before either could render.
 */
export function useProjectGroupMutation(onApplied: () => void) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not the state: two presses in one frame both see the stale `pending` and would both
  // write, and which write wins is then up to the hosts.
  const inFlightRef = useRef(false);
  const run = useCallback(
    async (mutate: () => Promise<ProjectGroupOutcome>): Promise<boolean> => {
      if (inFlightRef.current) return false;
      inFlightRef.current = true;
      setPending(true);
      setError(null);
      try {
        const outcome = await mutate();
        const message = projectGroupOutcomeMessage(t, outcome);
        if (message) {
          setError(message);
          return false;
        }
        onApplied();
        return true;
      } finally {
        inFlightRef.current = false;
        setPending(false);
      }
    },
    [onApplied, t],
  );
  return { run, pending, error };
}

function useCloseMenu(componentName: string): () => void {
  const menu = useMenuContext(componentName);
  return useCallback(() => menu.setOpen(false), [menu]);
}

function useProjectGroupSupport(project: SidebarProjectEntry): boolean {
  const serverIds = useMemo(() => project.hosts.map((host) => host.serverId), [project.hosts]);
  const support = useHostFeatureMap(serverIds, "projectGroups");
  return serverIds.every((serverId) => support.get(serverId) === true);
}

/**
 * Every group any host knows, with this project's own ticked, plus "No group" and the way to a
 * new one. Picking is single-select and closes the menu once the host has accepted it.
 */
function ProjectGroupPickerPage({ project }: { project: SidebarProjectEntry }): ReactElement {
  const { t } = useTranslation();
  const groups = useKnownProjectGroups();
  const supported = useProjectGroupSupport(project);
  const currentKey = project.group ? projectGroupKey(project.group) : null;
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const mutation = useProjectGroupMutation(useCloseMenu("ProjectGroupPickerPage"));

  const apply = useCallback(
    (group: string | null) => {
      const key = group ? projectGroupKey(group) : NONE_KEY;
      // Only the press that got the write marks its row; a second press during it is dropped
      // by `run` and must not steal the spinner. The marker is cleared whichever way the write
      // ended, so a refusal leaves the row pressable again rather than spinning.
      void (async () => {
        let claimed = false;
        await mutation.run(() => {
          claimed = true;
          setPendingKey(key);
          return setProjectGroup({ project, group });
        });
        if (claimed) setPendingKey(null);
      })();
    },
    [mutation, project],
  );
  const applyNoGroup = useCallback(() => apply(null), [apply]);
  const openCreateModal = useCallback(
    () => openProjectGroupCreateModal([project.viewKey]),
    [project.viewKey],
  );

  return (
    <>
      {groups.map((group) => (
        <ProjectGroupPickerRow
          key={group.key}
          name={group.name}
          selected={group.key === currentKey}
          pending={pendingKey === group.key}
          disabled={!supported || mutation.pending}
          onSelect={apply}
          testID={`project-group-picker-row-${group.key}`}
        />
      ))}
      {groups.length > 0 ? <MenuSeparator /> : null}
      <MenuItem
        selected={currentKey === null}
        disabled={!supported || currentKey === null || mutation.pending}
        status={pendingKey === NONE_KEY ? "pending" : "idle"}
        closeOnSelect={false}
        onSelect={applyNoGroup}
        testID="project-group-picker-none"
      >
        {t("sidebar.project.group.none")}
      </MenuItem>
      <MenuItem
        leading={CREATE_LEADING}
        disabled={!supported}
        onSelect={openCreateModal}
        testID="project-group-picker-create"
      >
        {t("sidebar.project.group.create")}
      </MenuItem>
      {mutation.error ? (
        <MenuHint testID="project-group-picker-error">{mutation.error}</MenuHint>
      ) : null}
      {supported ? null : <MenuHint>{t("sidebar.project.group.updateHost")}</MenuHint>}
    </>
  );
}

/** Whitespace-only names normalize away, so the empty key can only ever mean "No group". */
const NONE_KEY = "";

function ProjectGroupPickerRow({
  name,
  selected,
  pending,
  disabled,
  onSelect,
  testID,
}: {
  name: string;
  selected: boolean;
  pending: boolean;
  disabled: boolean;
  onSelect: (group: string) => void;
  testID: string;
}): ReactElement {
  const select = useCallback(() => onSelect(name), [name, onSelect]);
  return (
    <MenuItem
      selected={selected}
      disabled={disabled || selected}
      status={pending ? "pending" : "idle"}
      closeOnSelect={false}
      onSelect={select}
      testID={testID}
    >
      {name}
    </MenuItem>
  );
}

/**
 * Renaming a group writes the new name onto every member. A member that fails keeps the old
 * name and shows up as its own group until the rename is applied again.
 */
function ProjectGroupRenamePage({
  name,
  resolveMembers,
}: {
  name: string;
  resolveMembers: () => readonly SidebarProjectEntry[];
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(name);
  const normalized = normalizeProjectGroupName(draft);
  // Exact comparison, not the merge key: "client x" to "Client X" is a rename worth making, and
  // it is how casing that drifted across hosts gets pulled back together.
  const unchanged = normalized === name;
  const mutation = useProjectGroupMutation(useCloseMenu("ProjectGroupRenamePage"));

  const submit = useCallback(() => {
    if (!normalized || unchanged) return;
    void (async () => {
      const applied = await mutation.run(() =>
        setProjectGroupOnProjects({ projects: resolveMembers(), group: normalized }),
      );
      // The group's place in the sidebar is stored under its key; a new name is a new key.
      if (applied) {
        useSidebarOrderStore
          .getState()
          .renameProjectGroupOrderKey(projectGroupKey(name), projectGroupKey(normalized));
      }
    })();
  }, [mutation, name, normalized, resolveMembers, unchanged]);

  return (
    <>
      <MenuTextField
        initialValue={name}
        onChangeText={setDraft}
        placeholder={t("sidebar.project.group.name")}
        autoFocus
        editable={!mutation.pending}
        onSubmitEditing={submit}
        testID="project-group-rename-input"
      />
      <MenuSeparator />
      <MenuItem
        disabled={!normalized || unchanged}
        status={mutation.pending ? "pending" : "idle"}
        pendingLabel={t("sidebar.project.group.renaming")}
        closeOnSelect={false}
        onSelect={submit}
        testID="project-group-rename-confirm"
      >
        {t("sidebar.project.group.renameConfirm")}
      </MenuItem>
      {mutation.error ? (
        <MenuHint testID="project-group-rename-error">{mutation.error}</MenuHint>
      ) : null}
    </>
  );
}
