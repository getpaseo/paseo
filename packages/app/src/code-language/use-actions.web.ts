import { useEffect, useMemo, useRef } from "react";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { workspaceLanguage } from "./model";
import { LanguageActions } from "./actions";

export function useLanguageActions(enabled = true): LanguageActions | null {
  const pane = usePaneContext();
  const cwd = useWorkspaceDirectory(pane.serverId, pane.workspaceId);
  const client = useSessionStore((state) => state.sessions[pane.serverId]?.client);
  // COMPAT(codeLanguage): added in v0.8.0, remove gate after 2027-03-17 once daemon floor >= v0.8.0.
  const supported = useSessionStore(
    (state) => state.sessions[pane.serverId]?.serverInfo?.features?.codeLanguage === true,
  );
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const actions = useMemo(() => {
    if (!enabled || !supported || !client || !cwd) return null;
    return new LanguageActions(workspaceLanguage(client, cwd), (location) => {
      const { start, end } = location.range;
      paneRef.current.openFileInWorkspace({
        disposition: "preferred",
        location: {
          path: location.path,
          lineStart: start.line + 1,
          lineEnd: end.line + 1,
          columnStart: start.character + 1,
          columnEnd: end.character + 1,
        },
      });
    });
  }, [client, cwd, enabled, supported]);
  useEffect(() => () => actions?.dismiss(), [actions]);
  return actions;
}
