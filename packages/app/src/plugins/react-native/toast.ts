import { useMemo } from "react";
import type { ToastApi, ToastOptions } from "@getpaseo/plugin/client/react-native";
import { useToast as useAppToast } from "@/contexts/toast-api-context";

export function useToast(): ToastApi {
  const toast = useAppToast();
  return useMemo(
    () => ({
      show(message: string, options?: ToastOptions) {
        toast.show(message, options);
      },
      error(message: string) {
        toast.error(message);
      },
    }),
    [toast],
  );
}
