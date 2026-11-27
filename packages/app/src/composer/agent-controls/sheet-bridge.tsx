import { useCallback } from "react";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import type { ContextBridge } from "@/components/ui/isolated-bottom-sheet-modal";
import { ComposerControlLayoutProvider, useComposerControlLayout } from "./layout-context";
import {
  ComposerAgentProvider,
  ComposerInputProvider,
  useComposerAgent,
  useComposerInput,
} from "@/composer/session";
import { ComposerModelProvider, useComposerModel } from "@/composer/model";
import { ToastApiProvider, useToast } from "@/contexts/toast-api-context";

/**
 * A phone's overflow draws in a sheet whose content lands at the app root, away from the
 * composer. This carries across what a control in it reads from the composer: the agent, model and input
 * a plugin's `useComposer()` sits on, the layout, and the toast and query client the controls use.
 * Call it from inside the composer, outside any sheet.
 */
export function useComposerSheetBridge(): ContextBridge {
  const layout = useComposerControlLayout();
  const agent = useComposerAgent();
  const input = useComposerInput();
  const model = useComposerModel();
  const toast = useToast();
  const queryClient = useQueryClient();
  return useCallback<ContextBridge>(
    (content) => (
      <QueryClientProvider client={queryClient}>
        <ToastApiProvider api={toast}>
          <ComposerControlLayoutProvider value={layout}>
            <ComposerAgentProvider value={agent}>
              <ComposerModelProvider value={model}>
                {input ? (
                  <ComposerInputProvider value={input}>{content}</ComposerInputProvider>
                ) : (
                  content
                )}
              </ComposerModelProvider>
            </ComposerAgentProvider>
          </ComposerControlLayoutProvider>
        </ToastApiProvider>
      </QueryClientProvider>
    ),
    [agent, input, layout, model, queryClient, toast],
  );
}
