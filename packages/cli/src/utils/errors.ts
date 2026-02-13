/**
 * Convert unknown thrown values into a user-safe error string.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
