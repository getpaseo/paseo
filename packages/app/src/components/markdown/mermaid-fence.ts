// A fence's info string can carry more than the language ("```mermaid title=...",
// "```mermaid {theme: dark}"), so only the first whitespace-delimited token
// decides whether the fence is a diagram.
export function isMermaidFence(sourceInfo: string | null | undefined): boolean {
  if (!sourceInfo) return false;
  const first = sourceInfo.trim().split(/\s+/)[0];
  return first?.toLowerCase() === "mermaid";
}
