import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  Assistant,
  AssistantConfiguration,
  AssistantTemplate,
} from "@getpaseo/protocol/assistants";
import { assistantsQueryBaseKey, requireAssistantClient } from "./assistant-queries";
import { useAssistantSelectionStore } from "./assistant-selection-store";

export interface CreateAssistantInput {
  name: string;
  templateId?: string;
  configuration?: AssistantConfiguration;
}

export interface UpdateAssistantInput {
  assistantId: string;
  expectedRevision: number;
  name: string;
  configuration: AssistantConfiguration;
}

export interface CompactAssistantInput {
  assistantId: string;
  expectedRevision: number;
  throughSeq: number;
  summary: string;
}

export interface SaveAssistantTemplateInput {
  templateId?: string;
  expectedRevision?: number;
  name: string;
  configuration: AssistantConfiguration;
}

export interface UseAssistantMutationsResult {
  createAssistant: (input: CreateAssistantInput) => Promise<Assistant>;
  updateAssistant: (input: UpdateAssistantInput) => Promise<Assistant>;
  deleteAssistant: (assistantId: string) => Promise<void>;
  compactAssistant: (input: CompactAssistantInput) => Promise<Assistant>;
  saveTemplate: (input: SaveAssistantTemplateInput) => Promise<AssistantTemplate>;
  deleteTemplate: (templateId: string) => Promise<void>;
  isSaving: boolean;
  isDeleting: boolean;
}

/**
 * Every mutation invalidates the whole assistants namespace for the host:
 * lists, templates, and history pages all derive from the same records, and
 * the daemon is the only authority on revisions.
 */
export function useAssistantMutations({
  serverId,
}: {
  serverId: string;
}): UseAssistantMutationsResult {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const selectAssistant = useAssistantSelectionStore((state) => state.select);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: assistantsQueryBaseKey });
  }, [queryClient]);

  const client = useCallback(
    () => requireAssistantClient(serverId, t("common.errors.daemonClientUnavailable")),
    [serverId, t],
  );

  const createMutation = useMutation({
    mutationFn: async (input: CreateAssistantInput) => await client().createAssistant(input),
    onSettled: invalidate,
  });
  const updateMutation = useMutation({
    mutationFn: async (input: UpdateAssistantInput) => await client().updateAssistant(input),
    onSettled: invalidate,
  });
  const deleteMutation = useMutation({
    mutationFn: async (assistantId: string) => {
      await client().deleteAssistant({ assistantId });
    },
    onSuccess: (_result, assistantId) => {
      // The launcher must not keep pointing at a record the daemon just removed.
      if (useAssistantSelectionStore.getState().selectedByServerId[serverId] === assistantId) {
        selectAssistant(serverId, null);
      }
    },
    onSettled: invalidate,
  });
  const compactMutation = useMutation({
    mutationFn: async (input: CompactAssistantInput) => await client().compactAssistant(input),
    onSettled: invalidate,
  });
  const saveTemplateMutation = useMutation({
    mutationFn: async (input: SaveAssistantTemplateInput) =>
      await client().saveAssistantTemplate(input),
    onSettled: invalidate,
  });
  const deleteTemplateMutation = useMutation({
    mutationFn: async (templateId: string) => {
      await client().deleteAssistantTemplate({ templateId });
    },
    onSettled: invalidate,
  });

  return {
    createAssistant: createMutation.mutateAsync,
    updateAssistant: updateMutation.mutateAsync,
    deleteAssistant: deleteMutation.mutateAsync,
    compactAssistant: compactMutation.mutateAsync,
    saveTemplate: saveTemplateMutation.mutateAsync,
    deleteTemplate: deleteTemplateMutation.mutateAsync,
    isSaving:
      createMutation.isPending ||
      updateMutation.isPending ||
      compactMutation.isPending ||
      saveTemplateMutation.isPending,
    isDeleting: deleteMutation.isPending || deleteTemplateMutation.isPending,
  };
}
