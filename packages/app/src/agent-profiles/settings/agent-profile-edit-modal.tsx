import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { AgentProfileSeed, AgentProfileValue } from "../internal/profile-form-model";
import {
  useAgentProfileFormSession,
  type AgentProfileFormSession,
} from "../internal/use-profile-form-model";
import { AgentProfileFormFields } from "./agent-profile-form-fields";

export interface AgentProfileEditModalProps {
  serverId: string;
  visible: boolean;
  mode: "create" | "edit";
  profile?: AgentProfile;
  seed?: AgentProfileSeed;
  /** Optional pre-owned session so resizing between drawer and modal preserves unsaved edits. */
  session?: AgentProfileFormSession;
  /** Starts create mode with Mode, Thinking, Notes & Options collapsed behind a summary row. */
  collapsibleDefaults?: boolean;
  onClose: () => void;
  onSave: (value: AgentProfileValue) => Promise<void>;
  onRemove?: (profileId: string) => void;
}

function openKey(props: AgentProfileEditModalProps): string {
  if (props.mode === "edit") {
    return `edit:${props.profile?.id ?? ""}`;
  }
  return `create:${props.seed?.provider ?? ""}:${props.seed?.modelId ?? ""}`;
}

/**
 * Create and edit never share a mounted instance: the body is keyed on mode plus
 * profile id (unless the caller lifts `session`), so every open constructs a form
 * model seeded from that record.
 *
 * Used for editing from the composer model picker and on compact/narrow screens
 * where Settings cannot host a slide-over drawer.
 */
export function AgentProfileEditModal(props: AgentProfileEditModalProps): ReactElement | null {
  const [renderedProps, setRenderedProps] = useState<AgentProfileEditModalProps | null>(() =>
    props.visible ? props : null,
  );
  const [sheetVisible, setSheetVisible] = useState(props.visible);
  const livePropsRef = useRef(props);
  const closeRequestedRef = useRef(false);
  livePropsRef.current = props;

  useEffect(() => {
    if (props.visible) {
      if (closeRequestedRef.current) {
        return;
      }
      setRenderedProps(props);
      setSheetVisible(true);
      return;
    }
    if (renderedProps) {
      setSheetVisible(false);
    }
  }, [props, renderedProps]);

  const requestClose = useCallback(() => {
    closeRequestedRef.current = true;
    setSheetVisible(false);
  }, []);

  const handleDismiss = useCallback(() => {
    const dismissedProps = livePropsRef.current;
    closeRequestedRef.current = false;
    setRenderedProps(null);
    setSheetVisible(false);
    if (dismissedProps.visible) {
      dismissedProps.onClose();
    }
  }, []);

  if (!renderedProps) {
    return null;
  }

  const activeProps = props.visible ? props : renderedProps;

  if (activeProps.session) {
    return (
      <AgentProfileEditModalContent
        {...activeProps}
        session={activeProps.session}
        visible={sheetVisible}
        onClose={requestClose}
        onDismiss={handleDismiss}
      />
    );
  }

  return (
    <StandaloneAgentProfileEditModal
      key={openKey(activeProps)}
      {...activeProps}
      visible={sheetVisible}
      onClose={requestClose}
      onDismiss={handleDismiss}
    />
  );
}

function StandaloneAgentProfileEditModal(
  props: AgentProfileEditModalProps & { onDismiss: () => void },
): ReactElement {
  const session = useAgentProfileFormSession({
    serverId: props.serverId,
    mode: props.mode,
    profile: props.profile,
    seed: props.seed,
    onSave: props.onSave,
    onSaved: props.onClose,
  });
  return <AgentProfileEditModalContent {...props} session={session} />;
}

function AgentProfileEditModalContent({
  serverId,
  visible,
  mode,
  profile,
  session,
  collapsibleDefaults,
  onClose,
  onDismiss,
  onRemove,
}: AgentProfileEditModalProps & {
  session: AgentProfileFormSession;
  onDismiss: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { model, state, save } = session;

  const sheetHeader = useMemo<SheetHeader>(
    () => ({
      title:
        mode === "edit"
          ? t("settings.host.agentProfiles.editProfileTitle")
          : t("settings.host.agentProfiles.addProfileTitle"),
    }),
    [mode, t],
  );

  const handleSavePress = useCallback(() => {
    void save();
  }, [save]);

  const handleCancel = useCallback(() => {
    if (state.isSubmitting) {
      return;
    }
    onClose();
  }, [onClose, state.isSubmitting]);

  const handleRemove = useCallback(() => {
    if (!profile || !onRemove) {
      return;
    }
    onRemove(profile.id);
  }, [onRemove, profile]);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <View style={styles.footerStart}>
          {mode === "edit" && profile && onRemove ? (
            <Button
              variant="outline"
              onPress={handleRemove}
              disabled={state.isSubmitting}
              testID="agent-profile-modal-remove-button"
            >
              {t("settings.host.agentProfiles.remove")}
            </Button>
          ) : null}
        </View>
        <View style={styles.footerEnd}>
          <Button
            variant="secondary"
            onPress={handleCancel}
            disabled={state.isSubmitting}
            testID="agent-profile-cancel-button"
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            onPress={handleSavePress}
            disabled={!state.canSubmit}
            loading={state.isSubmitting}
            testID="agent-profile-save-button"
          >
            {t("settings.host.agentProfiles.save")}
          </Button>
        </View>
      </View>
    ),
    [
      handleCancel,
      handleRemove,
      handleSavePress,
      mode,
      onRemove,
      profile,
      state.canSubmit,
      state.isSubmitting,
      t,
    ],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      header={sheetHeader}
      footer={footer}
      onClose={handleCancel}
      onDismiss={onDismiss}
      desktopMaxWidth={500}
      testID="agent-profile-edit-modal"
    >
      <AgentProfileFormFields
        serverId={serverId}
        model={model}
        state={state}
        collapsibleDefaults={collapsibleDefaults ?? mode === "create"}
      />
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  footerStart: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  footerEnd: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
