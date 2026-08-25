/**
 * Agent state model for ArkUI.
 *
 * Mirrors the daemon's agent lifecycle:
 *   initializing → idle ⇄ running → closed
 *                        ↓
 *                      error
 */

export type AgentStatus = 'initializing' | 'idle' | 'running' | 'error' | 'closed';

export interface AgentUpdatePayload {
  id: string;
  title?: string;
  status?: AgentStatus;
  provider?: string;
  model?: string;
  mode?: string;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
}

@Observed
export class AgentModel {
  id: string = '';
  title: string = '';
  status: AgentStatus = 'idle';
  provider: string = '';
  model: string = '';
  mode: string = '';
  cwd: string = '';
  createdAt: number = 0;
  updatedAt: number = 0;

  /** Update all fields at once from a daemon agent_update payload. */
  applyUpdate(update: AgentUpdatePayload): void {
    this.id = update.id;
    if (update.title !== undefined) this.title = update.title;
    if (update.status !== undefined) this.status = update.status;
    if (update.provider !== undefined) this.provider = update.provider;
    if (update.model !== undefined) this.model = update.model;
    if (update.mode !== undefined) this.mode = update.mode;
    if (update.cwd !== undefined) this.cwd = update.cwd;
    if (update.createdAt !== undefined) this.createdAt = update.createdAt;
    if (update.updatedAt !== undefined) this.updatedAt = update.updatedAt;
  }

  /** Status label for display. */
  get statusLabel(): string {
    switch (this.status) {
      case 'initializing': return 'Initializing…';
      case 'idle': return 'Idle';
      case 'running': return 'Running';
      case 'error': return 'Error';
      case 'closed': return 'Closed';
      default: return 'Unknown';
    }
  }

  /** Whether the agent is currently responding. */
  get isActive(): boolean {
    return this.status === 'running' || this.status === 'initializing';
  }
}
