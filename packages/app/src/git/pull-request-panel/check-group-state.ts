import { useCallback, useState } from "react";
import type { CheckPresentation } from "@/git/check-presentation";

/** Per-mounted PR panel state; never shared with another tab instance. */
export function useCheckGroupState() {
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<CheckPresentation>>(
    () => new Set(),
  );
  const toggle = useCallback((status: CheckPresentation) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (!next.delete(status)) next.add(status);
      return next;
    });
  }, []);
  return { collapsedGroups, toggle };
}
