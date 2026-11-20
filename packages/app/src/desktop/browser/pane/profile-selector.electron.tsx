import { useCallback, useMemo, useState } from "react";
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
import { useHosts } from "@/runtime/host-runtime";
import { useHostProjects } from "@/projects/host-projects";
import { sameProfile, sameProfileGroup, sharedDefault } from "../profiles";

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
  const hosts = useHosts();
  const ids = useMemo(() => hosts.map((h) => h.serverId), [hosts]);
  const projects = useHostProjects(ids);
  const projectGroups = projects.flatMap((project) =>
    project.hosts.map((host) => ({
      group: { serverId: host.serverId, projectId: host.projectId },
      name: project.projectName,
      path: host.iconWorkingDir,
    })),
  );
  const groups = [
    { group: null, name: t("workspace.browser.profiles.shared") },
    ...projectGroups.map((row) => ({
      group: row.group,
      name: projectGroups.some((other) => other !== row && other.name === row.name)
        ? `${row.name} (${row.group.serverId} · ${row.path})`
        : row.name,
    })),
  ];
  const label =
    (groups.find((row) => sameProfileGroup(row.group, selected.group))?.name ??
      selected.group?.projectId) +
    " › " +
    selected.name;
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
      const entry = await create({ group: creating, name });
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
