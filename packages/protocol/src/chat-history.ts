/** Remove the fork prompt envelope while preserving the snapshot body verbatim. */
export function extractChatHistoryBody(text: string): string {
  const bodyStart = text.indexOf("\n\n");
  return text.startsWith("<chat-history-summary>\n") &&
    text.endsWith("\n</chat-history-summary>") &&
    bodyStart !== -1
    ? text.slice(bodyStart + 2, -"\n</chat-history-summary>".length)
    : text;
}
