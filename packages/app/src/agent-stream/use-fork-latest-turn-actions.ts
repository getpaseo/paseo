import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Split } from "lucide-react-native";
import type { AssistantForkTarget } from "@/components/assistant-fork-menu";
import type { CommandCenterContribution } from "@/command-center/contributions";
import { getCommandCenterIcon } from "@/command-center/icon";
import { useCommandCenterActions } from "@/command-center/provider";
import { getIsElectron } from "@/constants/platform";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import { resolveShortcutKeysForAction } from "@/keyboard/keyboard-shortcuts";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { getShortcutOs } from "@/utils/shortcut-platform";
import type { TurnFooterHost } from "./layout";
import { resolveAssistantTurnForkBoundary } from "./turn-boundary";
import type { AssistantTurnForkHandler, InFlightTurnForkHandler } from "./turn-footer";

const FORK_ICON = getCommandCenterIcon(Split);

const FORK_TARGETS = [
  {
    target: "tab",
    action: "agent.fork.tab",
    helpId: "fork-chat-new-tab",
    labelKey: "settings.shortcuts.help.forkChatInNewTab",
    keywords: ["fork", "chat", "agent", "tab"],
  },
  {
    target: "workspace",
    action: "agent.fork.workspace",
    helpId: "fork-chat-new-workspace",
    labelKey: "settings.shortcuts.help.forkChatInNewWorkspace",
    keywords: ["fork", "chat", "agent", "workspace", "worktree"],
  },
] as const;

/**
 * Keyboard and Command Center entry points for the fork menu in the bottom turn
 * footer, available in exactly the cases that menu is shown: a running turn
 * forks everything up to now, an idle agent forks at its latest completed turn.
 */
export function useForkLatestTurnActions(input: {
  sourceId: string;
  enabled: boolean;
  readOnly: boolean;
  isTurnActive: boolean;
  latestTurnFooter: TurnFooterHost | null;
  supportsTimelineCursor: boolean;
  onForkInFlightTurn: InFlightTurnForkHandler;
  onForkAssistantTurn: AssistantTurnForkHandler;
}): void {
  const { t } = useTranslation();
  const { overrides } = useKeyboardShortcutOverrides();
  const {
    readOnly,
    isTurnActive,
    latestTurnFooter,
    supportsTimelineCursor,
    onForkInFlightTurn,
    onForkAssistantTurn,
  } = input;
  const isForkingRef = useRef(false);
  const handlerIdRef = useRef(`${input.sourceId}:${Math.random().toString(36).slice(2)}`);

  const runFork = useMemo(() => {
    if (readOnly) return null;
    let fork: InFlightTurnForkHandler;
    if (isTurnActive) {
      fork = onForkInFlightTurn;
    } else {
      const boundary = latestTurnFooter
        ? resolveAssistantTurnForkBoundary({
            items: latestTurnFooter.items,
            startIndex: latestTurnFooter.startIndex,
            supportsTimelineCursor,
          })
        : undefined;
      if (!boundary) return null;
      fork = (target) => onForkAssistantTurn({ target, boundary });
    }
    return (target: AssistantForkTarget) => {
      if (isForkingRef.current) return;
      isForkingRef.current = true;
      void Promise.resolve(fork(target)).finally(() => {
        isForkingRef.current = false;
      });
    };
  }, [
    isTurnActive,
    latestTurnFooter,
    onForkAssistantTurn,
    onForkInFlightTurn,
    readOnly,
    supportsTimelineCursor,
  ]);
  const enabled = input.enabled && runFork !== null;

  useKeyboardActionHandler({
    handlerId: handlerIdRef.current,
    actions: ["agent.fork.tab", "agent.fork.workspace"],
    enabled,
    priority: 100,
    handle: (action: KeyboardActionDefinition) => {
      const entry = FORK_TARGETS.find((candidate) => candidate.action === action.id);
      if (!entry || !runFork) return false;
      runFork(entry.target);
      return true;
    },
  });

  const actions = useMemo<CommandCenterContribution[]>(() => {
    if (!runFork) return [];
    const platform = { isMac: getShortcutOs() === "mac", isDesktop: getIsElectron() };
    return FORK_TARGETS.map((entry, index) => ({
      id: `agent:fork:${entry.target}`,
      group: "workspace",
      groupRank: -1,
      // Joins the workspace source's section, right after its agent-tab actions (ranks 35-36).
      rank: 36.1 + index * 0.1,
      keywords: entry.keywords,
      visibility: "query",
      run: () => {
        clearCommandCenterFocusRestoreElement();
        runFork(entry.target);
      },
      presentation: {
        kind: "action",
        title: t(entry.labelKey),
        sectionTitle: t("workspace.header.actions.workspaceActions"),
        icon: FORK_ICON,
        shortcutKeys: resolveShortcutKeysForAction(entry.helpId, overrides, platform) ?? undefined,
      },
    }));
  }, [overrides, runFork, t]);

  useCommandCenterActions({ sourceId: input.sourceId, enabled, actions });
}
