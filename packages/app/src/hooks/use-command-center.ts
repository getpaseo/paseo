import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextInput } from "react-native";
import { router, usePathname } from "expo-router";
import { useKeyboardNavStore } from "@/stores/keyboard-nav-store";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useSessionStore } from "@/stores/session-store";
import {
  clearCommandCenterFocusRestoreElement,
  takeCommandCenterFocusRestoreElement,
} from "@/utils/command-center-focus-restore";
import { focusWithRetries } from "@/utils/web-focus";

function agentKey(agent: Pick<AggregatedAgent, "serverId" | "id">): string {
  return `${agent.serverId}:${agent.id}`;
}

function isMatch(agent: AggregatedAgent, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const title = (agent.title ?? "New agent").toLowerCase();
  const cwd = agent.cwd.toLowerCase();
  const host = agent.serverLabel.toLowerCase();
  return title.includes(q) || cwd.includes(q) || host.includes(q);
}

function sortAgents(left: AggregatedAgent, right: AggregatedAgent): number {
  const leftAttention = left.requiresAttention ? 1 : 0;
  const rightAttention = right.requiresAttention ? 1 : 0;
  if (leftAttention !== rightAttention) return rightAttention - leftAttention;

  const leftRunning = left.status === "running" ? 1 : 0;
  const rightRunning = right.status === "running" ? 1 : 0;
  if (leftRunning !== rightRunning) return rightRunning - leftRunning;

  return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
}

function parseAgentKeyFromPathname(pathname: string): string | null {
  const match = pathname.match(/^\/agent\/([^/]+)\/([^/]+)/);
  if (!match) return null;
  return `${match[1]}:${match[2]}`;
}

export function useCommandCenter() {
  const pathname = usePathname();
  const { agents } = useAggregatedAgents();
  const open = useKeyboardNavStore((s) => s.commandCenterOpen);
  const setOpen = useKeyboardNavStore((s) => s.setCommandCenterOpen);
  const requestFocusChatInput = useKeyboardNavStore((s) => s.requestFocusChatInput);
  const inputRef = useRef<TextInput>(null);
  const didNavigateRef = useRef(false);
  const prevOpenRef = useRef(open);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo(() => {
    const filtered = agents.filter((agent) => isMatch(agent, query));
    filtered.sort(sortAgents);
    return filtered;
  }, [agents, query]);

  const agentKeyFromPathname = useMemo(
    () => parseAgentKeyFromPathname(pathname),
    [pathname]
  );

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const handleSelect = useCallback(
    (agent: AggregatedAgent) => {
      didNavigateRef.current = true;
      const session = useSessionStore.getState().sessions[agent.serverId];
      session?.client?.clearAgentAttention(agent.id);

      const shouldReplace = pathname.startsWith("/agent/");
      const navigate = shouldReplace ? router.replace : router.push;

      requestFocusChatInput(agentKey(agent));
      // Don't restore focus back to the prior element after we navigate.
      clearCommandCenterFocusRestoreElement();
      setOpen(false);
      navigate(`/agent/${agent.serverId}/${agent.id}` as any);
    },
    [pathname, requestFocusChatInput, setOpen]
  );

  useEffect(() => {
    const prevOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (!open) {
      setQuery("");
      setActiveIndex(0);

      if (prevOpen && !didNavigateRef.current) {
        const el = takeCommandCenterFocusRestoreElement();
        const isFocused = () =>
          Boolean(el) &&
          typeof document !== "undefined" &&
          document.activeElement === el;

        const cancel = focusWithRetries({
          focus: () => el?.focus(),
          isFocused,
          onTimeout: () => {
            if (agentKeyFromPathname) {
              requestFocusChatInput(agentKeyFromPathname);
            }
          },
        });
        return cancel;
      }

      return;
    }

    didNavigateRef.current = false;

    const id = setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => clearTimeout(id);
  }, [agentKeyFromPathname, open, requestFocusChatInput]);

  useEffect(() => {
    if (!open) return;
    if (activeIndex >= results.length) {
      setActiveIndex(results.length > 0 ? results.length - 1 : 0);
    }
  }, [activeIndex, open, results.length]);

  useEffect(() => {
    if (!open) return;

    const handler = (event: KeyboardEvent) => {
      const key = event.key;
      if (
        key !== "ArrowDown" &&
        key !== "ArrowUp" &&
        key !== "Enter" &&
        key !== "Escape"
      ) {
        return;
      }

      if (key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }

      if (key === "Enter") {
        if (results.length === 0) return;
        event.preventDefault();
        const index = Math.max(0, Math.min(activeIndex, results.length - 1));
        handleSelect(results[index]!);
        return;
      }

      if (key === "ArrowDown" || key === "ArrowUp") {
        if (results.length === 0) return;
        event.preventDefault();
        setActiveIndex((current) => {
          const delta = key === "ArrowDown" ? 1 : -1;
          const next = current + delta;
          if (next < 0) return results.length - 1;
          if (next >= results.length) return 0;
          return next;
        });
      }
    };

    // react-native-web can stop propagation on key events, so listen in capture phase.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeIndex, handleClose, handleSelect, open, results]);

  return {
    open,
    inputRef,
    query,
    setQuery,
    activeIndex,
    setActiveIndex,
    results,
    handleClose,
    handleSelect,
  };
}

