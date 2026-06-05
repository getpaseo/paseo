import type {
  BrowserAutomationErrorCode,
  BrowserAutomationExecuteResponse,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";

export type BrowserToolsResponsePayload = BrowserAutomationExecuteResponse["payload"];
export type BrowserToolsErrorPayload = Extract<BrowserToolsResponsePayload, { ok: false }>["error"];

export class BrowserToolsRequestError extends Error {
  public readonly code: BrowserAutomationErrorCode;
  public readonly retryable: boolean;

  public constructor(error: BrowserToolsErrorPayload) {
    super(error.message);
    this.name = "BrowserToolsRequestError";
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

export function browserToolsFailure(params: {
  requestId: string;
  code: BrowserAutomationErrorCode;
  message: string;
  retryable?: boolean;
}): BrowserToolsResponsePayload {
  return {
    requestId: params.requestId,
    ok: false,
    error: {
      code: params.code,
      message: params.message,
      retryable: params.retryable ?? false,
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
