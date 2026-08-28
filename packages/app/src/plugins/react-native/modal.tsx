import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import type { ModalComponent, ModalContentProps, ModalProps } from "@getpaseo/plugin/react-native";
import { usePluginRuntimeContextBridge } from "@getpaseo/plugin/host";
import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";
import { ToastApiProvider, useToast as useAppToast } from "@/contexts/toast-api-context";

interface ModalContextValue {
  open: boolean;
  dismiss(): void;
}

const ModalContext = createContext<ModalContextValue | null>(null);

function ModalRoot({ open, onOpenChange, children }: ModalProps) {
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const dismiss = useCallback(() => onOpenChangeRef.current(false), []);
  const value = useMemo(() => ({ open, dismiss }), [dismiss, open]);
  return <ModalContext.Provider value={value}>{children}</ModalContext.Provider>;
}

function useModalContext(): ModalContextValue {
  const context = useContext(ModalContext);
  if (!context) throw new Error("Modal.Content must be rendered inside Modal");
  return context;
}

function ModalContent({ title, children }: ModalContentProps) {
  const modal = useModalContext();
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const bridgePluginRuntime = usePluginRuntimeContextBridge();
  const header = useMemo(() => ({ title }), [title]);
  const contextBridge = useCallback(
    (content: ReactNode) => (
      <QueryClientProvider client={queryClient}>
        <ToastApiProvider api={toast}>{bridgePluginRuntime(content)}</ToastApiProvider>
      </QueryClientProvider>
    ),
    [bridgePluginRuntime, queryClient, toast],
  );
  const { AdaptiveModalSheet } =
    require("../../components/adaptive-modal-sheet") as typeof import("../../components/adaptive-modal-sheet");

  return (
    <AdaptiveModalSheet
      visible={modal.open}
      onClose={modal.dismiss}
      header={header}
      contextBridge={contextBridge}
    >
      {children}
    </AdaptiveModalSheet>
  );
}

export const Modal: ModalComponent = Object.assign(ModalRoot, { Content: ModalContent });
