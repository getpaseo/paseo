export const BROWSER_ELEMENT_BEGIN_CHANNEL = "paseo:browser-element:begin";
export const BROWSER_ELEMENT_CANCEL_CHANNEL = "paseo:browser-element:cancel";
export const BROWSER_ELEMENT_GUEST_BEGIN_CHANNEL = "paseo:browser-element:guest-begin";
export const BROWSER_ELEMENT_GUEST_CANCEL_CHANNEL = "paseo:browser-element:guest-cancel";
export const BROWSER_ELEMENT_GUEST_READY_CHANNEL = "paseo:browser-element:guest-ready";
export const BROWSER_ELEMENT_GUEST_RESULT_CHANNEL = "paseo:browser-element:guest-result";

export type BrowserElementSelectorMode = "annotate" | "screenshot";

export interface BrowserElementBeginInput {
  browserId: string;
  token: string;
  mode: BrowserElementSelectorMode;
}

export type BrowserElementSelectorResponse =
  | {
      status: "selected";
      mode: BrowserElementSelectorMode;
      selection: Record<string, unknown>;
      screenshotDataUrl: string | null;
    }
  | { status: "cancelled" }
  | { status: "failed"; reason: "loading" | "timeout" | "unavailable" };
