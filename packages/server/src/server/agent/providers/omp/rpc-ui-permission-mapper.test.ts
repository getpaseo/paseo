import { describe, expect, test } from "vitest";

import type { OmpRuntimeEvent } from "./rpc-types.js";
import {
  buildOmpRpcUiPermissionResponse,
  classifyOmpRpcUiPermissionRequest,
} from "./rpc-ui-permission-mapper.js";

type ExtensionUiRequestEvent = Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>;

const RPC_UI_CASES: ExtensionUiRequestEvent[] = [
  { type: "extension_ui_request", id: "widget", method: "setWidget", widgetKey: "status" },
  { type: "extension_ui_request", id: "notify", method: "notify", message: "done" },
  {
    type: "extension_ui_request",
    id: "bash",
    method: "select",
    title: "Allow tool: bash\nCommand: echo rpc-ui-hi",
    options: ["Approve", "Deny"],
  },
  {
    type: "extension_ui_request",
    id: "edit",
    method: "select",
    title: "Allow tool: edit\nFile: fixture.txt",
    options: ["Approve", "Deny"],
  },
  {
    type: "extension_ui_request",
    id: "write",
    method: "select",
    title: "Allow tool: write\nPath: created.txt\nContent:\nhello write",
    options: ["Approve", "Deny"],
  },
];

function toolApproval(id: string) {
  const event = RPC_UI_CASES.find((candidate) => candidate.id === id);
  if (!event) throw new Error(`Missing RPC-UI case ${id}`);
  const classification = classifyOmpRpcUiPermissionRequest(event);
  if (classification.kind !== "tool") throw new Error(`Expected ${id} to be a tool approval`);
  return classification.request;
}

describe("OMP rpc-ui permission mapper", () => {
  test("classifies tool approvals and passes through unrelated UI requests", () => {
    expect(
      RPC_UI_CASES.map((event) => {
        const classification = classifyOmpRpcUiPermissionRequest(event);
        return [event.id, classification.kind];
      }),
    ).toEqual([
      ["widget", "passthrough"],
      ["notify", "passthrough"],
      ["bash", "tool"],
      ["edit", "tool"],
      ["write", "tool"],
    ]);
  });

  test("maps tool approvals to renderable permissions", () => {
    expect([toolApproval("bash"), toolApproval("edit"), toolApproval("write")]).toEqual([
      expect.objectContaining({
        id: "bash",
        provider: "omp",
        name: "bash",
        kind: "tool",
        detail: { type: "shell", command: "echo rpc-ui-hi" },
        metadata: expect.objectContaining({
          toolName: "bash",
          toolArgs: { command: "echo rpc-ui-hi" },
          approveValue: "Approve",
          denyValue: "Deny",
        }),
      }),
      expect.objectContaining({
        id: "edit",
        provider: "omp",
        name: "edit",
        kind: "tool",
        detail: { type: "edit", filePath: "fixture.txt" },
        metadata: expect.objectContaining({ toolName: "edit", toolArgs: { path: "fixture.txt" } }),
      }),
      expect.objectContaining({
        id: "write",
        provider: "omp",
        name: "write",
        kind: "tool",
        detail: { type: "write", filePath: "created.txt", content: "hello write" },
        metadata: expect.objectContaining({
          toolName: "write",
          toolArgs: { path: "created.txt", content: "hello write" },
        }),
      }),
    ]);
  });

  test("preserves destructive multiline CRLF bash commands exactly", () => {
    const title = "Allow tool: bash\r\nCommand: printf first\r\n\r\n  rm -rf /tmp/example\r\n";
    const classification = classifyOmpRpcUiPermissionRequest({
      type: "extension_ui_request",
      id: "multiline-bash",
      method: "select",
      title,
      options: ["Approve", "Deny"],
    });
    if (classification.kind !== "tool") throw new Error("Expected multiline bash approval");

    expect(classification.request.detail).toEqual({
      type: "shell",
      command: "printf first\r\n\r\n  rm -rf /tmp/example\r\n",
    });
    expect(classification.request.metadata?.toolArgs).toEqual({
      command: "printf first\r\n\r\n  rm -rf /tmp/example\r\n",
    });
  });

  test("rejects approval lookalikes and unknown tools", () => {
    expect(
      classifyOmpRpcUiPermissionRequest({
        type: "extension_ui_request",
        id: "not-tool",
        method: "select",
        title: "Allow tool: bash\nCommand: echo hi",
        options: ["Yes", "No"],
      }),
    ).toEqual({ kind: "passthrough" });
    expect(
      classifyOmpRpcUiPermissionRequest({
        type: "extension_ui_request",
        id: "unknown-tool",
        method: "select",
        title: "Allow tool: custom_tool\nReason: needs approval",
        options: ["Approve", "Deny"],
      }),
    ).toEqual({ kind: "passthrough" });
  });

  test("responds to tool approvals with exact select values", () => {
    const request = toolApproval("bash");

    expect(buildOmpRpcUiPermissionResponse(request, { behavior: "allow" })).toEqual({
      value: "Approve",
    });
    expect(
      buildOmpRpcUiPermissionResponse(request, {
        behavior: "allow",
        selectedActionId: "allow_always",
      }),
    ).toEqual({ value: "Approve" });
    expect(buildOmpRpcUiPermissionResponse(request, { behavior: "deny", message: "no" })).toEqual({
      value: "Deny",
    });
  });
});
