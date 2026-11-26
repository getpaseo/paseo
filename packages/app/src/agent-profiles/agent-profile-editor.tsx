import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { AgentProfileEditModal } from "./settings/agent-profile-edit-modal";
import { generateAgentProfileId } from "./internal/profile-id";
import {
  buildInstantAgentProfile,
  type AgentProfileSeed,
  type AgentProfileValue,
} from "./internal/profile-form-model";
import { removeAgentProfileById, useAgentProfiles } from "./internal/use-agent-profiles";

const PROFILE_SAVED_TOAST_DURATION_MS = 6000;

function ProfileSavedToastContent({
  name,
  onEdit,
  onUndo,
}: {
  name: string;
  onEdit: () => void;
  onUndo: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.toastRow}>
      <Text style={styles.toastText} numberOfLines={1}>
        {t("modelSelector.profileSaved", { name })}
      </Text>
      <View style={styles.toastActions}>
        <Button
          variant="secondary"
          size="sm"
          onPress={onEdit}
          accessibilityLabel={t("modelSelector.editProfileLabel", { name })}
          testID="model-profile-created-edit"
        >
          {t("modelSelector.editProfiles")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onPress={onUndo}
          accessibilityLabel={t("modelSelector.undoProfileSave")}
          testID="model-profile-created-undo"
        >
          {t("modelSelector.undo")}
        </Button>
      </View>
    </View>
  );
}

function createProfileSavedToast(input: {
  name: string;
  onEdit: () => void;
  onUndo: () => void;
}): ReactElement {
  return <ProfileSavedToastContent name={input.name} onEdit={input.onEdit} onUndo={input.onUndo} />;
}

export interface AgentProfileEditorControls {
  /** Save a profile immediately from a model row with defaults and show an Edit/Undo toast. */
  quickCreateFromModel: (seed: AgentProfileSeed) => Promise<AgentProfile | null>;
  /** Undo an instant creation without a confirmation prompt. */
  undoCreate: (profileId: string) => Promise<void>;
  /** Open the create form pre-filled with provider, model, and suggested name. */
  openCreateFromModel: (seed: AgentProfileSeed) => void;
  /** Open the edit form for one profile. */
  openEdit: (profileId: string) => void;
  /** Render once where a sheet can portal; it self-hides until opened. */
  element: ReactElement | null;
}

type EditorRequest =
  | { mode: "create"; seed?: AgentProfileSeed }
  | { mode: "edit"; profile: AgentProfile };

/**
 * The model chooser's create/edit surface. Owns the write path so call sites
 * never see `saveProfiles` or construct profile records themselves.
 */
export function useAgentProfileEditor(serverId: string | null): AgentProfileEditorControls {
  const { t } = useTranslation();
  const toast = useToast();
  const { profiles, mutateProfiles } = useAgentProfiles(serverId);
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const [request, setRequest] = useState<EditorRequest | null>(null);
  const mountedRef = useRef(true);
  const dismissSavedToastRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      dismissSavedToastRef.current?.();
      dismissSavedToastRef.current = null;
    };
  }, []);

  const undoCreate = useCallback(
    async (profileId: string): Promise<void> => {
      try {
        await mutateProfiles((current) => removeAgentProfileById(current, profileId));
      } catch (error) {
        toast.error(toErrorMessage(error));
      }
    },
    [mutateProfiles, toast],
  );

  const quickCreateFromModel = useCallback(
    async (seed: AgentProfileSeed): Promise<AgentProfile | null> => {
      const value = buildInstantAgentProfile({ seed, entries });
      const created: AgentProfile = { id: generateAgentProfileId(), ...value };
      try {
        const written = await mutateProfiles((current) => [...current, created]);
        if (!written || !mountedRef.current) {
          return written ? created : null;
        }
        dismissSavedToastRef.current?.();
        let dismiss: (() => void) | null = null;
        const clearToast = () => {
          dismiss?.();
          if (dismissSavedToastRef.current === dismiss) {
            dismissSavedToastRef.current = null;
          }
        };
        dismiss = toast.show(
          createProfileSavedToast({
            name: created.name,
            onEdit: () => {
              clearToast();
              setRequest({ mode: "edit", profile: created });
            },
            onUndo: () => {
              clearToast();
              void undoCreate(created.id);
            },
          }),
          {
            variant: "success",
            durationMs: PROFILE_SAVED_TOAST_DURATION_MS,
            testID: "model-profile-created-toast",
          },
        );
        dismissSavedToastRef.current = dismiss;
        return created;
      } catch (error) {
        toast.error(toErrorMessage(error));
        return null;
      }
    },
    [entries, mutateProfiles, toast, undoCreate],
  );

  const openCreateFromModel = useCallback((seed: AgentProfileSeed) => {
    setRequest({ mode: "create", seed });
  }, []);

  const openEdit = useCallback(
    (profileId: string) => {
      const profile = profiles?.find((entry) => entry.id === profileId);
      if (!profile) {
        return;
      }
      setRequest({ mode: "edit", profile });
    },
    [profiles],
  );

  const close = useCallback(() => setRequest(null), []);

  const handleSave = useCallback(
    async (value: AgentProfileValue) => {
      const savedRequest = request;
      const editing = savedRequest?.mode === "edit" ? savedRequest.profile : undefined;
      const written = await mutateProfiles((current) =>
        editing
          ? current.map((entry) => (entry.id === editing.id ? { id: entry.id, ...value } : entry))
          : [...current, { id: generateAgentProfileId(), ...value }],
      );
      if (!written) {
        return;
      }
      setRequest((current) => (current === savedRequest ? null : current));
    },
    [mutateProfiles, request],
  );

  const handleRemove = useCallback(
    (profileId: string) => {
      const profile = profiles?.find((entry) => entry.id === profileId);
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
        try {
          const updated = await mutateProfiles((current) =>
            removeAgentProfileById(current, profileId),
          );
          if (updated) {
            setRequest((current) =>
              current?.mode === "edit" && current.profile.id === profileId ? null : current,
            );
          }
        } catch (error) {
          const detail = toErrorMessage(error);
          toast.error(
            detail
              ? `${t("common.errors.unableToSave")}: ${detail}`
              : t("common.errors.unableToSave"),
          );
        }
      };
      void confirmAndRemove();
    },
    [mutateProfiles, profiles, t, toast],
  );

  const element = useMemo(
    () => (
      <AgentProfileEditModal
        serverId={serverId ?? ""}
        visible={request !== null}
        mode={request?.mode ?? "create"}
        {...(request?.mode === "edit" && request.profile ? { profile: request.profile } : {})}
        {...(request?.mode === "create" && request.seed ? { seed: request.seed } : {})}
        onClose={close}
        onSave={handleSave}
        onRemove={handleRemove}
      />
    ),
    [close, handleRemove, handleSave, request, serverId],
  );

  return useMemo(
    () => ({ quickCreateFromModel, undoCreate, openCreateFromModel, openEdit, element }),
    [element, openCreateFromModel, openEdit, quickCreateFromModel, undoCreate],
  );
}

const styles = StyleSheet.create((theme) => ({
  toastRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    maxWidth: "100%",
  },
  toastText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  toastActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexShrink: 0,
  },
}));
