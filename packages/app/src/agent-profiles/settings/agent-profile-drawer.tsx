import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Copy, MoreVertical, Trash2, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { Button } from "@/components/ui/button";
import { DismissBackdrop } from "@/components/ui/dismiss-backdrop";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { ScrollView } from "@/components/ui/scroll-view";
import { useOverlayRegistration, type KeyboardInputEvent } from "@/keyboard";
import { OverlayLayerProvider, useOverlayLayer } from "@/lib/overlay-root";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { WindowChromeRegion, WindowChromeSafeArea } from "@/utils/desktop-window";
import type { AgentProfileSeed, AgentProfileValue } from "../internal/profile-form-model";
import {
  useAgentProfileFormSession,
  type AgentProfileFormSession,
} from "../internal/use-profile-form-model";
import { AgentProfileIconButton } from "./agent-profile-appearance-field";
import { AgentProfileFormFields } from "./agent-profile-form-fields";

export const AGENT_PROFILE_DRAWER_WIDTH = 440;

const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedCopy = withUnistyles(Copy);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedX = withUnistyles(X);
const destructiveIconColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const duplicateMenuIcon = <ThemedCopy size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />;
const removeMenuIcon = <ThemedTrash2 size={ICON_SIZE.sm} uniProps={destructiveIconColorMapping} />;

export interface AgentProfileDrawerProps {
  serverId: string;
  mode: "create" | "edit";
  profile?: AgentProfile;
  seed?: AgentProfileSeed;
  /** Optional pre-owned session so resizing between drawer and modal preserves unsaved edits. */
  session?: AgentProfileFormSession;
  /** Renders as an absolute right-edge slide-over instead of reflowing the roster beside it. */
  overlay?: boolean;
  canStepPrev?: boolean;
  canStepNext?: boolean;
  onStepPrev?: () => void;
  onStepNext?: () => void;
  onClose: () => void;
  onSave: (value: AgentProfileValue) => Promise<void>;
  onDuplicate?: (profileId: string) => void;
  onRemove?: (profileId: string) => void;
}

/**
 * Full-height right inspector drawer for creating and editing agent profiles.
 * Pinned header + independent scroll + pinned footer prevent vertical re-centering
 * when async provider options resolve.
 */
export function AgentProfileDrawer(props: AgentProfileDrawerProps): ReactElement {
  if (props.session) {
    return <AgentProfileDrawerContent {...props} session={props.session} />;
  }
  const key =
    props.mode === "edit"
      ? `drawer-edit:${props.profile?.id ?? ""}`
      : `drawer-create:${props.seed?.provider ?? ""}:${props.seed?.modelId ?? ""}`;
  return <StandaloneAgentProfileDrawer key={key} {...props} />;
}

function StandaloneAgentProfileDrawer(props: AgentProfileDrawerProps): ReactElement {
  const session = useAgentProfileFormSession({
    serverId: props.serverId,
    mode: props.mode,
    profile: props.profile,
    seed: props.seed,
    onSave: props.onSave,
    onSaved: props.onClose,
  });
  return <AgentProfileDrawerContent {...props} session={session} />;
}

