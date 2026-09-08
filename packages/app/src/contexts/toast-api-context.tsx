import { createContext, useContext, type ReactNode } from "react";
import type { ToastApi } from "@/components/toast-host";

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return value;
}

export function ToastApiProvider({ api, children }: { api: ToastApi; children: ReactNode }) {
  return <ToastContext.Provider value={api}>{children}</ToastContext.Provider>;
}
