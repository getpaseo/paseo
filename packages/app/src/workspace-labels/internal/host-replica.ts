import type { WorkspaceLabelDefinition } from "@getpaseo/protocol/workspace-labels";
import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";
import type { WorkspaceLabelListPayload } from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";

type WorkspaceLabelUpdate = Extract<SessionOutboundMessage, { type: "workspace.label.update" }>;

export class HostWorkspaceLabelReplica {
  private labels = new Map<string, WorkspaceLabelDefinition>();
  private cursor: { generation: string; afterSeq: number } | undefined;

  snapshot(): {
    labels: WorkspaceLabelDefinition[];
    cursor?: { generation: string; afterSeq: number };
  } {
    return {
      labels: [...this.labels.values()],
      ...(this.cursor ? { cursor: this.cursor } : {}),
    };
  }

  applyList(payload: WorkspaceLabelListPayload): void {
    if (payload.sync.mode === "snapshot") this.labels.clear();
    for (const removal of payload.sync.removals)
      this.labels.delete(workspaceLabelKey(removal.name));
    for (const label of payload.labels) this.labels.set(workspaceLabelKey(label.name), label);
    this.cursor = { generation: payload.sync.generation, afterSeq: payload.sync.headSeq };
  }

  applyUpdate(message: WorkspaceLabelUpdate): boolean {
    const update = message.payload;
    if (
      !this.cursor ||
      update.generation !== this.cursor.generation ||
      update.seq !== this.cursor.afterSeq + 1
    ) {
      return false;
    }
    if (update.kind === "remove") {
      this.labels.delete(workspaceLabelKey(update.name));
    } else {
      if (update.previousName) this.labels.delete(workspaceLabelKey(update.previousName));
      this.labels.set(workspaceLabelKey(update.label.name), update.label);
    }
    this.cursor = { generation: update.generation, afterSeq: update.seq };
    return true;
  }
}
