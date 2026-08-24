import { Buffer } from "buffer";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProjectIconSource } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { ProjectIconView } from "@/components/project-icon-view";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useFilePicker } from "@/hooks/use-file-picker";
import {
  openProjectEditForm,
  type ProjectEditFormError,
  type ProjectEditFormSnapshot,
  type ProjectEditSubmission,
  type ProjectIconIntent,
} from "@/projects/edit-form";
import { importProjectIconFromUrl } from "@/projects/import-project-icon";
import { toErrorMessage } from "@/utils/error-messages";

export interface ProjectEditSheetProps {
  visible: boolean;
  onClose: () => void;
  serverId: string;
  projectId: string;
  projectViewKey: string;
  client: DaemonClient;
  /** False on hosts that predate custom project icons — the icon field is hidden. */
  supportsCustomIcon: boolean;
  snapshot: ProjectEditFormSnapshot;
}

/** Editing a project is its name and its icon, decided together and saved once. */
export function ProjectEditSheet({
  visible,
  onClose,
  projectId,
  projectViewKey,
  client,
  supportsCustomIcon,
  snapshot,
}: ProjectEditSheetProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { pickFiles } = useFilePicker();
  const size: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const [form] = useState(() => openProjectEditForm(snapshot));
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);

  const mutation = useMutation({
    mutationFn: (submission: ProjectEditSubmission) =>
      submitProjectEdit({ client, projectId, submission }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.show(t("settings.project.edit.savedToast"), { variant: "success" });
      onClose();
    },
    onError: (error) => form.setError(toFormError(error)),
  });
  const isSaving = mutation.isPending;

  const handleClose = useCallback(() => {
    if (isSaving) return;
    onClose();
  }, [isSaving, onClose]);

  const handleSubmit = useCallback(() => {
    mutation.mutate(state.submission);
  }, [mutation, state.submission]);

  const chooseImage = useCallback(async () => {
    const file = (await pickFiles())?.[0];
    if (!file) return;
    form.setPickedImage({
      fileName: file.fileName,
      mimeType: file.mimeType,
      data: Buffer.from(file.bytes).toString("base64"),
    });
  }, [form, pickFiles]);

  const handleChooseImage = useCallback(() => {
    void chooseImage();
  }, [chooseImage]);

  const header = useMemo<SheetHeader>(() => ({ title: t("settings.project.edit.title") }), [t]);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          variant="secondary"
          size="md"
          style={styles.footerButton}
          onPress={handleClose}
          disabled={isSaving}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size="md"
          style={styles.footerButton}
          onPress={handleSubmit}
          disabled={!state.canSubmit}
          loading={isSaving}
          testID="project-edit-save"
        >
          {t("settings.project.edit.save")}
        </Button>
      </View>
    ),
    [handleClose, handleSubmit, isSaving, state.canSubmit, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      footer={footer}
      desktopMaxWidth={440}
      // Bound the compact scroller to the live snap height so the footer stays
      // on screen instead of being pushed past the bottom of the sheet.
      sizeContentToCurrentSnapPoint
      testID="project-edit-sheet"
    >
      <Field
        label={t("settings.project.edit.name")}
        error={state.error?.scope === "name" ? state.error.message : null}
      >
        <FormTextInput
          size={size}
          testID="project-edit-name"
          accessibilityLabel={t("settings.project.edit.nameLabel")}
          initialValue={state.name}
          onChangeText={form.setName}
          placeholder={snapshot.projectName}
          editable={!isSaving}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>

      {supportsCustomIcon ? (
        <Field
          label={t("settings.project.edit.icon")}
          hint={state.pickedFileName ?? undefined}
          error={state.error?.scope === "icon" ? state.error.message : null}
        >
          <View style={styles.iconField}>
            <View style={styles.iconRow}>
              <ProjectIconView
                iconDataUri={state.previewDataUri}
                initial={projectInitial(snapshot.projectName)}
                projectViewKey={projectViewKey}
                size={40}
                textStyle={styles.previewText}
              />
              <Button
                variant="outline"
                size={size}
                onPress={handleChooseImage}
                disabled={isSaving}
                testID="project-edit-choose-image"
              >
                {t("settings.project.edit.chooseImage")}
              </Button>
              {state.canUseAutomatic ? (
                <Button
                  variant="ghost"
                  size={size}
                  onPress={form.useAutomaticIcon}
                  disabled={isSaving}
                  testID="project-edit-use-automatic"
                >
                  {t("settings.project.edit.useAutomatic")}
                </Button>
              ) : null}
            </View>
            <FormTextInput
              size={size}
              testID="project-edit-image-url"
              accessibilityLabel={t("settings.project.edit.imageUrl")}
              initialValue=""
              resetKey={state.urlResetKey}
              onChangeText={form.setImageUrl}
              placeholder={t("settings.project.edit.imageUrl")}
              editable={!isSaving}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>
        </Field>
      ) : null}
    </AdaptiveModalSheet>
  );
}

function projectInitial(projectName: string): string {
  return projectName.trim().charAt(0).toUpperCase() || "?";
}

class ProjectEditStepError extends Error {
  constructor(
    readonly scope: ProjectEditFormError["scope"],
    cause: unknown,
  ) {
    super(toErrorMessage(cause));
    this.name = "ProjectEditStepError";
  }
}

async function step<T>(scope: ProjectEditFormError["scope"], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new ProjectEditStepError(scope, error);
  }
}

/**
 * One submit, up to two RPCs. Icon bytes are acquired before either RPC runs
 * because that is the step most likely to fail; past that point both RPCs take
 * the same inputs on a retry, so a failure between them is safe to submit again.
 */
async function submitProjectEdit(input: {
  client: DaemonClient;
  projectId: string;
  submission: ProjectEditSubmission;
}): Promise<void> {
  const { client, projectId, submission } = input;
  const { rename, icon } = submission;

  const source = icon ? await step("icon", () => acquireIconSource(icon)) : null;
  if (rename) {
    await step("name", () => client.renameProject(projectId, rename.customName));
  }
  if (source) {
    await step("icon", () => client.setProjectIcon(projectId, source));
  }
}

function acquireIconSource(intent: ProjectIconIntent): Promise<ProjectIconSource> {
  if (intent.type === "url") return importProjectIconFromUrl(intent.url);
  return Promise.resolve(intent);
}

function toFormError(error: unknown): ProjectEditFormError {
  if (error instanceof ProjectEditStepError) {
    return { scope: error.scope, message: error.message };
  }
  return { scope: "name", message: toErrorMessage(error) };
}

const styles = StyleSheet.create((theme) => ({
  iconField: {
    gap: theme.spacing[2],
  },
  iconRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  previewText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  footerButton: {
    minWidth: 112,
  },
}));
