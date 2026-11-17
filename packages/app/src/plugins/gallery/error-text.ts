/**
 * What a failed plugin request tells the user. A daemon RPC error keeps the daemon's text in
 * `userMessage`; its `message` adds the request type and code for logs.
 */
export function pluginErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const userMessage: unknown = Reflect.get(error, "userMessage");
  return typeof userMessage === "string" ? userMessage : error.message;
}
