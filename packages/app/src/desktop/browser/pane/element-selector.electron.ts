import type { BrowserElementAttachment } from "@/attachments/types";
import { getDesktopHost } from "@/desktop/host";

export type BrowserElementSelection = Omit<BrowserElementAttachment, "formatted" | "comment"> & {
  attributes?: Record<string, string>;
};

export type ElementSelectorMode = "annotate" | "screenshot";

export type ElementSelectorOutcome =
  | {
      type: "selected";
      mode: ElementSelectorMode;
      selection: BrowserElementSelection;
      screenshotDataUrl: string | null;
    }
  | { type: "cancelled" }
  | {
      type: "failed";
      mode: ElementSelectorMode;
      reason: "loading" | "timeout" | "unavailable";
    };

export type ElementSelectorStartResult = "started" | "loading" | "unavailable";

interface ElementSelectorWebview extends HTMLElement {
  isLoading?: () => boolean;
}

interface ElementSelectorSession {
  browserId: string;
  mode: ElementSelectorMode;
  token: string;
  webview: ElementSelectorWebview;
  onFinish: (outcome: ElementSelectorOutcome) => void;
}

export interface ElementSelectorController {
  start(input: {
    browserId: string;
    webview: ElementSelectorWebview;
    mode: ElementSelectorMode;
    onFinish: (outcome: ElementSelectorOutcome) => void;
  }): ElementSelectorStartResult;
  cancel(): void;
  stopForWebview(webview: ElementSelectorWebview): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function readSelection(value: unknown): BrowserElementSelection | null {
  if (!isRecord(value) || !isRecord(value.boundingRect)) return null;
  const rect = value.boundingRect;
  if (
    typeof value.url !== "string" ||
    typeof value.selector !== "string" ||
    typeof value.tag !== "string" ||
    typeof value.text !== "string" ||
    typeof value.outerHTML !== "string" ||
    !isRecord(value.computedStyles) ||
    typeof rect.x !== "number" ||
    typeof rect.y !== "number" ||
    typeof rect.width !== "number" ||
    typeof rect.height !== "number" ||
    !Array.isArray(value.parentChain) ||
    !Array.isArray(value.children)
  ) {
    return null;
  }
  return value as unknown as BrowserElementSelection;
}

export function createElementSelectorController(): ElementSelectorController {
  let current: ElementSelectorSession | null = null;
  let sessionCounter = 0;

  const finish = (session: ElementSelectorSession, outcome: ElementSelectorOutcome): boolean => {
    if (current !== session) return false;
    current = null;
    session.onFinish(outcome);
    return true;
  };
  const cancelBridgeSession = (session: ElementSelectorSession) => {
    const cancel = getDesktopHost()?.browser?.cancelElementSelection;
    if (typeof cancel === "function") {
      void cancel({ browserId: session.browserId, token: session.token, mode: session.mode }).catch(
        () => undefined,
      );
    }
  };

  return {
    start({ browserId, webview, mode, onFinish }) {
      if (!webview.isConnected) return "unavailable";
      if (webview.isLoading?.()) return "loading";
      const begin = getDesktopHost()?.browser?.beginElementSelection;
      if (typeof begin !== "function") return "unavailable";

      if (current) {
        const previous = current;
        cancelBridgeSession(previous);
        finish(previous, { type: "cancelled" });
      }
      sessionCounter += 1;
      const session: ElementSelectorSession = {
        browserId,
        mode,
        token: `${sessionCounter}:${crypto.randomUUID()}`,
        webview,
        onFinish,
      };
      current = session;
      void begin({ browserId, token: session.token, mode })
        .then((response) => {
          if (current !== session) return undefined;
          if (response.status === "cancelled") {
            finish(session, { type: "cancelled" });
            return undefined;
          }
          if (response.status === "failed") {
            finish(session, { type: "failed", mode: session.mode, reason: response.reason });
            return undefined;
          }
          const selection = readSelection(response.selection);
          if (!selection) {
            finish(session, { type: "failed", mode: session.mode, reason: "unavailable" });
            return undefined;
          }
          finish(session, {
            type: "selected",
            mode: response.mode,
            selection,
            screenshotDataUrl: response.screenshotDataUrl,
          });
          return undefined;
        })
        .catch(() =>
          finish(session, { type: "failed", mode: session.mode, reason: "unavailable" }),
        );
      return "started";
    },
    cancel() {
      if (!current) return;
      const session = current;
      cancelBridgeSession(session);
      finish(session, { type: "cancelled" });
    },
    stopForWebview(webview) {
      if (current?.webview !== webview) return;
      const session = current;
      cancelBridgeSession(session);
      finish(session, { type: "cancelled" });
    },
  };
}
