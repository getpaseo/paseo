import { useCallback, useEffect, useRef } from "react";
import type { ToastApi } from "@/components/toast-host";
import { useToast } from "@/contexts/toast-context";

interface DesktopIpcErrorReport {
  toast: ToastApi;
  logLabel: string;
  message: string;
  error: unknown;
}

interface DesktopIpcQueryErrorToastOptions {
  error: Error | null;
  logLabel: string;
  message: string;
}

interface DesktopIpcErrorReporterInput {
  logLabel: string;
  message: string;
  error: unknown;
}

export function reportDesktopIpcError(input: DesktopIpcErrorReport): void {
  console.error(input.logLabel, input.error);
  input.toast.error(input.message);
}

export function useDesktopIpcErrorReporter(): (input: DesktopIpcErrorReporterInput) => void {
  const toast = useToast();
  return useCallback(
    (input: DesktopIpcErrorReporterInput) => {
      reportDesktopIpcError({ ...input, toast });
    },
    [toast],
  );
}

export function useDesktopIpcQueryErrorToast(options: DesktopIpcQueryErrorToastOptions): void {
  const toast = useToast();
  const lastReportedErrorRef = useRef<Error | null>(null);

  useEffect(() => {
    if (!options.error || options.error === lastReportedErrorRef.current) {
      return;
    }

    lastReportedErrorRef.current = options.error;
    reportDesktopIpcError({
      toast,
      logLabel: options.logLabel,
      message: options.message,
      error: options.error,
    });
  }, [options.error, options.logLabel, options.message, toast]);
}
