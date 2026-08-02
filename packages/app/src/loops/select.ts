export type LoopRole = "worker" | "verifier";

export interface LoopTrackRow {
  loopId: string;
  name: string | null;
  promptPreview: string | null; // optional if list lacks prompt; use name/id
  role: LoopRole;
  activeIteration: number | null;
  status: "running";
}

export function selectLoopsForAgent(input: {
  agentId: string;
  loops: Array<{
    id: string;
    name: string | null;
    status: string;
    activeIteration: number | null;
    activeWorkerAgentId?: string | null;
    activeVerifierAgentId?: string | null;
  }>;
}): LoopTrackRow[] {
  const rows: LoopTrackRow[] = [];
  for (const loop of input.loops) {
    if (loop.status !== "running") continue;
    if (loop.activeWorkerAgentId === input.agentId) {
      rows.push({
        loopId: loop.id,
        name: loop.name,
        promptPreview: null,
        role: "worker",
        activeIteration: loop.activeIteration,
        status: "running",
      });
      continue;
    }
    if (loop.activeVerifierAgentId === input.agentId) {
      rows.push({
        loopId: loop.id,
        name: loop.name,
        promptPreview: null,
        role: "verifier",
        activeIteration: loop.activeIteration,
        status: "running",
      });
    }
  }
  return rows;
}
