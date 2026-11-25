import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Folder, FolderPlus, Plus } from "lucide-react-native";
import { AdaptiveModalSheet, type SheetKeyboard } from "@/components/adaptive-modal-sheet";
import { HostStatusDot } from "@/components/host-status-dot";
import { HostPicker } from "@/components/hosts/host-picker";
import { GitHubIcon } from "@/components/icons/github-icon";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAddHost } from "@/hosts/add-host";
import { useHardwareKeyboardPresent, type KeyboardInputEvent } from "@/keyboard";
import { Shortcut } from "@/components/ui/shortcut";
import { FieldTrigger } from "@/screens/new-workspace/form/field-trigger";
import {
  useAddProjectFlowStore,
  type AddProjectFlowRequest,
} from "@/stores/add-project-flow-store";
import { useRecommendedProjectPaths } from "@/stores/session-store-hooks";
import { formatShortcut } from "@/utils/format-shortcut";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { CloneTab, useCloneTab } from "./clone-tab";
import { ExistingTab, useExistingTab } from "./existing-tab";
import { focusedControlOwnsEnter } from "./focused-control";
import {
  ADD_PROJECT_KEYS,
  addProjectFailure,
  applyAvailableAddProjectHosts,
  currentAddProjectHost,
  selectableAddProjectHosts,
  isAddProjectSubmitting,
  moveAddProjectActiveIndex,
  openAddProjectFlow,
  resolveAddProjectKey,
  selectAddProjectHost,
  selectAddProjectRow,
  selectAddProjectTab,
  setAddProjectLocation,
  setAddProjectQuery,
  setNewFolderName,
  type AddProjectTab,
} from "./model";
import { NewFolderTab, useNewFolderTab } from "./new-folder-tab";
import { defaultProjectLocation } from "./options";
import type { AddProjectTabView } from "./tab-view";
import { useAddProjectActions } from "./use-add-project-actions";
import { useAddProjectHosts } from "./use-add-project-hosts";

const SNAP_POINTS = ["90%"];
// Tall enough for a search field, six result rows, and the location field, so switching tabs
// never resizes the card.
const DESKTOP_HEIGHT = 560;

// Compact drops the segment icons so the three labels fit a phone's width.
const TABS: {
  value: AddProjectTab;
  label: string;
  key: string;
  icon: SegmentedControlOption<AddProjectTab>["icon"];
}[] = [
  {
    value: "existing",
    label: "Existing",
    key: "1",
    icon: ({ color, size }) => <Folder color={color} size={size} />,
  },
  {
    value: "clone",
    label: "Clone",
    key: "2",
    icon: ({ color, size }) => <GitHubIcon color={color} size={size} />,
  },
  {
    value: "new-folder",
    label: "New folder",
    key: "3",
    icon: ({ color, size }) => <FolderPlus color={color} size={size} />,
  },
];

/** `lockedTo` is the tab a running submission belongs to; the others are disabled until it ends. */
function buildTabOptions(
  isMac: boolean,
  withIcons: boolean,
  lockedTo: AddProjectTab | null,
): SegmentedControlOption<AddProjectTab>[] {
  const os = isMac ? "mac" : "non-mac";
  return TABS.map(
    (tab): SegmentedControlOption<AddProjectTab> => ({
      value: tab.value,
      label: tab.label,
      icon: withIcons ? tab.icon : undefined,
      tooltip: formatShortcut(["mod", tab.key], os),
      testID: `add-project-flow-tab-${tab.value}`,
      disabled: lockedTo !== null && tab.value !== lockedTo,
    }),
  );
}

interface AddProjectFlowProps {
  request: AddProjectFlowRequest;
  onClose: () => void;
}

/**
 * Add project: one sheet with a tab per way to add one. The flow state lives in `./model`; this
 * component wires it to the host, the searches, and the keys.
 */
