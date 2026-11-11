import { useEffect } from "react";
import {
  releaseWorkspaceTerminalSession,
  retainWorkspaceTerminalSession,
} from "@/terminal/runtime/workspace-terminal-session";

export function useWorkspaceTerminalSessionRetention(input: { scopeKey: string | null }): void {
  useEffect(() => {
    if (!input.scopeKey) {
      return;
    }

    retainWorkspaceTerminalSession({ scopeKey: input.scopeKey });
    return () => {
      releaseWorkspaceTerminalSession({ scopeKey: input.scopeKey! });
    };
  }, [input.scopeKey]);
}
