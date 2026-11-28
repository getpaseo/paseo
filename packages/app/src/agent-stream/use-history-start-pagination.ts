import { useRef, useState } from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  createHistoryStartPagination,
  type HistoryStartPaginationInput,
  type HistoryStartPaginationState,
} from "./history-start-pagination";

export function useHistoryStartPagination(input: {
  initiallyVisible: boolean;
  read: () => HistoryStartPaginationInput | null;
  load: () => Promise<boolean>;
  scheduleSettle: () => void;
}) {
  const read = useStableEvent(input.read);
  const load = useStableEvent(input.load);
  const scheduleSettle = useStableEvent(input.scheduleSettle);
  const [state, setState] = useState<HistoryStartPaginationState>(() => ({
    status: "dormant",
    visible: input.initiallyVisible,
  }));
  const controller = useRef<ReturnType<typeof createHistoryStartPagination> | null>(null);
  if (!controller.current) {
    controller.current = createHistoryStartPagination({
      initiallyVisible: input.initiallyVisible,
      read,
      load,
      scheduleSettle,
      changed: setState,
    });
  }
  return { state, controller: controller.current };
}