export function AddProjectFlow({ request, onClose }: AddProjectFlowProps) {
  const isCompact = useIsCompactFormFactor();
  const isMac = getShortcutOs() === "mac";
  const keyboardPresent = useHardwareKeyboardPresent();
  const availableHosts = useAddProjectHosts();
  const [state, setState] = useState(() =>
    openAddProjectFlow({
      hosts: availableHosts,
      ...(request.preferredHostId ? { preferredHostId: request.preferredHostId } : {}),
    }),
  );
  useEffect(() => {
    setState((current) => applyAvailableAddProjectHosts(current, availableHosts));
  }, [availableHosts]);

  const host = currentAddProjectHost(state);
  const submitting = isAddProjectSubmitting(state);
  const failure = addProjectFailure(state);
  const recommendedPaths = useRecommendedProjectPaths(state.hostId);
  const rememberedLocation = useAddProjectFlowStore((store) =>
    state.hostId ? store.lastLocationByHost[state.hostId] : undefined,
  );
  const defaultLocation = defaultProjectLocation({
    remembered: rememberedLocation,
    projectPaths: recommendedPaths,
  });
  const actions = useAddProjectActions({ hostId: state.hostId, setState, onClose });

  // An offline host keeps its drafts, but nothing submits until it is back or the user picks
  // another host. Gated here, once, so the footer, Enter and the native Go key all agree.
  const offline = host?.online === false;
  const existing = blockSubmitWhen(
    offline,
    useExistingTab({ state, host, recommendedPaths, actions }),
  );
  const clone = blockSubmitWhen(offline, useCloneTab({ state, host, defaultLocation, actions }));
  const newFolder = blockSubmitWhen(
    offline,
    useNewFolderTab({ state, host, defaultLocation, actions }),
  );
  const views: Record<AddProjectTab, AddProjectTabView> = {
    existing,
    clone,
    "new-folder": newFolder,
  };
  const view = views[state.tab];

  const selectTab = useCallback(
    (tab: AddProjectTab) => setState((current) => selectAddProjectTab(current, tab)),
    [],
  );
  const selectHost = useCallback(
    (hostId: string) => setState((current) => selectAddProjectHost(current, hostId)),
    [],
  );
  const changeQuery = useCallback(
    (query: string) => setState((current) => setAddProjectQuery(current, query)),
    [],
  );
  const changeLocation = useCallback(
    (location: string) => setState((current) => setAddProjectLocation(current, location)),
    [],
  );
  const changeName = useCallback(
    (name: string) => setState((current) => setNewFolderName(current, name)),
    [],
  );

  // The key handler reads the latest view without re-registering the overlay on every keystroke.
  const viewRef = useRef(view);
  viewRef.current = view;
  const hasHostRef = useRef(host !== null);
  hasHostRef.current = host !== null;
  /** Picks the row at `index` of the current tab's list, remembered by its id. */
  const selectRow = useCallback((index: number) => {
    const row = viewRef.current.rows[index];
    if (row) setState((current) => selectAddProjectRow(current, row.id));
  }, []);
  const keyboard = useMemo<SheetKeyboard>(
    () => ({
      keys: ADD_PROJECT_KEYS,
      onKeyDown: (event: KeyboardInputEvent) => {
        // With no host there is nothing to switch to or submit; Enter belongs to Add host.
        if (!hasHostRef.current) return false;
        const command = resolveAddProjectKey(event, isMac);
        if (!command) return false;
        const current = viewRef.current;
        if (command.kind === "tab") {
          selectTab(command.tab);
          return true;
        }
        if (command.kind === "move") {
          if (current.rows.length === 0) return false;
          selectRow(
            moveAddProjectActiveIndex(current.activeIndex, current.rows.length, command.direction),
          );
          return true;
        }
        if (!current.primary.submit || focusedControlOwnsEnter()) return false;
        current.primary.submit();
        return true;
      },
    }),
    [isMac, selectRow, selectTab],
  );

  const lockedTab = submitting ? state.tab : null;
  const tabOptions = useMemo(
    () => buildTabOptions(isMac, !isCompact, lockedTab),
    [isCompact, isMac, lockedTab],
  );
  const selectableHosts = useMemo(() => selectableAddProjectHosts(state), [state]);
  const header = useMemo(
    () => ({
      title: "Add project",
      titleTestID: "add-project-flow-title",
      actions:
        selectableHosts.length > 1 && state.hostId ? (
          <HostPill
            hosts={selectableHosts}
            hostId={state.hostId}
            onSelect={selectHost}
            disabled={submitting}
          />
        ) : undefined,
    }),
    [selectHost, selectableHosts, state.hostId, submitting],
  );

  // On a pointer layout the failure sits left of the button; compact stacks it above a
  // full-width button.
  const problem = failure ?? (offline && host ? `${host.label} is offline` : null);
  const failureLine = problem ? (
    <Text style={styles.failure} numberOfLines={2} testID="add-project-flow-error">
      {problem}
    </Text>
  ) : null;
  const footer = host ? (
    <>
      {failureLine ?? (isCompact ? null : <KeyHints canMove={view.rows.length > 0} />)}
      <Button
        variant="default"
        onPress={view.primary.submit ?? undefined}
        disabled={!view.primary.submit}
        loading={submitting}
        style={isCompact ? styles.primaryCompact : styles.primary}
        testID="add-project-flow-submit"
      >
        {view.primary.label}
      </Button>
    </>
  ) : null;

  let body: ReactNode;
  if (!host) {
    body = <NoHosts onClose={onClose} />;
  } else if (state.tab === "existing") {
    body = (
      <ExistingTab
        view={existing}
        query={state.existing.query}
        canBrowse={host.canBrowse && !offline}
        disabled={submitting}
        autoFocus={keyboardPresent}
        onQueryChange={changeQuery}
        onSelectRow={selectRow}
        onBrowse={actions.browse}
      />
    );
  } else if (state.tab === "clone") {
    body = (
      <CloneTab
        view={clone}
        query={state.clone.query}
        hostId={state.hostId}
        recommendedPaths={recommendedPaths}
        disabled={submitting}
        autoFocus={keyboardPresent}
        onQueryChange={changeQuery}
        onSelectRow={selectRow}
        onLocationChange={changeLocation}
      />
    );
  } else {
    body = (
      <NewFolderTab
        view={newFolder}
        name={state.newFolder.name}
        hostId={state.hostId}
        recommendedPaths={recommendedPaths}
        disabled={submitting}
        autoFocus={keyboardPresent}
        onNameChange={changeName}
        onLocationChange={changeLocation}
      />
    );
  }

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      footer={footer}
      footerContainerStyle={isCompact ? styles.footerContainerCompact : undefined}
      snapPoints={SNAP_POINTS}
      desktopHeight={DESKTOP_HEIGHT}
      scrollable={false}
      keyboard={keyboard}
      contentStyle={styles.content}
      testID="add-project-flow"
    >
      {host ? (
        <SegmentedControl
          options={tabOptions}
          value={state.tab}
          onValueChange={selectTab}
          fill
          testID="add-project-flow-tabs"
        />
      ) : null}
      {/* Keyed by tab so each tab's input mounts with its own draft and takes focus. */}
      <View key={host ? state.tab : "no-host"} style={styles.tabBody}>
        {body}
      </View>
    </AdaptiveModalSheet>
  );
}

