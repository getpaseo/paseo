import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactElement,
} from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { DraggableList } from "@/components/draggable-list";
import type { DraggableRenderItemInfo } from "@/components/draggable-list.types";
import { PageLayout } from "@/components/page-layout";
import { SettingsAddRow } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { foregroundIconColorMapping } from "@/components/ui/icon-color";
import { SearchField } from "@/components/ui/search-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { WindowChromeRegion } from "@/utils/desktop-window";
import { toErrorMessage } from "@/utils/error-messages";
import { generateAgentProfileId } from "../internal/profile-id";
import type { AgentProfileValue } from "../internal/profile-form-model";
import { buildAgentProfileTags } from "../internal/profile-summary";
import {
  removeAgentProfileById,
  useAgentProfiles,
  type AgentProfileListUpdater,
} from "../internal/use-agent-profiles";
import { useAgentProfileFormSession } from "../internal/use-profile-form-model";
import { AGENT_PROFILE_DRAWER_WIDTH, AgentProfileDrawer } from "./agent-profile-drawer";
import { AgentProfileEditModal } from "./agent-profile-edit-modal";
import {
  AgentProfileRow,
  ROSTER_COL_PROFILE_WIDTH,
  ROSTER_COL_RUNTIME_WIDTH,
  ROSTER_GRIP_WIDTH,
  ROSTER_TRAILING_WIDTH,
} from "./agent-profile-row";

const ThemedPlus = withUnistyles(Plus);
const addButtonIcon = <ThemedPlus size={ICON_SIZE.sm} uniProps={foregroundIconColorMapping} />;

/** Minimum pane width to host the right inspector drawer (as an overlay below docked threshold). */
const DRAWER_OVERLAY_MIN_PANE_WIDTH = 940;
/** Minimum pane width to dock the 440px drawer side-by-side without squeezing the 3-column table. */
const DRAWER_DOCKED_MIN_PANE_WIDTH = 1320;
/** Minimum roster width to keep the 3-column table readable; below this rows stack cleanly. */
const WIDE_ROSTER_MIN_WIDTH = 720;

type EditTarget = { mode: "create" } | { mode: "edit"; profileId: string };

function profileKey(profile: AgentProfile): string {
  return profile.id;
}

function editTargetKey(target: EditTarget): string {
  return target.mode === "edit" ? `edit:${target.profileId}` : "create";
}

function matchesProfileQuery(
  profile: AgentProfile,
  normalizedQuery: string,
  entries: readonly ProviderSnapshotEntry[] | undefined,
  formatFeatureCount: (count: number) => string,
): boolean {
  if (
    profile.name.toLowerCase().includes(normalizedQuery) ||
    profile.notes?.toLowerCase().includes(normalizedQuery) ||
    profile.model?.toLowerCase().includes(normalizedQuery) ||
    profile.provider.toLowerCase().includes(normalizedQuery)
  ) {
    return true;
  }
  const tags = buildAgentProfileTags({ profile, entries, formatFeatureCount });
  return tags.some((tag) => tag.label.toLowerCase().includes(normalizedQuery));
}

function RosterTableHeader(): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.tableHeader}>
      <View style={styles.tableHeaderGripSpacer} />
      <View style={styles.tableHeaderColumns}>
        <Text style={[styles.tableHeaderText, styles.colProfileHeader]} numberOfLines={1}>
          {t("settings.host.agentProfiles.columns.profile")}
        </Text>
        <Text style={[styles.tableHeaderText, styles.colRuntimeHeader]} numberOfLines={1}>
          {t("settings.host.agentProfiles.columns.runtime")}
        </Text>
        <Text style={[styles.tableHeaderText, styles.colNotesHeader]} numberOfLines={1}>
          {t("settings.host.agentProfiles.columns.whenToUse")}
        </Text>
      </View>
      <View style={styles.tableHeaderTrailingSpacer} />
    </View>
  );
}

