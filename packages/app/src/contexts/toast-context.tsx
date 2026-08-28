import { createContext, useContext, type ReactNode } from "react";
import { ToastViewport, useToastHost, type ToastApi } from "@/components/toast-host";

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return value;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { api, toast, dismiss } = useToastHost();

  return (
    <ToastApiProvider api={api}>
      {children}
      <ToastViewport toast={toast} onDismiss={dismiss} />
    </ToastApiProvider>
  );
}

export function ToastApiProvider({ api, children }: { api: ToastApi; children: ReactNode }) {
  return <ToastContext.Provider value={api}>{children}</ToastContext.Provider>;
}
