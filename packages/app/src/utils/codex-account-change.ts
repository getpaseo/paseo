import type { AgentRuntimeInfo } from "@getpaseo/protocol/agent-types";

export interface CodexAccountChange {
  previousLabel: string;
  nextLabel: string;
  revision: number;
  key: string;
}

export interface CodexAccountChangePromptState {
  accountChange: CodexAccountChange | null;
  agentId?: string;
  provider?: string;
  status: string | null;
  archived: boolean;
  isInitializing: boolean;
  isConnected: boolean;
  isPaneVisible: boolean;
  isPaneFocused: boolean;
  promptedKey: string | null;
}

export type CodexAccountReloadNotice =
  | { kind: "verified"; account: string }
  | { kind: "mismatch"; actualAccount: string; expectedAccount: string }
  | { kind: "unverified" };

export interface CodexAccountReloadResult {
  providerAccountLabel?: string | null;
  providerAccountVerificationStatus?: "verified" | "mismatch" | "unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function resolveCodexAccountChange(
  runtimeInfo: AgentRuntimeInfo | null | undefined,
): CodexAccountChange | null {
  const raw = runtimeInfo?.extra?.codexAccountChange;
  if (!isRecord(raw)) return null;
  const previousLabel = typeof raw.previousLabel === "string" ? raw.previousLabel.trim() : "";
  const nextLabel = typeof raw.nextLabel === "string" ? raw.nextLabel.trim() : "";
  const revision =
    typeof raw.revision === "number" && Number.isSafeInteger(raw.revision) ? raw.revision : 0;
  if (!previousLabel || !nextLabel) return null;
  return {
    previousLabel,
    nextLabel,
    revision,
    key: `${previousLabel}\u0000${nextLabel}\u0000${revision}`,
  };
}

export function shouldPromptCodexAccountChange(state: CodexAccountChangePromptState): boolean {
  return Boolean(
    state.accountChange &&
    state.agentId &&
    state.provider === "codex" &&
    !state.archived &&
    state.status !== "running" &&
    !state.isInitializing &&
    state.isConnected &&
    state.isPaneVisible &&
    state.isPaneFocused &&
    state.promptedKey !== state.accountChange.key,
  );
}

export function resolveCodexAccountReloadNotice(
  result: CodexAccountReloadResult,
  accountChange: CodexAccountChange,
): CodexAccountReloadNotice {
  const actualAccount = result.providerAccountLabel?.trim();
  if (actualAccount && result.providerAccountVerificationStatus === "mismatch") {
    return {
      kind: "mismatch",
      actualAccount,
      expectedAccount: accountChange.nextLabel,
    };
  }
  if (actualAccount && result.providerAccountVerificationStatus === "verified") {
    return { kind: "verified", account: actualAccount };
  }
  return { kind: "unverified" };
}
