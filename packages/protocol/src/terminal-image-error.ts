import type { TerminalClipboardWriteImageResponse } from "./messages.js";

export type TerminalImageErrorCode = NonNullable<
  TerminalClipboardWriteImageResponse["payload"]["errorCode"]
>;

export class TerminalImageError extends Error {
  constructor(
    readonly code: TerminalImageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Never send filesystem paths or arbitrary exception messages to clients. */
export function terminalImageErrorCode(error: unknown): TerminalImageErrorCode {
  if (error instanceof TerminalImageError) return error.code;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOSPC" || error.code === "EDQUOT")
  )
    return "disk_full";
  return "upload_failed";
}