function DrawerOverflowMenu({
  profileName,
  disabled,
  onDuplicate,
  onRemove,
}: {
  profileName: string;
  disabled: boolean;
  onDuplicate?: () => void;
  onRemove?: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!onDuplicate && !onRemove) {
    return null;
  }
  return (
    <DropdownMenu compactMode="sheet">
      <ToolbarButton
        kind="menu"
        label={t("settings.host.agentProfiles.profileActions", { name: profileName })}
        disabled={disabled}
        testID="agent-profile-drawer-more"
      >
        <ThemedMoreVertical size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />
      </ToolbarButton>
      <DropdownMenuContent side="bottom" align="end" width={180}>
        {onDuplicate ? (
          <DropdownMenuItem
            leading={duplicateMenuIcon}
            onSelect={onDuplicate}
            testID="agent-profile-drawer-duplicate"
          >
            {t("settings.host.agentProfiles.duplicate")}
          </DropdownMenuItem>
        ) : null}
        {onDuplicate && onRemove ? <DropdownMenuSeparator /> : null}
        {onRemove ? (
          <DropdownMenuItem
            destructive
            leading={removeMenuIcon}
            onSelect={onRemove}
            testID="agent-profile-drawer-remove"
          >
            {t("settings.host.agentProfiles.remove")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DrawerHeader({
  serverId,
  mode,
  state,
  canStepPrev,
  canStepNext,
  onStepPrev,
  onStepNext,
  onDuplicate,
  onRemove,
  onAppearanceChange,
  onClose,
}: {
  serverId: string;
  mode: "create" | "edit";
  state: AgentProfileFormSession["state"];
  canStepPrev: boolean;
  canStepNext: boolean;
  onStepPrev?: () => void;
  onStepNext?: () => void;
  onDuplicate?: () => void;
  onRemove?: () => void;
  onAppearanceChange: (value: { icon: string; color: string }) => void;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const fallbackTitle =
    mode === "edit"
      ? t("settings.host.agentProfiles.editProfileTitle")
      : t("settings.host.agentProfiles.addProfileTitle");
  const title = state.name.trim() || fallbackTitle;
  const parts = [state.providerDisplay?.label, state.modelDisplay?.label].filter(Boolean);
  const subtitle =
    parts.length > 0 ? parts.join(" · ") : t("settings.host.agentProfiles.chooseModelPlaceholder");
  const showSteppers = mode === "edit" && Boolean(onStepPrev && onStepNext);

  return (
    <View style={styles.headerChrome}>
      <TitlebarDragRegion />
      <WindowChromeSafeArea placement="below" />
      <View style={styles.header}>
        <View style={styles.headerIdentity}>
          <AgentProfileIconButton
            label={t("settings.host.agentProfiles.iconLabel")}
            icon={state.icon}
            color={state.color}
            provider={state.provider || undefined}
            serverId={serverId}
            onChange={onAppearanceChange}
            variant="hero"
            disabled={state.isSubmitting}
            triggerTestID="agent-profile-icon-trigger"
          />
          <View style={styles.headerText}>
            <Text style={styles.headerTitle} numberOfLines={1} testID="agent-profile-drawer-title">
              {title}
            </Text>
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          {showSteppers && onStepPrev && onStepNext ? (
            <>
              <ToolbarButton
                label={t("settings.host.agentProfiles.previousProfile")}
                onPress={onStepPrev}
                disabled={!canStepPrev || state.isSubmitting}
                testID="agent-profile-drawer-prev"
              >
                <ThemedArrowUp size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />
              </ToolbarButton>
              <ToolbarButton
                label={t("settings.host.agentProfiles.nextProfile")}
                onPress={onStepNext}
                disabled={!canStepNext || state.isSubmitting}
                testID="agent-profile-drawer-next"
              >
                <ThemedArrowDown size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />
              </ToolbarButton>
            </>
          ) : null}
          {mode === "edit" ? (
            <DrawerOverflowMenu
              profileName={title}
              disabled={state.isSubmitting}
              onDuplicate={onDuplicate}
              onRemove={onRemove}
            />
          ) : null}
          <ToolbarButton
            label={t("common.actions.close")}
            onPress={onClose}
            disabled={state.isSubmitting}
            testID="agent-profile-drawer-close"
          >
            <ThemedX size={ICON_SIZE.md} uniProps={mutedIconColorMapping} />
          </ToolbarButton>
        </View>
      </View>
    </View>
  );
}

function DrawerFooter({
  canSubmit,
  isSubmitting,
  onClose,
  onSave,
}: {
  canSubmit: boolean;
  isSubmitting: boolean;
  onClose: () => void;
  onSave: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.footer}>
      <Button
        variant="secondary"
        onPress={onClose}
        disabled={isSubmitting}
        testID="agent-profile-cancel-button"
      >
        {t("common.actions.cancel")}
      </Button>
      <Button
        variant="default"
        onPress={onSave}
        disabled={!canSubmit}
        loading={isSubmitting}
        testID="agent-profile-save-button"
      >
        {t("settings.host.agentProfiles.save")}
      </Button>
    </View>
  );
}

function AgentProfileDrawerContent({
  serverId,
  mode,
  profile,
  session,
  overlay = false,
  canStepPrev = false,
  canStepNext = false,
  onStepPrev,
  onStepNext,
  onClose,
  onDuplicate,
  onRemove,
}: AgentProfileDrawerProps & { session: AgentProfileFormSession }): ReactElement {
  const { t } = useTranslation();
  const { model, state, save } = session;
  const drawerLayer = useOverlayLayer("floating");

  const handleOverlayKeyDown = useCallback(
    (event: KeyboardInputEvent) => {
      if (event.key !== "Escape") {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!state.isSubmitting) {
        onClose();
      }
      return true;
    },
    [onClose, state.isSubmitting],
  );

  const setOverlayScope = useOverlayRegistration({
    keys: ["Escape"],
    active: true,
    layer: drawerLayer,
    // Only trap focus in slide-over overlay mode; a docked drawer sits beside the
    // interactive roster and must let users click and type in roster search.
    manageFocus: overlay,
    onKeyDown: handleOverlayKeyDown,
  });

  const handleAppearanceChange = useCallback(
    (value: { icon: string; color: string }) => model.setAppearance(value),
    [model],
  );

  const handleSavePress = useCallback(() => {
    void save();
  }, [save]);

  const handleDuplicate = useCallback(() => {
    if (profile && onDuplicate) {
      onDuplicate(profile.id);
    }
  }, [onDuplicate, profile]);

  const handleRemove = useCallback(() => {
    if (profile && onRemove) {
      onRemove(profile.id);
    }
  }, [onRemove, profile]);

  const handleBackdropPress = useCallback(() => {
    if (!state.isSubmitting) {
      onClose();
    }
  }, [onClose, state.isSubmitting]);

  const drawerStyle = useMemo(
    () => [styles.drawer, overlay && styles.drawerOverlay, overlay && { zIndex: drawerLayer }],
    [drawerLayer, overlay],
  );
  const overlayHostStyle = useMemo(
    () => [styles.overlayHost, { zIndex: drawerLayer }],
    [drawerLayer],
  );

  const drawerPanel = (
    <WindowChromeRegion corners="top-right">
      <OverlayLayerProvider layer={drawerLayer}>
        <View ref={setOverlayScope} style={drawerStyle} testID="agent-profile-drawer">
          <DrawerHeader
            serverId={serverId}
            mode={mode}
            state={state}
            canStepPrev={canStepPrev}
            canStepNext={canStepNext}
            onStepPrev={onStepPrev}
            onStepNext={onStepNext}
            onDuplicate={profile && onDuplicate ? handleDuplicate : undefined}
            onRemove={profile && onRemove ? handleRemove : undefined}
            onAppearanceChange={handleAppearanceChange}
            onClose={onClose}
          />

          <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
            <View style={styles.scrollContent}>
              <AgentProfileFormFields
                serverId={serverId}
                model={model}
                state={state}
                showInlineIcon={false}
                collapsibleDefaults={false}
              />
            </View>
          </ScrollView>

          <DrawerFooter
            canSubmit={state.canSubmit}
            isSubmitting={state.isSubmitting}
            onClose={onClose}
            onSave={handleSavePress}
          />
        </View>
      </OverlayLayerProvider>
    </WindowChromeRegion>
  );

  if (!overlay) {
    return drawerPanel;
  }

  return (
    <View style={overlayHostStyle} pointerEvents="box-none">
      <View style={styles.overlayBackdrop} pointerEvents="none" />
      <DismissBackdrop label={t("common.actions.close")} onPress={handleBackdropPress} />
      {drawerPanel}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlayHost: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  overlayBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.background,
    opacity: theme.opacity[50],
  },
  drawer: {
    width: AGENT_PROFILE_DRAWER_WIDTH,
    flexShrink: 0,
    backgroundColor: theme.colors.surface0,
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.borderAccent,
  },
  drawerOverlay: {
    height: "100%",
    ...theme.shadow.lg,
  },
  headerChrome: {
    position: "relative",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  headerIdentity: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  headerTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  headerSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: theme.spacing[4],
    paddingBottom: theme.spacing[8],
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
}));
