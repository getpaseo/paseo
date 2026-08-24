import { createHash } from "node:crypto";
import { LocalServiceUrlStreamDetector, type LocalServiceUrlCandidate } from "./url-candidates.js";

export type TerminalServiceLifecycle = "available" | "healthy" | "unhealthy";

export interface TerminalServiceCandidate {
  id: string;
  workspaceId: string;
  source: "terminal";
  label: string;
  lifecycle: TerminalServiceLifecycle;
  terminalId: string;
  port: number;
  localUrl: string;
  publicUrl: null;
  observedAt: string;
}

interface TerminalIdentity {
  terminalId: string;
  workspaceId: string;
}

interface TerminalServiceStoreOptions {
  now?: () => Date;
  maxCandidatesPerTerminal?: number;
}

function candidateId(identity: TerminalIdentity, candidate: LocalServiceUrlCandidate): string {
  const digest = createHash("sha256")
    .update(`${identity.workspaceId}\0${identity.terminalId}\0${candidate.port}`)
    .digest("hex")
    .slice(0, 16);
  return `wsvc_${digest}`;
}

function cloneCandidate(candidate: TerminalServiceCandidate): TerminalServiceCandidate {
  return { ...candidate };
}

export class TerminalServiceStore {
  private readonly candidates = new Map<string, TerminalServiceCandidate>();
  private readonly candidateIdsByTerminal = new Map<string, Set<string>>();
  private readonly detectors = new Map<string, LocalServiceUrlStreamDetector>();
  private readonly now: () => Date;
  private readonly maxCandidatesPerTerminal: number;

  constructor(options: TerminalServiceStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxCandidatesPerTerminal = options.maxCandidatesPerTerminal ?? 8;
  }

  get(id: string): TerminalServiceCandidate | null {
    const candidate = this.candidates.get(id);
    return candidate ? cloneCandidate(candidate) : null;
  }

  observeOutput(identity: TerminalIdentity, chunk: string): TerminalServiceCandidate[] {
    const detector = this.detectors.get(identity.terminalId) ?? new LocalServiceUrlStreamDetector();
    this.detectors.set(identity.terminalId, detector);
    const observed: TerminalServiceCandidate[] = [];
    for (const candidate of detector.push(chunk)) {
      const id = candidateId(identity, candidate);
      const terminalIds = this.candidateIdsByTerminal.get(identity.terminalId) ?? new Set<string>();
      if (!terminalIds.has(id) && terminalIds.size >= this.maxCandidatesPerTerminal) continue;
      terminalIds.add(id);
      this.candidateIdsByTerminal.set(identity.terminalId, terminalIds);
      const entry: TerminalServiceCandidate = {
        id,
        workspaceId: identity.workspaceId,
        source: "terminal",
        label: `${candidate.hostname}:${candidate.port}`,
        lifecycle: this.candidates.get(id)?.lifecycle ?? "available",
        terminalId: identity.terminalId,
        port: candidate.port,
        localUrl: candidate.url,
        publicUrl: null,
        observedAt: this.now().toISOString(),
      };
      this.candidates.set(id, entry);
      observed.push({ ...entry });
    }
    return observed;
  }

  setHealth(id: string, healthy: boolean): TerminalServiceCandidate | null {
    const candidate = this.candidates.get(id);
    if (!candidate) return null;
    const next: TerminalServiceCandidate = {
      ...candidate,
      lifecycle: healthy ? "healthy" : "unhealthy",
      observedAt: this.now().toISOString(),
    };
    this.candidates.set(id, next);
    return { ...next };
  }

  listForWorkspace(workspaceId: string): TerminalServiceCandidate[] {
    return [...this.candidates.values()]
      .filter((candidate) => candidate.workspaceId === workspaceId)
      .sort((left, right) => left.port - right.port)
      .map(cloneCandidate);
  }

  removeTerminal(terminalId: string): string[] {
    this.detectors.delete(terminalId);
    const ids = [...(this.candidateIdsByTerminal.get(terminalId) ?? [])];
    this.candidateIdsByTerminal.delete(terminalId);
    for (const id of ids) this.candidates.delete(id);
    return ids;
  }
}
