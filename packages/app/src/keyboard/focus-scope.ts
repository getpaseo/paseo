import type { KeyboardFocusScope } from "@/keyboard/actions";

function isElement(value: unknown): value is Element {
  return typeof Element !== "undefined" && value instanceof Element;
}

function getFocusCandidateElements(target: EventTarget | null): Element[] {
  const candidates: Element[] = [];
  const pushUnique = (element: Element | null) => {
    if (!element || candidates.includes(element)) {
      return;
    }
    candidates.push(element);
  };

  if (isElement(target)) {
    pushUnique(target);
  }

  if (typeof Node !== "undefined" && target instanceof Node) {
    pushUnique(isElement(target.parentElement) ? target.parentElement : null);
  }

  if (typeof document !== "undefined" && isElement(document.activeElement)) {
    pushUnique(document.activeElement);
  }

  return candidates;
}

const ACTIVATABLE_ROLES = new Set(["switch", "checkbox", "radio", "button"]);

function isActivatableControl(element: Element): boolean {
  if (element.tagName.toLowerCase() === "button") {
    return true;
  }
  const role = element.getAttribute("role");
  return role !== null && ACTIVATABLE_ROLES.has(role);
}

export function resolveKeyboardFocusScope(input: {
  target: EventTarget | null;
  commandCenterOpen: boolean;
}): KeyboardFocusScope {
  const { target, commandCenterOpen } = input;
  const candidates = getFocusCandidateElements(target);
  if (candidates.length === 0) {
    return commandCenterOpen ? "command-center" : "other";
  }

  if (
    candidates.some((element) =>
      Boolean(element.closest("[data-testid='terminal-surface']") || element.closest(".xterm")),
    )
  ) {
    return "terminal";
  }

  if (
    commandCenterOpen &&
    candidates.some((element) =>
      Boolean(
        element.closest("[data-testid='command-center-panel']") ||
        element.closest("[data-testid='command-center-input']"),
      ),
    )
  ) {
    return "command-center";
  }

  if (
    candidates.some((element) => Boolean(element.closest("[data-testid='message-input-root']")))
  ) {
    return "message-input";
  }

  if (
    candidates.some((element) => {
      const editable = element as HTMLElement;
      if (editable.isContentEditable) {
        return true;
      }
      const tag = element.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select";
    })
  ) {
    return commandCenterOpen ? "command-center" : "editable";
  }

  // Checked after the editable branch, so native inputs keep their existing
  // scope. A focused switch or button owns Space and Enter; treating it as
  // "other" let the global Space binding cancel the key before the control
  // could act on it.
  if (candidates.some(isActivatableControl)) {
    return commandCenterOpen ? "command-center" : "control";
  }

  return commandCenterOpen ? "command-center" : "other";
}
