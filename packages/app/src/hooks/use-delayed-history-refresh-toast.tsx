import { useEffect, useRef } from "react";
import { ActivityIndicator } from "react-native";
import { useToast } from "@/contexts/toast-context";

const HISTORY_REFRESH_TOAST_DELAY_MS = 1000;
const HISTORY_REFRESH_TOAST_DURATION_MS = 2200;

interface UseDelayedHistoryRefreshToastParams {
  isCatchingUp: boolean;
  indicatorColor: string;
}

export function useDelayedHistoryRefreshToast({
  isCatchingUp,
  indicatorColor,
}: UseDelayedHistoryRefreshToastParams): void {
  const toast = useToast();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasCatchingUpRef = useRef(false);
  const isCatchingUpRef = useRef(false);
  const toastRef = useRef(toast);
  const indicatorColorRef = useRef(indicatorColor);

  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  useEffect(() => {
    indicatorColorRef.current = indicatorColor;
  }, [indicatorColor]);

  useEffect(() => {
    isCatchingUpRef.current = isCatchingUp;

    const enteredCatchUp = !wasCatchingUpRef.current && isCatchingUp;
    const exitedCatchUp = wasCatchingUpRef.current && !isCatchingUp;

    if (enteredCatchUp) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (!isCatchingUpRef.current) {
          return;
        }
        toastRef.current.show("Refreshing", {
          icon: (
            <ActivityIndicator
              size="small"
              color={indicatorColorRef.current}
            />
          ),
          durationMs: HISTORY_REFRESH_TOAST_DURATION_MS,
          testID: "agent-history-refresh-toast",
        });
      }, HISTORY_REFRESH_TOAST_DELAY_MS);
    } else if (exitedCatchUp && timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    wasCatchingUpRef.current = isCatchingUp;
  }, [isCatchingUp]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);
}
