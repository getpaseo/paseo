import type {
  BrowserAutomationErrorCode,
  BrowserAutomationExecuteResponse,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";

export interface BrowserHostTarget {
  readonly browserHostId: string;
  readonly label: string;
  readonly canOpenTabs: boolean;
}

type BrowserHostResponse = BrowserAutomationExecuteResponse["payload"];
type BrowserHostSuccess = Extract<BrowserHostResponse, { ok: true }>;
type BrowserHostResult = BrowserHostSuccess["result"];
type NewTabResult = Extract<BrowserHostResult, { command: "new_tab" }>;
type ListTabsResult = Extract<BrowserHostResult, { command: "list_tabs" }>;
type BrowserHostFailure = Extract<BrowserHostResponse, { ok: false }>;

export type BrowserToolsErrorPayload = Omit<BrowserHostFailure["error"], "code"> & {
  code: BrowserAutomationErrorCode | "browser_host_ambiguous";
  browserHosts?: BrowserHostTarget[];
};

export type BrowserToolsResponsePayload =
  | (Omit<BrowserHostSuccess, "result"> & {
      result:
        | Exclude<BrowserHostResult, NewTabResult | ListTabsResult>
        | (NewTabResult & { browserHost: BrowserHostTarget })
        | (Omit<ListTabsResult, "tabs"> & {
            tabs: (ListTabsResult["tabs"][number] & { browserHost: BrowserHostTarget })[];
          });
    })
  | (Omit<BrowserHostFailure, "error"> & { error: BrowserToolsErrorPayload });

export class BrowserToolsRequestError extends Error {
  public readonly code: BrowserAutomationErrorCode;
  public readonly retryable: boolean;

  public constructor(error: BrowserHostFailure["error"]) {
    super(error.message);
    this.name = "BrowserToolsRequestError";
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

export function browserToolsFailure(params: {
  requestId: string;
  code: BrowserToolsErrorPayload["code"];
  message: string;
  retryable?: boolean;
  browserHosts?: BrowserHostTarget[];
}): BrowserToolsResponsePayload {
  return {
    requestId: params.requestId,
    ok: false,
    error: {
      code: params.code,
      message: params.message,
      retryable: params.retryable ?? false,
      ...(params.browserHosts ? { browserHosts: params.browserHosts } : {}),
    },
  };
}

export function createBrowserToolsRequestError(params: {
  code: BrowserAutomationErrorCode;
  message: string;
  retryable?: boolean;
}): BrowserToolsRequestError {
  return new BrowserToolsRequestError({
    code: params.code,
    message: params.message,
    retryable: params.retryable ?? false,
  });
}
