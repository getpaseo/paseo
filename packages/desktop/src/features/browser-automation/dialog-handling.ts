import type { BrowserAutomationDialogEvent } from "@getpaseo/protocol/browser-automation/rpc-schemas";

export const MAX_DIALOGS_PER_COMMAND = 20;

export interface JavaScriptDialogOpening {
  type?: unknown;
  message?: unknown;
  defaultPrompt?: unknown;
}

interface DialogPolicy {
  readonly action: BrowserAutomationDialogEvent["action"];
  readonly accept: boolean;
}

const DIALOG_POLICIES: Record<BrowserAutomationDialogEvent["type"], DialogPolicy> = {
  alert: { action: "accepted", accept: true },
  confirm: { action: "dismissed", accept: false },
  prompt: { action: "dismissed", accept: false },
  beforeunload: { action: "dismissed", accept: false },
};

export function handledDialogEvent(opening: JavaScriptDialogOpening): BrowserAutomationDialogEvent {
  const type = normalizeDialogType(opening.type);
  const policy = DIALOG_POLICIES[type];
  return {
    type,
    message: typeof opening.message === "string" ? opening.message : String(opening.message ?? ""),
    ...(typeof opening.defaultPrompt === "string" ? { defaultValue: opening.defaultPrompt } : {}),
    action: policy.action,
    timestamp: Date.now(),
  };
}

export function dialogAcceptValue(type: BrowserAutomationDialogEvent["type"]): boolean {
  return DIALOG_POLICIES[type].accept;
}

export function promptShimInstallScript(): string {
  return String.raw`(() => {
    const stateKey = "__PASEO_BROWSER_AUTOMATION_DIALOG_STATE__";
    const state = window[stateKey] || { prompts: [], installed: false };
    window[stateKey] = state;
    if (state.installed) return true;
    const originalPrompt = window.prompt;
    Object.defineProperty(state, "originalPrompt", { configurable: true, value: originalPrompt });
    const promptShim = (message = "", defaultValue = "") => {
      state.prompts.push({
        type: "prompt",
        message: String(message ?? ""),
        defaultValue: String(defaultValue ?? ""),
        action: "dismissed",
        timestamp: Date.now(),
      });
      return null;
    };
    Object.defineProperty(state, "promptShim", { configurable: true, value: promptShim });
    window.prompt = promptShim;
    state.installed = true;
    return true;
  })()`;
}

export function promptShimDrainScript(): string {
  return String.raw`(() => {
    const state = window.__PASEO_BROWSER_AUTOMATION_DIALOG_STATE__;
    if (!state || !Array.isArray(state.prompts)) return [];
    return state.prompts.splice(0);
  })()`;
}

export function promptShimRestoreScript(): string {
  return String.raw`(() => {
    const stateKey = "__PASEO_BROWSER_AUTOMATION_DIALOG_STATE__";
    const state = window[stateKey];
    if (!state || !state.installed) return true;
    if (window.prompt === state.promptShim && typeof state.originalPrompt === "function") {
      window.prompt = state.originalPrompt;
    }
    delete window[stateKey];
    return true;
  })()`;
}

function normalizeDialogType(value: unknown): BrowserAutomationDialogEvent["type"] {
  return value === "alert" || value === "confirm" || value === "prompt" || value === "beforeunload"
    ? value
    : "alert";
}
