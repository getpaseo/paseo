import type { Agent } from "@/stores/session-store";

export type ExternalSessionSource = "tmux_codex" | "codex_process";

export interface ExternalSessionRecoveryDescriptor {
  source: ExternalSessionSource | null;
  isExternal: boolean;
  canRecoverWhenClosed: boolean;
  recoverableSessionId: string | null;
  restartLabel: string;
  summary: string;
}

type ExternalSessionAgentShape = {
  status: Agent["status"];
  archivedAt?: Agent["archivedAt"] | null;
  persistence?: Agent["persistence"];
  runtimeInfo?: Agent["runtimeInfo"];
};

function readExternalSessionSource(
  agent: Pick<ExternalSessionAgentShape, "persistence" | "runtimeInfo">,
): ExternalSessionSource | null {
  const candidates = [
    agent.persistence?.metadata?.externalSessionSource,
    agent.runtimeInfo?.extra?.externalSessionSource,
  ];

  for (const candidate of candidates) {
    if (candidate === "tmux_codex" || candidate === "codex_process") {
      return candidate;
    }
  }

  return null;
}

function normalizeRecoverableSessionId(candidate: unknown): string | null {
  if (typeof candidate !== "string") {
    return null;
  }
  const normalized = candidate.trim();
  if (!normalized || normalized.startsWith("/dev/") || normalized.startsWith("%")) {
    return null;
  }
  return normalized;
}

function readRecoverableSessionId(
  agent: Pick<ExternalSessionAgentShape, "persistence" | "runtimeInfo">,
): string | null {
  const candidates = [
    agent.persistence?.metadata?.sessionId,
    agent.runtimeInfo?.extra?.sessionId,
    agent.runtimeInfo?.sessionId,
    agent.persistence?.sessionId,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeRecoverableSessionId(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

export function describeExternalSessionRecovery(
  agent: ExternalSessionAgentShape,
): ExternalSessionRecoveryDescriptor {
  const source = readExternalSessionSource(agent);
  const recoverableSessionId = readRecoverableSessionId(agent);
  const isExternal = source !== null;
  const canRecoverWhenClosed = isExternal && agent.status === "closed" && !agent.archivedAt;

  if (source === "tmux_codex") {
    return {
      source,
      isExternal,
      canRecoverWhenClosed,
      recoverableSessionId,
      restartLabel: "Reopen tmux session",
      summary: recoverableSessionId
        ? "Paseo will reopen this tmux-backed Codex session and restore live control on mobile."
        : "Paseo will reopen a tmux-backed Codex terminal from the recorded workspace.",
    };
  }

  if (source === "codex_process") {
    return {
      source,
      isExternal,
      canRecoverWhenClosed,
      recoverableSessionId,
      restartLabel: recoverableSessionId ? "Resume in tmux" : "Restart in tmux",
      summary: recoverableSessionId
        ? "Paseo will relaunch this closed external Codex session inside tmux so the phone can manage it again."
        : "The original tty is gone. Paseo will start a new tmux-backed Codex terminal from the recorded workspace.",
    };
  }

  return {
    source: null,
    isExternal: false,
    canRecoverWhenClosed: false,
    recoverableSessionId: null,
    restartLabel: "Restart terminal",
    summary: "This session is not managed through the external terminal bridge.",
  };
}
