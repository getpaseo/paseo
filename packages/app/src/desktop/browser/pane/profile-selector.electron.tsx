import { useCallback, useState } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getDesktopHost, type BrowserProfileEntry, type BrowserProfileGroup } from "@/desktop/host";
import { useSessionStore } from "@/stores/session-store";
import { selectProject } from "@/stores/session-store-hooks/selectors";
import { sameProfile, sameProfileGroup, sharedDefault } from "../profiles";

function useProjectName(group: BrowserProfileGroup) {
  return useSessionStore((state) => {
    if (!group) return "";
    const project = selectProject(state, group.serverId, group.projectId);
    return project?.projectCustomName ?? project?.projectDisplayName ?? group.projectId;
  });
}

function ProfileMenuRow<T>({
  value,
  name,
  selected,
  onPick,
}: {
  value: T;
  name: string;
  selected?: boolean;
  onPick: (value: T) => void;
}) {
  const pick = useCallback(() => onPick(value), [value, onPick]);
  return (
    <DropdownMenuItem
      onSelect={pick}
      selected={selected}
      showSelectedCheck={selected !== undefined}
    >
      {name}
    </DropdownMenuItem>
  );
}

export function ProfileSelector({
  selected,
  automatic,
  catalog,
  editable,
  refresh,
  onSelect,
}: {
  selected: BrowserProfileEntry;
  automatic: BrowserProfileEntry;
  catalog: BrowserProfileEntry[];
  editable: boolean;
  refresh: () => void;
  onSelect: (entry: BrowserProfileEntry) => void;
}) {
  const { t } = useTranslation();
  const sharedName = t("workspace.browser.profiles.shared");
  const projectName = useProjectName(automatic.group);
  const selectedProject = useProjectName(selected.group);
  const groups = [
    { group: null, name: sharedName },
    { group: automatic.group, name: projectName },
  ];
  const label = (selected.group ? selectedProject : sharedName) + " › " + selected.name;
  const accessible = t("workspace.browser.profiles.label", { profile: label });
  const [creating, setCreating] = useState<BrowserProfileGroup | undefined>(undefined);
  const openChanged = useCallback(
    (open: boolean) => {
      if (open) refresh();
    },
    [refresh],
  );
  const close = useCallback(() => setCreating(undefined), []);
  const submit = useCallback(
    async (name: string) => {
      const create = getDesktopHost()?.browser?.createProfile;
      if (!create || creating === undefined) throw new Error(t("desktop.settings.loadFailed"));
      const workspaces =
        creating && useSessionStore.getState().sessions[creating.serverId]?.workspaces;
      const workspaceNames = workspaces
        ? Array.from(workspaces.values())
            .filter((workspace) => workspace.projectId === creating?.projectId)
            .map((workspace) => workspace.title || workspace.name)
        : [];
      const entry = await create({ group: creating, name, workspaceNames }).catch(
        (error: unknown) => {
          if (error instanceof Error && error.message.endsWith("Duplicate profile name")) {
            throw new Error(t("workspace.browser.profiles.duplicateName"));
          }
          throw error;
        },
      );
      refresh();
      onSelect(entry);
    },
    [creating, onSelect, refresh, t],
  );
  const entries = [sharedDefault, automatic, ...catalog];
  const action = (group: BrowserProfileGroup) =>
    group
      ? t("workspace.browser.profiles.createWorkspace")
      : t("workspace.browser.profiles.createShared");
  return (
    <>
      {editable ? (
        <DropdownMenu onOpenChange={openChanged}>
          <DropdownMenuTrigger
            accessibilityLabel={accessible}
            style={styles.trigger}
            testID="browser-profile-picker"
          >
            <Text numberOfLines={1} style={styles.label}>
              {label} ▾
            </Text>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" scrollable maxHeight={400}>
            {groups.map(({ group, name }) => (
              <div role="group" aria-label={name} key={JSON.stringify(group)}>
                <DropdownMenuLabel>{name}</DropdownMenuLabel>
                {entries
                  .filter((entry) => sameProfileGroup(entry.group, group))
                  .map((entry) => (
                    <ProfileMenuRow
                      key={entry.slug}
                      selected={sameProfile(entry, selected)}
                      value={entry}
                      name={entry.name}
                      onPick={onSelect}
                    />
                  ))}
                <ProfileMenuRow value={group} name={action(group)} onPick={setCreating} />
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Text
          numberOfLines={1}
          accessibilityLabel={accessible}
          testID="browser-profile-label"
          style={styles.label}
        >
          {label}
        </Text>
      )}
      {creating !== undefined && (
        <AdaptiveRenameModal
          visible
          initialValue=""
          title={action(creating)}
          submitLabel={t("workspace.browser.profiles.create")}
          testID="browser-create-profile"
          maxLength={80}
          validateOnChange
          onClose={close}
          onSubmit={submit}
        />
      )}
    </>
  );
}
const styles = StyleSheet.create((theme) => ({
  trigger: { flexShrink: 1, maxWidth: 340, paddingHorizontal: theme.spacing[1] },
  label: {
    maxWidth: 340,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
