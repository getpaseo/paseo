import { useEffect } from "react";
import { registerLocalUpdateGuard } from "./local-update-readiness";
export { hasLocalUpdateBlockers } from "./local-update-readiness";

export function useLocalUpdateBlocker(blocked: boolean): void {
  useEffect(() => {
    if (blocked) return registerLocalUpdateGuard(() => true);
  }, [blocked]);
}
