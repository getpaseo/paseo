import { Buffer } from "buffer";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProjectIconSource } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { ProjectGlyphPicker } from "@/components/project-glyph-picker";
import { ProjectIconView } from "@/components/project-icon-view";
import { Button } from "@/components/ui/button";
import type { ControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useToast } from "@/contexts/toast-context";
import { useFilePicker } from "@/hooks/use-file-picker";
import {
  openProjectEditForm,
  type ProjectEditFormError,
  type ProjectEditFormModel,
  type ProjectEditFormSnapshot,
  type ProjectEditSubmission,
  type ProjectIconIntent,
} from "@/projects/edit-form";
import { importProjectIconFromUrl } from "@/projects/import-project-icon";
import { type ProjectGlyphChoice, readProjectGlyphChoice } from "@/projects/project-glyph-icon";
import { canRenderProjectGlyph, renderProjectGlyphPng } from "@/projects/render-project-glyph";
import { deriveIdentityColorName, identityColor } from "@/styles/identity-colors";
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
  const size: ControlSize = "md";
  const [form] = useState(() => openProjectEditForm(snapshot));
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const glyph = useProjectGlyph({
    form,
    projectViewKey,
    currentIconDataUri: snapshot.currentIconDataUri,
  });

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
    glyph.forget();
    form.setPickedImage({
      fileName: file.fileName,
      mimeType: file.mimeType,
      data: Buffer.from(await file.readBytes()).toString("base64"),
    });
  }, [form, glyph, pickFiles]);

  const handleChooseImage = useCallback(() => {
    void chooseImage();
  }, [chooseImage]);

  const handleUseAutomatic = useCallback(() => {
    glyph.forget();
    form.useAutomaticIcon();
  }, [form, glyph]);

  const header = useMemo<SheetHeader>(() => ({ title: t("settings.project.edit.title") }), [t]);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          variant="secondary"
          style={styles.footerButton}
          onPress={handleClose}
          disabled={isSaving}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
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
          // A picked file is named under the field; a glyph is already on the preview tile.
          hint={glyph.choice.name === null ? (state.pickedFileName ?? undefined) : undefined}
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
              <View style={styles.iconActions}>
                <Button
                  variant="outline"
                  size={size}
                  onPress={handleChooseImage}
                  disabled={isSaving}
                  testID="project-edit-choose-image"
                >
                  {t("settings.project.edit.chooseImage")}
                </Button>
                {canRenderProjectGlyph ? (
                  <Button
                    ref={glyph.anchorRef}
                    variant="outline"
                    size={size}
                    onPress={glyph.openPicker}
                    disabled={isSaving}
                    testID="project-edit-choose-glyph"
                  >
                    {t("settings.project.edit.chooseGlyph")}
                  </Button>
                ) : null}
                {state.canUseAutomatic ? (
                  <Button
                    variant="ghost"
                    size={size}
                    onPress={handleUseAutomatic}
                    disabled={isSaving}
                    testID="project-edit-use-automatic"
                  >
                    {t("settings.project.edit.useAutomatic")}
                  </Button>
                ) : null}
              </View>
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
          {canRenderProjectGlyph ? (
            <ProjectGlyphPicker
              anchorRef={glyph.anchorRef}
              open={glyph.isOpen}
              onOpenChange={glyph.setOpen}
              selectedName={glyph.choice.name}
              color={glyph.choice.color}
              onPickGlyph={glyph.pickGlyph}
              onPickColor={glyph.pickColor}
            />
          ) : null}
        </Field>
      ) : null}
    </AdaptiveModalSheet>
  );
}

interface GlyphSelection {
  /** Null until a glyph is picked, or once another kind of icon replaces it. */
  name: string | null;
  color: string;
}

/**
 * The glyph tile being composed. Each pick flattens the tile to a PNG and hands it to the form
 * as a picked image, so saving goes through the same upload as a chosen file. Renders can
 * overlap when colors are clicked quickly; only the latest one reaches the form.
 */
function useProjectGlyph(input: {
  form: ProjectEditFormModel;
  projectViewKey: string;
  currentIconDataUri: string | null;
}) {
  const { form } = input;
  const anchorRef = useRef<View>(null);
  const [isOpen, setOpen] = useState(false);
  const [choice, setChoice] = useState<GlyphSelection>(
    () =>
      readProjectGlyphChoice(input.currentIconDataUri) ?? {
        name: null,
        color: identityColor(deriveIdentityColorName(input.projectViewKey)),
      },
  );
  const latestRender = useRef(0);

  const apply = useCallback(
    async (next: ProjectGlyphChoice) => {
      const ticket = ++latestRender.current;
      try {
        const data = await renderProjectGlyphPng(next);
        if (ticket !== latestRender.current) return;
        form.setPickedImage({ fileName: next.name, mimeType: "image/png", data });
      } catch (error) {
        if (ticket !== latestRender.current) return;
        form.setError({ scope: "icon", message: toErrorMessage(error) });
      }
    },
    [form],
  );

  const pickGlyph = useCallback(
    (name: string) => {
      setChoice({ name, color: choice.color });
      void apply({ name, color: choice.color });
    },
    [apply, choice.color],
  );

  const pickColor = useCallback(
    (color: string) => {
      setChoice({ name: choice.name, color });
      if (choice.name) void apply({ name: choice.name, color });
    },
    [apply, choice.name],
  );

  const forget = useCallback(() => {
    latestRender.current += 1;
    setChoice((current) => ({ ...current, name: null }));
  }, []);

  const openPicker = useCallback(() => setOpen(true), []);

  return { anchorRef, isOpen, setOpen, openPicker, choice, pickGlyph, pickColor, forget };
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
    gap: theme.spacing[2],
  },
  /** Wraps beside the preview, so a wrapped button lines up under the first one. */
  iconActions: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
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
