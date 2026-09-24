import { useEffect, useMemo, useRef } from "react";
import { useSessionStore } from "@/stores/session-store";
import { workspaceLanguage } from "./model";
import { LanguageActions, type LanguageActionScope } from "./actions";

export function useLanguageActions(scope: LanguageActionScope | null): LanguageActions | null {
  const serverId = scope?.serverId;
  const cwd = scope?.cwd;
  const client = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.client : undefined,
  );
  // COMPAT(codeLanguage): added in v0.8.0, remove gate after 2027-03-17 once daemon floor >= v0.8.0.
  const supported = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.serverInfo?.features?.codeLanguage === true : false,
  );
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const actions = useMemo(() => {
    if (!supported || !client || !cwd) return null;
    return new LanguageActions(workspaceLanguage(client, cwd), (location) => {
      const { start, end } = location.range;
      scopeRef.current?.onOpenLocation({
        path: location.path,
        lineStart: start.line + 1,
        lineEnd: end.line + 1,
        columnStart: start.character + 1,
        columnEnd: end.character + 1,
      });
    });
  }, [client, cwd, supported]);
  useEffect(() => () => actions?.dismiss(), [actions]);
  return actions;
}
