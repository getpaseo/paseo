import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import type { ModalProps } from "@getpaseo/plugin/react-native";
import { usePluginRuntimeContextBridge } from "@getpaseo/plugin/host";
import { useCallback, useMemo, type ReactNode } from "react";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";

export function Modal({ open, onOpenChange, title, children }: ModalProps) {
  const queryClient = useQueryClient();
  const bridgePluginRuntime = usePluginRuntimeContextBridge();
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const header = useMemo(() => ({ title }), [title]);
  const contextBridge = useCallback(
    (content: ReactNode) => (
      <QueryClientProvider client={queryClient}>{bridgePluginRuntime(content)}</QueryClientProvider>
    ),
    [bridgePluginRuntime, queryClient],
  );

  return (
    <AdaptiveModalSheet
      visible={open}
      onClose={close}
      header={header}
      contextBridge={contextBridge}
    >
      {children}
    </AdaptiveModalSheet>
  );
}
