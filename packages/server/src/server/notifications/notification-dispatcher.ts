import type pino from "pino";
import type { PushNotificationSender, PushPayload } from "../push/index.js";
import {
  computeNotificationPlan,
  computeRemoteNotificationPlan,
  type AttentionFocusTarget,
  type ClientPresenceState,
} from "../agent-attention-policy.js";
import {
  NotificationConfigSchema,
  validateNotificationConfig,
  type NotificationConfig,
} from "./notification-config.js";
import { createNotificationHttp, type NotificationHttp } from "./notification-http.js";
import { NtfyProvider, type NtfyMessage } from "./ntfy-provider.js";

export interface NotificationEvent {
  id: string;
  type:
    | "agent_finished"
    | "agent_error"
    | "permission_required"
    | "terminal_finished"
    | "terminal_attention";
  timestamp: string;
  payload: PushPayload;
  agentName?: string;
  provider?: string;
  workspaceName?: string;
  projectName?: string;
}
function cleanText(text: string, limit: number): string {
  return Array.from(text, (character) =>
    character.codePointAt(0)! < 32 || character.codePointAt(0) === 127 ? " " : character,
  )
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export class NotificationDispatcher {
  private closed = false;
  readonly config: NotificationConfig;
  private readonly seen = new Map<string, number>();
  private readonly ntfy: NtfyProvider | undefined;
  private readonly transport: ReturnType<typeof createNotificationHttp> | undefined;
  constructor(
    private readonly options: {
      config?: NotificationConfig;
      logger: pino.Logger;
      expo: PushNotificationSender;
      filePath: string;
      http?: NotificationHttp;
      now?: () => number;
      automatic?: boolean;
    },
  ) {
    this.config = options.config ?? NotificationConfigSchema.parse({});
    validateNotificationConfig(this.config);
    if (this.config.enabled && this.config.provider !== "expo") {
      this.transport = options.http ? undefined : createNotificationHttp();
      this.ntfy = new NtfyProvider({
        config: this.config.ntfy,
        logger: options.logger,
        filePath: options.filePath,
        http: options.http ?? this.transport!.request,
        now: options.now,
        automatic: options.automatic,
      });
    }
  }

  dispatch(
    event: NotificationEvent,
    states: ClientPresenceState[],
    focusTarget: AttentionFocusTarget,
  ): void {
    if (this.closed) return;
    const nowMs = this.options.now?.() ?? Date.now();
    for (const [id, expiry] of this.seen) if (expiry <= nowMs) this.seen.delete(id);
    if (this.seen.has(event.id)) return;
    if (this.seen.size >= 1024) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(event.id, nowMs + 24 * 60 * 60 * 1000);
    const config = this.config;
    const eventEnabled = {
      agent_finished: config.onFinish,
      agent_error: config.onError ?? config.mode !== "legacy",
      permission_required: config.onPermission,
      terminal_finished: config.onTerminal,
      terminal_attention: config.onTerminal,
    }[event.type];
    const plan = computeRemoteNotificationPlan({
      allStates: states,
      focusTarget,
      nowMs,
      pushEligible: config.enabled && eventEnabled,
      mode: config.mode,
    });
    const providers: string[] = [];
    const fields = notificationDecisionFields(
      event,
      states,
      focusTarget,
      nowMs,
      config.mode,
      plan.excludedExpoTokens.length,
    );
    const fallbacks = {
      agent_finished: "Finished working.",
      agent_error: "Encountered an error.",
      permission_required: "Permission requested.",
      terminal_finished: "Terminal finished.",
      terminal_attention: "Terminal needs input.",
    };
    const payload = {
      title: cleanText(event.payload.title, 256),
      body: cleanText(
        config.includePreviews || event.type.startsWith("terminal_")
          ? event.payload.body
          : fallbacks[event.type],
        220,
      ),
      data: { ...event.payload.data, notificationId: event.id, timestamp: event.timestamp },
      excludedTokens: plan.excludedExpoTokens,
    };
    if (config.provider !== "ntfy" && plan.expoEligible) {
      providers.push("expo");
      void this.options.expo.send(payload).catch(() => {
        this.seen.delete(event.id);
        this.options.logger.error(
          { ...fields, provider: "expo", category: "submission" },
          "Notification submission failed",
        );
      });
    }
    if (this.ntfy && plan.ntfyEligible) {
      providers.push("ntfy");
      void this.ntfy.send(event.id, buildNtfyMessage(event, payload, config)).catch(() => {
        this.seen.delete(event.id);
        this.options.logger.error(
          { ...fields, provider: "ntfy", category: "submission" },
          "Notification submission failed",
        );
      });
    }
    let suppressionReason: string | undefined;
    if (!config.enabled) suppressionReason = "disabled";
    else if (!eventEnabled) suppressionReason = "event_disabled";
    else if (providers.length === 0) suppressionReason = "presence_or_provider";
    this.options.logger.info(
      { ...fields, providers, suppressionReason },
      providers.length ? "Notification dispatched" : "Notification suppressed",
    );
  }

  async flush(): Promise<void> {
    await this.ntfy?.drain();
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.ntfy?.close();
    await this.transport?.close();
  }
}

function notificationDecisionFields(
  event: NotificationEvent,
  states: ClientPresenceState[],
  focusTarget: AttentionFocusTarget,
  nowMs: number,
  mode: NotificationConfig["mode"],
  excludedDeviceCount: number,
) {
  const legacy = computeNotificationPlan({
    allStates: states,
    focusTarget,
    pushEligible: true,
    nowMs,
  });
  return {
    event: "notification_dispatch",
    eventId: event.id,
    type: event.type,
    agentId: event.payload.data?.agentId,
    terminalId: event.payload.data?.terminalId,
    mode,
    desktopPresent: states.some(
      (state) =>
        state.deviceType === "web" &&
        state.lastActivityAtMs !== null &&
        state.lastActivityAtMs <= nowMs &&
        nowMs - state.lastActivityAtMs < 180_000,
    ),
    inAppRecipientIndex: legacy.inAppRecipientIndex,
    excludedDeviceCount,
  };
}

function buildNtfyMessage(
  event: NotificationEvent,
  payload: PushPayload,
  config: NotificationConfig,
): NtfyMessage {
  const priorities = {
    agent_finished: "finished",
    agent_error: "error",
    permission_required: "permission",
    terminal_finished: "terminal",
    terminal_attention: "terminal",
  } as const;
  const context = [
    event.projectName ? `Project: ${cleanText(event.projectName, 120)}` : null,
    event.workspaceName ? `Workspace: ${cleanText(event.workspaceName, 120)}` : null,
    `Server: ${cleanText(String(event.payload.data?.serverId), 120)}`,
    event.payload.data?.agentId
      ? `Agent ID: ${cleanText(String(event.payload.data.agentId), 120)}`
      : null,
    event.payload.data?.terminalId
      ? `Terminal ID: ${cleanText(String(event.payload.data.terminalId), 120)}`
      : null,
    event.agentName ? `Agent: ${cleanText(event.agentName, 120)}` : null,
    event.provider ? `Provider: ${cleanText(event.provider, 80)}` : null,
    `Event: ${event.type}`,
    `Time: ${event.timestamp}`,
    payload.body,
  ]
    .filter((line) => line !== null)
    .join("\n");
  return {
    title: cleanText(`${event.agentName ?? event.provider ?? "Paseo"} - ${payload.title}`, 256),
    message: context,
    priority: config.ntfy.priorities[priorities[event.type]],
  };
}
