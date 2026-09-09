import type { ReactNode } from "react";
import { ToastViewport, useToastHost } from "@/components/toast-host";
import { ToastApiProvider } from "./toast-api-context";

export { ToastApiProvider, useToast } from "./toast-api-context";

export function ToastProvider({ children }: { children: ReactNode }) {
  const { api, toast, dismiss } = useToastHost();

  return (
    <ToastApiProvider api={api}>
      {children}
      <ToastViewport toast={toast} onDismiss={dismiss} />
    </ToastApiProvider>
  );
}
