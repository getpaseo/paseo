import { useCallback, useState } from "react";
import type { CheckStatus } from "./check-status";

/** Per-mounted PR panel state; never shared with another tab instance. */
export function useCheckGroupState() {
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<CheckStatus>>(() => new Set());
  const toggle = useCallback((status: CheckStatus) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (!next.delete(status)) next.add(status);
      return next;
    });
  }, []);
  return { collapsedGroups, toggle };
}
