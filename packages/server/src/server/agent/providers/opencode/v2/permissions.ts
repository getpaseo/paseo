import type { FormInfo, FormValue } from "@opencode/client";
import type { V2Api } from "./api.js";

import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../../../agent-sdk-types.js";

export class SessionPermissions {
  private readonly pending = new Map<string, AgentPermissionRequest>();
  private readonly permissionOwners = new Map<string, string>();
  private readonly forms = new Map<string, FormInfo>();
  constructor(
    private readonly client: V2Api,
    private readonly id: string,
    private readonly config: AgentSessionConfig,
    private readonly emit: (event: AgentStreamEvent) => void,
  ) {}
  observe(event: import("@opencode/client").OpenCodeEvent) {
    if (event.type === "permission.replied") {
      this.resolvePending(event.data.requestID, {
        behavior: event.data.reply === "reject" ? "deny" : "allow",
      });
    }
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      this.resolvePending(event.data.id, {
        behavior: event.type === "form.cancelled" ? "deny" : "allow",
      });
    }
  }
  list() {
    return [...this.pending.values()];
  }
  async respondToPermission(requestId: string, response: AgentPermissionResponse) {
    const form = this.forms.get(requestId);
    if (form) {
      if (response.behavior === "deny")
        await this.client.session.form.cancel({ sessionID: form.sessionID, formID: form.id });
      else {
        const raw = response.updatedInput?.answers;
        const answer: Record<string, FormValue> = {};
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new Error("OpenCode question response requires answers");
        for (const field of form.fields) {
          const value: unknown =
            Reflect.get(raw, field.key) ?? Reflect.get(raw, field.title ?? field.key);
          const normalized = formAnswer(field, value);
          if (normalized !== undefined) answer[field.key] = normalized;
        }
        await this.client.session.form.reply({
          sessionID: form.sessionID,
          formID: form.id,
          answer,
        });
      }
      this.forms.delete(requestId);
    } else {
      await this.client.permission.reply({
        sessionID: this.permissionOwners.get(requestId) ?? this.id,
        requestID: requestId,
        decision: permissionReply(response),
      });
    }
    this.resolvePending(requestId, response);
  }
  async reconcile(sessionID: string) {
    const [permissions, forms] = await Promise.all([
      this.client.permission.list({ sessionID }),
      this.client.session.form.list({ sessionID }),
    ]);
    for (const request of permissions) {
      if (this.pending.has(request.id)) continue;
      const pending: AgentPermissionRequest = {
        id: request.id,
        provider: "opencode",
        kind: "tool",
        name: request.action,
        description: request.message ?? request.resources.join("\n"),
        actions: [
          { id: "once", label: "Allow once", behavior: "allow" },
          { id: "always", label: "Always allow", behavior: "allow" },
          { id: "reject", label: "Deny", behavior: "deny" },
        ],
      };
      this.pending.set(request.id, pending);
      this.permissionOwners.set(request.id, sessionID);
      if (!this.config.toolPolicy && this.config.featureValues?.["auto_accept"] === true)
        await this.respondToPermission(request.id, { behavior: "allow" });
      else this.emit({ type: "permission_requested", provider: "opencode", request: pending });
    }
    for (const form of forms) {
      if (this.pending.has(form.id)) continue;
      const pending: AgentPermissionRequest = {
        id: form.id,
        provider: "opencode",
        name: "question",
        kind: "question",
        title: form.title,
        input: {
          questions: form.fields.map((field) => ({
            header: field.key,
            question: field.title ?? field.key,
            options: "options" in field ? field.options : undefined,
            multiple: field.type === "multiselect",
          })),
        },
      };
      this.forms.set(form.id, form);
      this.pending.set(form.id, pending);
      this.emit({ type: "permission_requested", provider: "opencode", request: pending });
    }
  }
  resolvePending(requestId: string, resolution: AgentPermissionResponse) {
    if (!this.pending.delete(requestId)) return;
    this.forms.delete(requestId);
    this.permissionOwners.delete(requestId);
    this.emit({ type: "permission_resolved", provider: "opencode", requestId, resolution });
  }
}
function permissionReply(response: AgentPermissionResponse): "reject" | "once" | "always" {
  if (response.behavior === "deny") return "reject";
  return response.selectedActionId === "always" ? "always" : "once";
}

function formAnswer(field: FormInfo["fields"][number], value: unknown): FormValue | undefined {
  if (value === undefined) return undefined;
  if (field.type === "external") return undefined;
  const labelValue = (label: string) => {
    const options = "options" in field ? field.options : undefined;
    return (
      options?.find((option) => option.value === label)?.value ??
      options?.find((option) => option.label === label)?.value ??
      label
    );
  };
  if (field.type === "multiselect") {
    if (Array.isArray(value) && value.every((item: unknown) => typeof item === "string"))
      return value.map(labelValue);
  } else if (field.type === "string" && typeof value === "string") {
    return labelValue(value);
  } else if (field.type === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
  } else if (field.type === "number" || field.type === "integer") {
    const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
    if (
      typeof numeric === "number" &&
      Number.isFinite(numeric) &&
      (field.type !== "integer" || Number.isInteger(numeric))
    )
      return numeric;
  }
  throw new Error(`Invalid answer for OpenCode question ${field.key}`);
}
