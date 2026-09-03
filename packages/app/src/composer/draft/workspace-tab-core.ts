import { resolveSubmissionReadiness } from "@/provider-selection/provider-selection";

export interface WorkspaceDraftAutoSubmitConfig {
  provider: string;
  model: string | null;
}

export function shouldAllowEmptyDraftText(input: {
  allowsEmptyAutoSubmit: boolean;
  attachments: readonly unknown[];
}): boolean {
  return input.allowsEmptyAutoSubmit || input.attachments.length > 0;
}

export async function waitForDraftComposerMountsToSettle(
  requestFrame: (callback: () => void) => void = (callback) => requestAnimationFrame(callback),
): Promise<void> {
  await new Promise<void>((resolve) => requestFrame(resolve));
  await new Promise<void>((resolve) => requestFrame(resolve));
}

export async function completeWorkspaceDraftCreation<T>(input: {
  platform: string;
  result: T;
  clearDraftState: () => void;
  onCreated: (result: T) => void;
  requestFrame?: (callback: () => void) => void;
}): Promise<void> {
  input.clearDraftState();
  if (input.platform === "android") {
    // Let Fabric apply the composer's final native updates before replacing its tab.
    await waitForDraftComposerMountsToSettle(input.requestFrame);
  }
  input.onCreated(input.result);
}

export function validateDraftSubmission(input: {
  text: string;
  allowsEmptyAutoSubmit: boolean;
  composerState: {
    providerDefinitions: unknown[];
    selectedProvider: string | null;
    isModelLoading: boolean;
    effectiveModelId: string | null;
    availableModels: unknown[];
  };
  autoSubmitConfig: WorkspaceDraftAutoSubmitConfig | null;
  workspaceDirectory: string | null;
  hasClient: boolean;
}): string | null {
  const {
    text,
    allowsEmptyAutoSubmit,
    composerState,
    autoSubmitConfig,
    workspaceDirectory,
    hasClient,
  } = input;
  const readiness = resolveSubmissionReadiness({
    text,
    allowsEmptyAutoSubmit,
    providerCount: composerState.providerDefinitions.length,
    selection: {
      provider: composerState.selectedProvider,
      modelId: composerState.effectiveModelId ?? "",
      availableModels: composerState.availableModels,
      isModelLoading: composerState.isModelLoading,
    },
    autoSubmitConfig,
    workspaceDirectory,
    hasClient,
  });
  return readiness.ok ? null : (readiness.reason ?? null);
}
