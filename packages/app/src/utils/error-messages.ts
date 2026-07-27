import { getErrorMessage } from "@getpaseo/protocol/error-utils";

export function toErrorMessage(error: unknown): string {
  return getErrorMessage(error);
}
