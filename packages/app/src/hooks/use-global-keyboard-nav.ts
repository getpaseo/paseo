import { useEffect } from "react";
import { Platform } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { getIsTauri } from "@/constants/layout";
import { useKeyboardNavStore } from "@/stores/keyboard-nav-store";
import { parseSidebarAgentKey } from "@/utils/sidebar-shortcuts";
import { setCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";

export function useGlobalKeyboardNav({
  enabled,
  isMobile,
  toggleAgentList,
  selectedAgentId,
  toggleFileExplorer,
}: {
  enabled: boolean;
  isMobile: boolean;
  toggleAgentList: () => void;
  selectedAgentId?: string;
  toggleFileExplorer?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const resetModifiers = useKeyboardNavStore((s) => s.resetModifiers);

  useEffect(() => {
    if (!enabled) return;
    if (Platform.OS !== "web") return;
    if (isMobile) return;

    const isTauri = getIsTauri();
    const shouldHandle = () => {
      if (typeof document === "undefined") return false;
      if (document.visibilityState !== "visible") return false;
      return true;
    };

    const isEditableTarget = (event: KeyboardEvent): boolean => {
      const target = event.target;
      if (!(target instanceof Element)) return false;

      if ((target as HTMLElement).isContentEditable) return true;
      const tag = target.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea") return true;

      return false;
    };

    const parseShortcutDigit = (event: KeyboardEvent): number | null => {
      const code = event.code ?? "";
      if (code.startsWith("Digit")) {
        const n = Number(code.slice("Digit".length));
        return Number.isFinite(n) && n >= 1 && n <= 9 ? n : null;
      }
      if (code.startsWith("Numpad")) {
        const n = Number(code.slice("Numpad".length));
        return Number.isFinite(n) && n >= 1 && n <= 9 ? n : null;
      }
      const key = event.key ?? "";
      if (key >= "1" && key <= "9") {
        return Number(key);
      }
      return null;
    };

    const navigateToSidebarShortcut = (digit: number) => {
      const state = useKeyboardNavStore.getState();
      const targetKey = state.sidebarShortcutAgentKeys[digit - 1] ?? null;
      if (!targetKey) {
        return;
      }

      const parsed = parseSidebarAgentKey(targetKey);
      if (!parsed) {
        return;
      }
      const { serverId, agentId } = parsed;

      const shouldReplace = pathname.startsWith("/agent/");
      const navigate = shouldReplace ? router.replace : router.push;
      navigate(`/agent/${serverId}/${agentId}` as any);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!shouldHandle()) {
        return;
      }

      const key = event.key ?? "";
      const lowerKey = key.toLowerCase();

      if (key === "Alt") {
        useKeyboardNavStore.getState().setAltDown(true);
      }
      if (isTauri && (key === "Meta" || key === "Control")) {
        useKeyboardNavStore.getState().setCmdOrCtrlDown(true);
      }

      // Cmd+B: toggle sidebar
      if (
        (event.metaKey || event.ctrlKey) &&
        (event.code === "KeyB" || lowerKey === "b")
      ) {
        // The MessageInput already handles Cmd+B inside editable fields. If we also
        // handle it globally, it can double-toggle and look like it "doesn't work".
        if (isEditableTarget(event)) {
          return;
        }
        event.preventDefault();
        toggleAgentList();
        return;
      }

      // Cmd+E: toggle explorer sidebar (only when an agent is selected)
      if (
        selectedAgentId &&
        toggleFileExplorer &&
        (event.metaKey || event.ctrlKey) &&
        (event.code === "KeyE" || lowerKey === "e")
      ) {
        // Same double-toggle issue as Cmd+B when focus is inside a text input.
        if (isEditableTarget(event)) {
          return;
        }
        event.preventDefault();
        toggleFileExplorer();
        return;
      }

      // Ctrl+`: toggle explorer sidebar (VS Code muscle memory)
      // Note: intentionally works even when focus is inside an input/textarea.
      if (
        selectedAgentId &&
        toggleFileExplorer &&
        event.ctrlKey &&
        !event.metaKey &&
        (event.code === "Backquote" || key === "`")
      ) {
        // Ignore while command center is open.
        if (useKeyboardNavStore.getState().commandCenterOpen) {
          return;
        }
        event.preventDefault();
        toggleFileExplorer();
        return;
      }

      // Cmd+K: command center
      if ((event.metaKey || event.ctrlKey) && lowerKey === "k") {
        event.preventDefault();
        const s = useKeyboardNavStore.getState();
        if (!s.commandCenterOpen) {
          const target =
            event.target instanceof Element ? (event.target as Element) : null;
          const targetEl =
            target?.closest?.("textarea, input, [contenteditable='true']") ??
            (target instanceof HTMLElement ? target : null);
          const active = document.activeElement;
          const activeEl = active instanceof HTMLElement ? active : null;
          setCommandCenterFocusRestoreElement(
            (targetEl as HTMLElement | null) ?? activeEl ?? null
          );
        }
        s.setCommandCenterOpen(!s.commandCenterOpen);
        return;
      }

      // Number switching: ignore while command center is open.
      if (useKeyboardNavStore.getState().commandCenterOpen) {
        return;
      }

      const digit = parseShortcutDigit(event);
      if (!digit) {
        return;
      }

      // Alt/Option+number: always (web + Tauri)
      if (event.altKey) {
        event.preventDefault();
        navigateToSidebarShortcut(digit);
        return;
      }

      // Cmd/Ctrl+number: Tauri only (avoid browser tab switching)
      if (isTauri && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        navigateToSidebarShortcut(digit);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const key = event.key ?? "";
      if (key === "Alt") {
        useKeyboardNavStore.getState().setAltDown(false);
      }
      if (isTauri && (key === "Meta" || key === "Control")) {
        useKeyboardNavStore.getState().setCmdOrCtrlDown(false);
      }
    };

    const handleBlurOrHide = () => {
      resetModifiers();
    };

    // react-native-web can stop propagation on key events, so listen in capture phase.
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleBlurOrHide);
    document.addEventListener("visibilitychange", handleBlurOrHide);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleBlurOrHide);
      document.removeEventListener("visibilitychange", handleBlurOrHide);
    };
  }, [
    enabled,
    isMobile,
    pathname,
    resetModifiers,
    router,
    selectedAgentId,
    toggleAgentList,
    toggleFileExplorer,
  ]);
}
