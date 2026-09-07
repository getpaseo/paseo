import type { ClientSideConnection, SessionModelState } from "@agentclientprotocol/sdk";
import type { ACPSessionConnection } from "../acp-agent.js";

type ModelRequest = Parameters<ClientSideConnection["unstable_setSessionModel"]>[0];
type ModeRequest = Parameters<ClientSideConnection["setSessionMode"]>[0];
type NotificationParams = Parameters<ClientSideConnection["extNotification"]>[1];
export class FakeGrokConnection implements ACPSessionConnection {
  model = "grok-4.6";
  effort = "high";
  yolo = false;
  auto = false;
  failure: Error | null = null;

  constructor(
    private readonly models: SessionModelState = {
      currentModelId: "grok-4.6",
      availableModels: [],
    },
  ) {}

  async newSession() {
    return {
      sessionId: "session-1",
      models: this.models,
      modes: { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }] },
    };
  }

  async loadSession() {
    return this.newSession();
  }
  async unstable_resumeSession() {
    return this.newSession();
  }
  async prompt(): ReturnType<ACPSessionConnection["prompt"]> {
    throw new Error("Prompting is outside this control fake");
  }
  async setSessionConfigOption(): ReturnType<ACPSessionConnection["setSessionConfigOption"]> {
    throw new Error("Standard ACP config is outside this Grok fake");
  }
  async cancel() {}
  async unstable_closeSession() {
    return {};
  }

  async unstable_setSessionModel(request: ModelRequest) {
    if (this.failure) throw this.failure;
    this.model = request.modelId;
    const effort = request._meta?.reasoningEffort;
    this.effort = typeof effort === "string" ? effort : "high";
    return { _meta: { model: { Ok: this.model } } };
  }

  async setSessionMode(request: ModeRequest) {
    if (this.failure) throw this.failure;
    this.effort = request.modeId;
    return {};
  }

  async extNotification(method: string, params: NotificationParams) {
    if (this.failure) throw this.failure;
    if (method !== "_x.ai/yolo_mode_changed") throw new Error(`Unknown notification: ${method}`);
    if (typeof params.yolo_mode === "boolean") this.yolo = params.yolo_mode;
    if (typeof params.auto_mode === "boolean") this.auto = params.auto_mode;
  }
}
