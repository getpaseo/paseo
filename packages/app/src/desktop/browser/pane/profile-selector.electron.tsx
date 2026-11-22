import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { ChevronDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  isToolbarLabelTriggerHighlighted,
  toolbarLabelTriggerFrameStyle,
  toolbarLabelTriggerStyle,
  toolbarLabelTriggerTextStyle,
  ToolbarLabelTriggerIcon,
  type ToolbarLabelTriggerState,
} from "@/components/ui/toolbar-label-trigger";
import { useFetchQuery } from "@/data/query";
import {
  getDesktopHost,
  type BrowserProfileCreateError,
  type BrowserProfileEntry,
  type BrowserProfileGroup,
} from "@/desktop/host";
import { useSessionStore } from "@/stores/session-store";
import { selectProject } from "@/stores/session-store-hooks/selectors";
import { automaticProfileLabel, sameProfile, sameProfileGroup, sharedDefault } from "../profiles";

const ThemedChevronDown = withUnistyles(ChevronDown);

const createErrorKeys = {
  duplicate: "workspace.browser.profiles.duplicateName",
  reserved: "workspace.browser.profiles.reservedName",
  invalid: "workspace.browser.profiles.invalidName",
  io: "workspace.browser.profiles.saveFailed",
} as const satisfies Record<BrowserProfileCreateError, string>;

/** One catalog cache for every browser pane; the menu refetches it when it opens. */
export function useBrowserProfileCatalog() {
  const list = getDesktopHost()?.browser?.listProfiles;
  return useFetchQuery({
    dataShape: "list",
    queryKey: ["browser-profiles"],
    enabled: list !== undefined,
    queryFn: () => (list ? list() : Promise.resolve([])),
    staleTimeMs: 30_000,
    retry: false,
  });
}

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
  // Every row reserves the check column so profiles and create actions share one label rail.
  return (
    <DropdownMenuItem onSelect={pick} selected={selected} showSelectedCheck>
      {name}
    </DropdownMenuItem>
  );
}

function triggerStyle(state: ToolbarLabelTriggerState) {
  return [toolbarLabelTriggerStyle(state), styles.control];
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
  const automaticLabel = automaticProfileLabel(
    automatic,
    catalog,
    t("workspace.tabs.fallback.workspace"),
  );
  const displayName = (entry: BrowserProfileEntry) =>
    sameProfile(entry, automatic) ? automaticLabel : entry.name;
  const label = (selected.group ? selectedProject : sharedName) + " › " + displayName(selected);
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
      if (!create || creating === undefined) {
        throw new Error(t("workspace.browser.profiles.saveFailed"));
      }
      const workspaces =
        creating && useSessionStore.getState().sessions[creating.serverId]?.workspaces;
      const workspaceNames = workspaces
        ? Array.from(workspaces.values())
            .filter((workspace) => workspace.projectId === creating?.projectId)
            .map((workspace) => workspace.title || workspace.name)
        : [];
      const result = await create({ group: creating, name, workspaceNames }).catch(() => null);
      if (!result?.ok) throw new Error(t(createErrorKeys[result?.code ?? "io"]));
      refresh();
      onSelect(result.profile);
    },
    [creating, onSelect, refresh, t],
  );
  const entries = [sharedDefault, automatic, ...catalog];
  const action = (group: BrowserProfileGroup) =>
    group
      ? t("workspace.browser.profiles.createProject")
      : t("workspace.browser.profiles.createShared");
  return (
    <>
      {editable ? (
        <DropdownMenu onOpenChange={openChanged}>
          <DropdownMenuTrigger
            accessibilityLabel={accessible}
            style={triggerStyle}
            testID="browser-profile-picker"
          >
            {(state) => (
              <>
                <Text
                  style={toolbarLabelTriggerTextStyle(isToolbarLabelTriggerHighlighted(state))}
                  numberOfLines={1}
                >
                  {label}
                </Text>
                <ToolbarLabelTriggerIcon>
                  <ThemedChevronDown size={12} uniProps={extraMutedIconColorMapping} />
                </ToolbarLabelTriggerIcon>
              </>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" scrollable maxHeight={400}>
            {groups.map(({ group, name }, index) => (
              <View role="group" aria-label={name} key={JSON.stringify(group)}>
                {index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel>{name}</DropdownMenuLabel>
                {entries
                  .filter((entry) => sameProfileGroup(entry.group, group))
                  .map((entry) => (
                    <ProfileMenuRow
                      key={entry.slug}
                      selected={sameProfile(entry, selected)}
                      value={entry}
                      name={displayName(entry)}
                      onPick={onSelect}
                    />
                  ))}
                <ProfileMenuRow value={group} name={action(group)} onPick={setCreating} />
              </View>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <View style={[toolbarLabelTriggerFrameStyle(), styles.control]}>
          <Text
            numberOfLines={1}
            accessibilityLabel={accessible}
            testID="browser-profile-label"
            style={toolbarLabelTriggerTextStyle(false)}
          >
            {label}
          </Text>
        </View>
      )}
      {creating !== undefined && (
        <AdaptiveRenameModal
          visible
          initialValue=""
          title={action(creating)}
          submitLabel={t("workspace.browser.profiles.create")}
          testID="browser-create-profile"
          maxLength={80}
          onClose={close}
          onSubmit={submit}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // Pointer toolbar controls are 28px tall (docs/design.md, Buttons). The label yields width;
  // the chevron never shrinks, so a long project name still reads as a menu.
  control: { height: 28, maxWidth: 340 },
});
