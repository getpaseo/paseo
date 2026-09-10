import { ForgeSearchItemSchema, type ForgeSearchItem } from "@getpaseo/protocol/messages";

export function parseInitialChangeRequest(value: unknown): ForgeSearchItem | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const result = ForgeSearchItemSchema.safeParse(JSON.parse(value));
    return result.success &&
      result.data.kind === "change_request" &&
      Number.isSafeInteger(result.data.number) &&
      result.data.number > 0
      ? result.data
      : undefined;
  } catch {
    return undefined;
  }
}

export function serializeInitialChangeRequest(item: ForgeSearchItem): string {
  // Route state carries checkout identity and the title, never the potentially large PR body.
  const { checks: _checks, diffStat: _diffStat, ...identity } = item;
  return JSON.stringify({ ...identity, body: null });
}

export function pullRequestState(state: string): "open" | "closed" | "merged" {
  const normalized = state.toLowerCase();
  if (normalized === "merged" || normalized === "closed") return normalized;
  return "open";
}