function RosterCardContent({
  serverId,
  profilesLoaded,
  totalCount,
  filteredProfiles,
  isFiltering,
  searchQuery,
  useCompactRows,
  selectedProfileId,
  entries,
  renderDraggableItem,
  onDragEnd,
  onAddOpen,
  onEditOpen,
  onDuplicate,
  onRemove,
  onMoveUp,
  onMoveDown,
  onMoveToTop,
}: {
  serverId: string;
  profilesLoaded: boolean;
  totalCount: number;
  filteredProfiles: AgentProfile[];
  isFiltering: boolean;
  searchQuery: string;
  useCompactRows: boolean;
  selectedProfileId: string | null;
  entries: readonly ProviderSnapshotEntry[] | undefined;
  renderDraggableItem: (info: DraggableRenderItemInfo<AgentProfile>) => ReactElement;
  onDragEnd: (next: AgentProfile[]) => void;
  onAddOpen: () => void;
  onEditOpen: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onMoveToTop: (id: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  if (!profilesLoaded) {
    return (
      <View style={styles.emptyCard}>
        <Text style={styles.emptyText}>{t("common.loading")}</Text>
      </View>
    );
  }
  if (totalCount === 0) {
    return (
      <View style={styles.emptyCard} testID="agent-profiles-empty">
        <Text style={styles.emptyText}>{t("settings.host.agentProfiles.emptyState")}</Text>
        <View style={styles.emptyAction}>
          <Button
            variant="secondary"
            leftIcon={addButtonIcon}
            onPress={onAddOpen}
            testID="agent-profiles-empty-add-button"
          >
            {t("settings.host.agentProfiles.newProfile")}
          </Button>
        </View>
      </View>
    );
  }
  if (filteredProfiles.length === 0) {
    return (
      <View style={styles.emptyCard} testID="agent-profiles-no-matches">
        <Text style={styles.emptyText}>
          {t("settings.host.agentProfiles.noSearchMatches", { query: searchQuery.trim() })}
        </Text>
      </View>
    );
  }
  return (
    <>
      {!useCompactRows ? <RosterTableHeader /> : null}
      {isFiltering ? (
        <View>
          {filteredProfiles.map((profile, index) => (
            <AgentProfileRow
              key={profile.id}
              serverId={serverId}
              profile={profile}
              entries={entries}
              isFirst={index === 0}
              isLast={index === filteredProfiles.length - 1}
              selected={selectedProfileId === profile.id}
              compactLayout={useCompactRows}
              reorderable={false}
              onEdit={onEditOpen}
              onDuplicate={onDuplicate}
              onRemove={onRemove}
              onMoveUp={onMoveUp}
              onMoveDown={onMoveDown}
              onMoveToTop={onMoveToTop}
            />
          ))}
        </View>
      ) : (
        <DraggableList
          data={filteredProfiles}
          keyExtractor={profileKey}
          renderItem={renderDraggableItem}
          onDragEnd={onDragEnd}
          scrollEnabled={false}
        />
      )}
      <View style={settingsStyles.rowBorder}>
        <SettingsAddRow
          label={t("settings.host.agentProfiles.newProfile")}
          onPress={onAddOpen}
          testID="agent-profiles-add-row"
        />
      </View>
    </>
  );
}

function duplicateAgentProfileById(
  current: readonly AgentProfile[],
  id: string,
  formatCopyName: (name: string) => string,
): { next: AgentProfile[]; copyId: string } | null {
  const index = current.findIndex((entry) => entry.id === id);
  if (index < 0) {
    return null;
  }
  const source = current[index];
  const copy: AgentProfile = {
    ...source,
    id: generateAgentProfileId(),
    name: formatCopyName(source.name),
  };
  const next = [...current];
  next.splice(index + 1, 0, copy);
  return { next, copyId: copy.id };
}

interface DiscardApprovalTicket {
  token: number;
  revision: number;
}

function useAgentProfileRosterActions({
  profiles,
  mutateProfiles,
  confirmDiscardIfDirty,
  editTarget,
  applyDelayedEditTarget,
  closeIfEditingProfile,
}: {
  profiles: AgentProfile[] | null | undefined;
  mutateProfiles: (updater: AgentProfileListUpdater) => Promise<AgentProfile[] | null>;
  confirmDiscardIfDirty: () => Promise<DiscardApprovalTicket | null>;
  editTarget: EditTarget | null;
  applyDelayedEditTarget: (
    expectedToken: number,
    next: EditTarget | null,
    options?: { approvedRevision?: number },
  ) => void;
  closeIfEditingProfile: (profileId: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();

  const handleSave = useCallback(
    async (value: AgentProfileValue) => {
      const editingId = editTarget?.mode === "edit" ? editTarget.profileId : null;
      // The edited profile is replaced, not merged: `value` omits cleared fields.
      await mutateProfiles((current) =>
        editingId
          ? current.map((entry) => (entry.id === editingId ? { id: entry.id, ...value } : entry))
          : [...current, { id: generateAgentProfileId(), ...value }],
      );
    },
    [editTarget, mutateProfiles],
  );

  const persistMutation = useCallback(
    async (updater: AgentProfileListUpdater): Promise<boolean> => {
      try {
        const written = await mutateProfiles(updater);
        return written !== null;
      } catch (error) {
        const detail = toErrorMessage(error);
        toast.error(
          detail
            ? `${t("common.errors.unableToSave")}: ${detail}`
            : t("common.errors.unableToSave"),
        );
        return false;
      }
    },
    [mutateProfiles, t, toast],
  );

  const handleDragEnd = useCallback(
    (reordered: AgentProfile[]) => {
      const orderedIds = reordered.map((entry) => entry.id);
      void persistMutation((current) => {
        const byId = new Map(current.map((entry) => [entry.id, entry]));
        const next: AgentProfile[] = [];
        for (const id of orderedIds) {
          const entry = byId.get(id);
          if (entry) {
            next.push(entry);
            byId.delete(id);
          }
        }
        for (const remaining of byId.values()) {
          next.push(remaining);
        }
        return next;
      });
    },
    [persistMutation],
  );

  const reorderByOffset = useCallback(
    (id: string, offset: -1 | 1) => {
      void persistMutation((current) => {
        const index = current.findIndex((entry) => entry.id === id);
        const target = index + offset;
        if (index < 0 || target < 0 || target >= current.length) {
          return null;
        }
        const next = [...current];
        const [item] = next.splice(index, 1);
        next.splice(target, 0, item);
        return next;
      });
    },
    [persistMutation],
  );

  const handleMoveUp = useCallback((id: string) => reorderByOffset(id, -1), [reorderByOffset]);
  const handleMoveDown = useCallback((id: string) => reorderByOffset(id, 1), [reorderByOffset]);

  const handleMoveToTop = useCallback(
    (id: string) => {
      void persistMutation((current) => {
        const index = current.findIndex((entry) => entry.id === id);
        if (index <= 0) {
          return null;
        }
        const next = [...current];
        const [item] = next.splice(index, 1);
        next.unshift(item);
        return next;
      });
    },
    [persistMutation],
  );

  const handleDuplicate = useCallback(
    (id: string) => {
      const formatCopyName = (name: string) => t("settings.host.agentProfiles.copyName", { name });
      const duplicate = async () => {
        const ticket = await confirmDiscardIfDirty();
        if (!ticket) {
          return;
        }
        let copyId: string | null = null;
        const saved = await persistMutation((current) => {
          const result = duplicateAgentProfileById(current, id, formatCopyName);
          if (!result) {
            return null;
          }
          copyId = result.copyId;
          return result.next;
        });
        if (saved && copyId) {
          // Only open the copy if no newer editor session or draft edit happened since confirmation.
          applyDelayedEditTarget(
            ticket.token,
            { mode: "edit", profileId: copyId },
            { approvedRevision: ticket.revision },
          );
        }
      };
      void duplicate();
    },
    [applyDelayedEditTarget, confirmDiscardIfDirty, persistMutation, t],
  );

  const handleRemove = useCallback(
    (id: string) => {
      const profile = profiles?.find((entry) => entry.id === id);
      if (!profile) {
        return;
      }
      const confirmAndRemove = async () => {
        const confirmed = await confirmDialog({
          title: t("settings.host.agentProfiles.removeConfirmTitle"),
          message: t("settings.host.agentProfiles.removeConfirmMessage", { name: profile.name }),
          confirmLabel: t("settings.host.agentProfiles.remove"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }
        const removed = await persistMutation((current) => removeAgentProfileById(current, id));
        if (removed) {
          closeIfEditingProfile(id);
        }
      };
      void confirmAndRemove();
    },
    [closeIfEditingProfile, persistMutation, profiles, t],
  );

  return {
    handleSave,
    handleDragEnd,
    handleMoveUp,
    handleMoveDown,
    handleMoveToTop,
    handleDuplicate,
    handleRemove,
  };
}

function resolveRosterLayout({
  isCompact,
  paneWidth,
  hasTarget,
}: {
  isCompact: boolean;
  paneWidth: number;
  hasTarget: boolean;
}) {
  const canUseDrawer = !isCompact && paneWidth >= DRAWER_OVERLAY_MIN_PANE_WIDTH;
  const dockDrawer = canUseDrawer && paneWidth >= DRAWER_DOCKED_MIN_PANE_WIDTH;
  const drawerOpen = canUseDrawer && hasTarget;
  // Overlay drawers sit above the right edge so clicking a row never reflows or crushes the table.
  const availableRosterWidth =
    drawerOpen && dockDrawer ? Math.max(0, paneWidth - AGENT_PROFILE_DRAWER_WIDTH) : paneWidth;
  const useCompactRows =
    isCompact || (availableRosterWidth > 0 && availableRosterWidth < WIDE_ROSTER_MIN_WIDTH);
  return { canUseDrawer, dockDrawer, drawerOpen, useCompactRows };
}

function RosterBody({
  isAvailable,
  isConnected,
  totalCount,
  searchQuery,
  onSearchChange,
  children,
}: {
  isAvailable: boolean;
  isConnected: boolean;
  totalCount: number;
  searchQuery: string;
  onSearchChange: (text: string) => void;
  children: ReactElement;
}): ReactElement {
  const { t } = useTranslation();
  if (!isAvailable) {
    return (
      <View style={settingsStyles.card} testID="agent-profiles-unavailable">
        <View style={styles.emptyCard}>
          <Text style={styles.emptyText}>
            {isConnected
              ? t("settings.host.agentProfiles.unsupported")
              : t("settings.host.agentProfiles.unavailable")}
          </Text>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.rosterContainer} testID="agent-profiles-section">
      {totalCount > 0 ? (
        <View style={styles.toolbar}>
          <SearchField
            value={searchQuery}
            onChangeText={onSearchChange}
            placeholder={t("settings.host.agentProfiles.searchPlaceholder")}
            clearAccessibilityLabel={t("settings.host.agentProfiles.clearSearch")}
            testID="agent-profiles-search-input"
            clearTestID="agent-profiles-search-clear"
          />
        </View>
      ) : null}
      <View style={settingsStyles.card} testID="agent-profiles-card">
        {children}
      </View>
    </View>
  );
}

interface ActiveProfileFormHandle {
  sessionToken: number;
  isDirty: () => boolean;
  draftRevision: () => number;
}

/**
 * Owns the active form session above drawer/modal framing so resizing across breakpoints
 * never remounts the form or discards unsaved edits.
 */
function AgentProfileEditorHost({
  serverId,
  sessionToken,
  mode,
  profile,
  canUseDrawer,
  dockDrawer,
  canStepPrev,
  canStepNext,
  activeFormRef,
  onDirtyChange,
  onStepPrev,
  onStepNext,
  onClose,
  onSaved,
  onSave,
  onDuplicate,
  onRemove,
}: {
  serverId: string;
  sessionToken: number;
  mode: "create" | "edit";
  profile?: AgentProfile;
  canUseDrawer: boolean;
  dockDrawer: boolean;
  canStepPrev: boolean;
  canStepNext: boolean;
  activeFormRef: MutableRefObject<ActiveProfileFormHandle | null>;
  onDirtyChange: () => void;
  onStepPrev: () => void;
  onStepNext: () => void;
  onClose: () => void;
  onSaved: (savedToken: number) => void;
  onSave: (value: AgentProfileValue) => Promise<void>;
  onDuplicate: (profileId: string) => void;
  onRemove: (profileId: string) => void;
}): ReactElement {
  const handleSaved = useCallback(() => onSaved(sessionToken), [onSaved, sessionToken]);
  const session = useAgentProfileFormSession({
    serverId,
    mode,
    profile,
    onSave,
    onSaved: handleSaved,
  });

  useEffect(() => {
    const handle: ActiveProfileFormHandle = {
      sessionToken,
      isDirty: () => session.model.getState().isDirty,
      draftRevision: () => session.model.getState().draftRevision,
    };
    activeFormRef.current = handle;
    onDirtyChange();
    const unsubscribe = session.model.subscribe(onDirtyChange);
    return () => {
      unsubscribe();
      if (activeFormRef.current === handle) {
        activeFormRef.current = null;
        onDirtyChange();
      }
    };
  }, [activeFormRef, onDirtyChange, session.model, sessionToken]);

  if (canUseDrawer) {
    return (
      <AgentProfileDrawer
        serverId={serverId}
        mode={mode}
        profile={profile}
        session={session}
        overlay={!dockDrawer}
        canStepPrev={canStepPrev}
        canStepNext={canStepNext}
        onStepPrev={onStepPrev}
        onStepNext={onStepNext}
        onClose={onClose}
        onSave={onSave}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
      />
    );
  }

  return (
    <AgentProfileEditModal
      serverId={serverId}
      visible
      mode={mode}
      profile={profile}
      session={session}
      onClose={onClose}
      onSave={onSave}
      onRemove={onRemove}
    />
  );
}

export interface AgentProfilesBeforeLeaveGuard {
  isDirty: () => boolean;
  confirmDiscard: () => Promise<boolean>;
  subscribeDirty: (listener: () => void) => () => void;
}

/**
 * Dedicated Host → Agent profiles page: wide 3-column roster paired with a right
 * inspector drawer on desktop (overlay on medium panes, docked side-by-side on wide panes)
 * and the Compact Progressive Sheet on narrow/mobile screens.
 */
export function AgentProfilesPage({
  serverId,
  onBack,
  onRegisterBeforeLeave,
}: {
  serverId: string;
  onBack?: () => void;
  onRegisterBeforeLeave?: (guard: AgentProfilesBeforeLeaveGuard | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { profiles, isSupported, mutateProfiles } = useAgentProfiles(serverId);
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const [editorState, setEditorState] = useState<{ target: EditTarget | null; token: number }>({
    target: null,
    token: 0,
  });
  const editTarget = editorState.target;
  const editorTokenRef = useRef(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [paneWidth, setPaneWidth] = useState(0);
  const activeFormRef = useRef<ActiveProfileFormHandle | null>(null);
  const dirtyListenersRef = useRef(new Set<() => void>());

  const notifyDirtyListeners = useCallback(() => {
    for (const listener of dirtyListenersRef.current) {
      listener();
    }
  }, []);

  const subscribeDirty = useCallback((listener: () => void) => {
    dirtyListenersRef.current.add(listener);
    return () => {
      dirtyListenersRef.current.delete(listener);
    };
  }, []);

  const getActiveForm = useCallback((): ActiveProfileFormHandle | null => {
    const form = activeFormRef.current;
    if (!form || form.sessionToken !== editorTokenRef.current) {
      return null;
    }
    return form;
  }, []);

  const isDraftDirty = useCallback(
    (): boolean => Boolean(getActiveForm()?.isDirty()),
    [getActiveForm],
  );

  const commitEditTarget = useCallback(
    (next: EditTarget | null) => {
      const nextToken = editorTokenRef.current + 1;
      editorTokenRef.current = nextToken;
      setEditorState({ target: next, token: nextToken });
      notifyDirtyListeners();
    },
    [notifyDirtyListeners],
  );

  const applyDelayedEditTarget = useCallback(
    (
      expectedToken: number,
      next: EditTarget | null,
      options?: { approvedRevision?: number },
    ): boolean => {
      if (editorTokenRef.current !== expectedToken) {
        return false;
      }
      if (options?.approvedRevision !== undefined) {
        const form = getActiveForm();
        if (form?.isDirty() && form.draftRevision() !== options.approvedRevision) {
          return false;
        }
      }
      commitEditTarget(next);
      return true;
    },
    [commitEditTarget, getActiveForm],
  );

  const closeIfEditingProfile = useCallback((profileId: string) => {
    setEditorState((current) => {
      if (current.target?.mode !== "edit" || current.target.profileId !== profileId) {
        return current;
      }
      const nextToken = editorTokenRef.current + 1;
      editorTokenRef.current = nextToken;
      return { target: null, token: nextToken };
    });
  }, []);

  const handlePaneLayout = useCallback((event: LayoutChangeEvent) => {
    setPaneWidth(event.nativeEvent.layout.width);
  }, []);

  const { canUseDrawer, dockDrawer, drawerOpen, useCompactRows } = resolveRosterLayout({
    isCompact,
    paneWidth,
    hasTarget: editTarget !== null,
  });

  const activeProfile = useMemo(() => {
    if (editTarget?.mode !== "edit" || !profiles) {
      return undefined;
    }
    return profiles.find((entry) => entry.id === editTarget.profileId);
  }, [editTarget, profiles]);

  const activeIndex = useMemo(() => {
    if (!activeProfile || !profiles) {
      return -1;
    }
    return profiles.findIndex((entry) => entry.id === activeProfile.id);
  }, [activeProfile, profiles]);

  const confirmDiscardIfDirty = useCallback(async (): Promise<DiscardApprovalTicket | null> => {
    const token = editorTokenRef.current;
    const form = getActiveForm();
    const revisionAtPrompt = form?.draftRevision() ?? 0;
    if (!form?.isDirty()) {
      return { token, revision: revisionAtPrompt };
    }
    const confirmed = await confirmDialog({
      title: t("settings.host.agentProfiles.discardTitle"),
      message: t("settings.host.agentProfiles.discardMessage"),
      confirmLabel: t("settings.host.agentProfiles.discardConfirm"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (!confirmed) {
      return null;
    }
    if (editorTokenRef.current !== token || getActiveForm()?.draftRevision() !== revisionAtPrompt) {
      return null;
    }
    return { token, revision: revisionAtPrompt };
  }, [getActiveForm, t]);

  const confirmLeaveDiscard = useCallback(async (): Promise<boolean> => {
    const ticket = await confirmDiscardIfDirty();
    if (!ticket) {
      return false;
    }
    // Discard the active editor synchronously via the session token so follow-up
    // navigation listeners (such as React Navigation `beforeRemove`) see a clean page.
    return applyDelayedEditTarget(ticket.token, null, { approvedRevision: ticket.revision });
  }, [applyDelayedEditTarget, confirmDiscardIfDirty]);

  useEffect(() => {
    onRegisterBeforeLeave?.({
      isDirty: isDraftDirty,
      confirmDiscard: confirmLeaveDiscard,
      subscribeDirty,
    });
    return () => {
      onRegisterBeforeLeave?.(null);
    };
  }, [confirmLeaveDiscard, isDraftDirty, onRegisterBeforeLeave, subscribeDirty]);

  const transitionTarget = useCallback(
    (next: EditTarget | null) => {
      if (!isDraftDirty()) {
        commitEditTarget(next);
        return;
      }
      const confirmAndTransition = async () => {
        const ticket = await confirmDiscardIfDirty();
        if (ticket) {
          applyDelayedEditTarget(ticket.token, next, { approvedRevision: ticket.revision });
        }
      };
      void confirmAndTransition();
    },
    [applyDelayedEditTarget, commitEditTarget, confirmDiscardIfDirty, isDraftDirty],
  );

  const handleAddOpen = useCallback(() => transitionTarget({ mode: "create" }), [transitionTarget]);
  const handleEditClose = useCallback(() => transitionTarget(null), [transitionTarget]);
  const handleSavedClose = useCallback(
    (savedToken: number) => applyDelayedEditTarget(savedToken, null),
    [applyDelayedEditTarget],
  );

  const handleEditOpen = useCallback(
    (id: string) => {
      if (editTarget?.mode === "edit" && editTarget.profileId === id) {
        return;
      }
      transitionTarget({ mode: "edit", profileId: id });
    },
    [editTarget, transitionTarget],
  );

  const handleStepPrev = useCallback(() => {
    if (!profiles || activeIndex <= 0) {
      return;
    }
    const prev = profiles[activeIndex - 1];
    if (prev) {
      transitionTarget({ mode: "edit", profileId: prev.id });
    }
  }, [activeIndex, profiles, transitionTarget]);

  const handleStepNext = useCallback(() => {
    if (!profiles || activeIndex < 0 || activeIndex >= profiles.length - 1) {
      return;
    }
    const next = profiles[activeIndex + 1];
    if (next) {
      transitionTarget({ mode: "edit", profileId: next.id });
    }
  }, [activeIndex, profiles, transitionTarget]);

  const {
    handleSave,
    handleDragEnd,
    handleMoveUp,
    handleMoveDown,
    handleMoveToTop,
    handleDuplicate,
    handleRemove,
  } = useAgentProfileRosterActions({
    profiles,
    mutateProfiles,
    confirmDiscardIfDirty,
    editTarget,
    applyDelayedEditTarget,
    closeIfEditingProfile,
  });

  const formatFeatureCount = useCallback(
    (count: number) =>
      count === 1
        ? t("settings.host.agentProfiles.featureCountOne", { count })
        : t("settings.host.agentProfiles.featureCount", { count }),
    [t],
  );

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const isFiltering = normalizedQuery.length > 0;

  const filteredProfiles = useMemo(() => {
    if (!profiles) {
      return [];
    }
    if (!normalizedQuery) {
      return profiles;
    }
    return profiles.filter((profile) =>
      matchesProfileQuery(profile, normalizedQuery, entries, formatFeatureCount),
    );
  }, [entries, formatFeatureCount, normalizedQuery, profiles]);

  const totalCount = profiles?.length ?? 0;
  const selectedProfileId = activeProfile?.id ?? null;

  const renderDraggableItem = useCallback(
    ({ item, index, isActive }: DraggableRenderItemInfo<AgentProfile>) => (
      <AgentProfileRow
        serverId={serverId}
        profile={item}
        entries={entries}
        isFirst={index === 0}
        isLast={index === filteredProfiles.length - 1}
        selected={selectedProfileId === item.id}
        dragging={isActive}
        compactLayout={useCompactRows}
        reorderable
        onEdit={handleEditOpen}
        onDuplicate={handleDuplicate}
        onRemove={handleRemove}
        onMoveUp={handleMoveUp}
        onMoveDown={handleMoveDown}
        onMoveToTop={handleMoveToTop}
      />
    ),
    [
      entries,
      filteredProfiles.length,
      handleDuplicate,
      handleEditOpen,
      handleMoveDown,
      handleMoveToTop,
      handleMoveUp,
      handleRemove,
      selectedProfileId,
      serverId,
      useCompactRows,
    ],
  );

  const isAvailable = isConnected && isSupported;

  const headerActions = useMemo(() => {
    if (!isAvailable) {
      return null;
    }
    return (
      <Button
        variant="secondary"
        leftIcon={addButtonIcon}
        onPress={handleAddOpen}
        disabled={!profiles}
        accessibilityLabel={t("settings.host.agentProfiles.addProfileTitle")}
        testID="agent-profiles-add-button"
      >
        {t("settings.host.agentProfiles.newProfile")}
      </Button>
    );
  }, [handleAddOpen, isAvailable, profiles, t]);

  const editorTarget =
    editTarget && (editTarget.mode === "create" || activeProfile) ? editTarget : null;
  const canStepNext = activeIndex >= 0 && activeIndex < totalCount - 1;

  return (
    <View style={styles.splitContainer} onLayout={handlePaneLayout} testID="agent-profiles-page">
      <WindowChromeRegion corners={drawerOpen ? "none" : "top-right"}>
        <View style={styles.rosterPane}>
          <PageLayout
            title={t("settings.host.agentProfiles.sectionTitle")}
            onBack={onBack}
            actions={headerActions}
            width="wide"
            titleTestID="settings-detail-header-title"
            testID="settings-detail-scroll-body"
          >
            <RosterBody
              isAvailable={isAvailable}
              isConnected={isConnected}
              totalCount={totalCount}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
            >
              <RosterCardContent
                serverId={serverId}
                profilesLoaded={Boolean(profiles)}
                totalCount={totalCount}
                filteredProfiles={filteredProfiles}
                isFiltering={isFiltering}
                searchQuery={searchQuery}
                useCompactRows={useCompactRows}
                selectedProfileId={selectedProfileId}
                entries={entries}
                renderDraggableItem={renderDraggableItem}
                onDragEnd={handleDragEnd}
                onAddOpen={handleAddOpen}
                onEditOpen={handleEditOpen}
                onDuplicate={handleDuplicate}
                onRemove={handleRemove}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
                onMoveToTop={handleMoveToTop}
              />
            </RosterBody>
          </PageLayout>
        </View>
      </WindowChromeRegion>

      {editorTarget ? (
        <AgentProfileEditorHost
          key={`${editTargetKey(editorTarget)}:${editorState.token}`}
          sessionToken={editorState.token}
          serverId={serverId}
          mode={editorTarget.mode}
          profile={activeProfile}
          canUseDrawer={canUseDrawer}
          dockDrawer={dockDrawer}
          canStepPrev={activeIndex > 0}
          canStepNext={canStepNext}
          activeFormRef={activeFormRef}
          onDirtyChange={notifyDirtyListeners}
          onStepPrev={handleStepPrev}
          onStepNext={handleStepNext}
          onClose={handleEditClose}
          onSaved={handleSavedClose}
          onSave={handleSave}
          onDuplicate={handleDuplicate}
          onRemove={handleRemove}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  splitContainer: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    flexDirection: "row",
  },
  rosterPane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  rosterContainer: {
    gap: theme.spacing[4],
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
  },
  tableHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[4],
    gap: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  tableHeaderGripSpacer: {
    width: ROSTER_GRIP_WIDTH,
    flexShrink: 0,
  },
  tableHeaderColumns: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
  },
  tableHeaderTrailingSpacer: {
    width: ROSTER_TRAILING_WIDTH,
    flexShrink: 0,
  },
  tableHeaderText: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  colProfileHeader: {
    width: ROSTER_COL_PROFILE_WIDTH,
    flexShrink: 0,
  },
  colRuntimeHeader: {
    width: ROSTER_COL_RUNTIME_WIDTH,
    flexShrink: 0,
  },
  colNotesHeader: {
    flex: 1,
    minWidth: 0,
  },
  emptyCard: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[6],
    gap: theme.spacing[2],
    alignItems: "flex-start",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyAction: {
    marginTop: theme.spacing[2],
  },
}));