function blockSubmitWhen<TabView extends AddProjectTabView>(
  blocked: boolean,
  view: TabView,
): TabView {
  return blocked ? { ...view, primary: { ...view.primary, submit: null } } : view;
}

function hostOptionTestID(serverId: string): string {
  return `add-project-flow-host-${serverId}`;
}

function HostPill({
  hosts,
  hostId,
  onSelect,
  disabled,
}: {
  hosts: { serverId: string; label: string }[];
  hostId: string;
  onSelect: (hostId: string) => void;
  disabled: boolean;
}) {
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const openPicker = useCallback(() => setOpen(true), []);
  const label = hosts.find((host) => host.serverId === hostId)?.label ?? hostId;
  const icon = useMemo(() => <HostStatusDot serverId={hostId} />, [hostId]);
  return (
    <HostPicker
      hosts={hosts}
      value={hostId}
      onSelect={onSelect}
      open={open}
      onOpenChange={setOpen}
      anchorRef={anchorRef}
      searchable={false}
      title="Host"
      desktopPlacement="bottom-end"
      desktopMinWidth={240}
      hostOptionTestID={hostOptionTestID}
    >
      <FieldTrigger
        ref={anchorRef}
        variant="badge"
        label="Host"
        accessibilityLabel="Project host"
        tooltip="Host"
        icon={icon}
        value={label}
        onPress={openPicker}
        disabled={disabled}
        testID="add-project-flow-host-trigger"
      />
    </HostPicker>
  );
}

const MOVE_KEYS = ["↑↓"];
const TAB_KEYS = ["mod", "1–3"];

/** The keys that are not on any control: list movement and tab switching. */
function KeyHints({ canMove }: { canMove: boolean }) {
  const keyboardPresent = useHardwareKeyboardPresent();
  if (!keyboardPresent) return <View />;
  return (
    <View style={styles.hints}>
      {canMove ? (
        <View style={styles.hint}>
          <Shortcut keys={MOVE_KEYS} />
          <Text style={styles.hintText}>Move</Text>
        </View>
      ) : null}
      <View style={styles.hint}>
        <Shortcut keys={TAB_KEYS} />
        <Text style={styles.hintText}>Switch</Text>
      </View>
    </View>
  );
}

function NoHosts({ onClose }: { onClose: () => void }) {
  const addHost = useAddHost();
  const handleAddHost = useCallback(() => {
    // The project sheet must release its window before the add-host sheet opens.
    onClose();
    addHost();
  }, [addHost, onClose]);
  return (
    <View style={styles.noHosts}>
      <Text style={styles.noHostsText}>No connected hosts</Text>
      <Button
        variant="secondary"
        leftIcon={Plus}
        onPress={handleAddHost}
        testID="add-project-flow-add-host"
      >
        Add host
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    flex: 1,
    minHeight: 0,
  },
  tabBody: {
    flex: 1,
    minHeight: 0,
  },
  footerContainerCompact: {
    flexDirection: "column",
    alignItems: "stretch",
  },
  // The message wraps beside the button; the button keeps its width.
  failure: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  hints: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
  },
  hint: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  hintText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  primary: {
    flexShrink: 0,
  },
  primaryCompact: {
    flexShrink: 0,
    alignSelf: "stretch",
  },
  noHosts: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  noHostsText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
