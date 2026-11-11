import { describe, expect, it } from "vitest";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { PendingCreateAttempt } from "@/stores/create-flow-store";
import type { UserMessageImageAttachment } from "@/types/stream";
import { DRAFT_CAPABILITIES, resolveDraftTimeline } from "./timeline";

const image: UserMessageImageAttachment = {
  id: "image-1",
  mimeType: "image/png",
  storageType: "web-indexeddb",
  storageKey: "image-key",
  createdAt: 123,
};
const attachment = {
  type: "review",
  cwd: "/repo",
  summary: "Review",
} as unknown as AgentAttachment;

function pendingAttempt(overrides: Partial<PendingCreateAttempt> = {}): PendingCreateAttempt {
  return {
    draftId: "draft-1",
    serverId: "server-1",
    agentId: null,
    clientMessageId: "draft-1:initial-message",
    text: "build this",
    timestamp: Date.parse("2026-05-25T00:00:00.000Z"),
    lifecycle: "active",
    images: [image],
    attachments: [attachment],
    ...overrides,
  };
}

describe("resolveDraftTimeline", () => {
  it("shows the sent prompt pending with the turn working", () => {
    const timeline = resolveDraftTimeline({
      pending: pendingAttempt(),
      serverId: "server-1",
      tabId: "tab-1",
      cwd: "/repo",
    });

    expect(timeline?.agent).toEqual({
      serverId: "server-1",
      id: "tab-1",
      status: "running",
      cwd: "/repo",
      capabilities: DRAFT_CAPABILITIES,
    });
    expect(timeline?.streamItems).toEqual([
      {
        kind: "user_message",
        id: "draft-1:initial-message",
        clientMessageId: "draft-1:initial-message",
        text: "build this",
        timestamp: new Date("2026-05-25T00:00:00.000Z"),
        images: [image],
        attachments: [attachment],
      },
    ]);
    expect(timeline?.pendingMessageSubmissions).toEqual([
      { clientMessageId: "draft-1:initial-message" },
    ]);
    expect(timeline?.turnPresentation.isActive).toBe(true);
  });

  it("keeps the prompt once the agent is created, until the tab retargets", () => {
    const timeline = resolveDraftTimeline({
      pending: pendingAttempt({ lifecycle: "sent", agentId: "agent-1" }),
      serverId: "server-1",
      tabId: "tab-1",
      cwd: "/repo",
    });

    expect(timeline?.streamItems).toHaveLength(1);
  });

  it("shows only the working turn for a prompt without content", () => {
    const timeline = resolveDraftTimeline({
      pending: pendingAttempt({ text: "", images: undefined, attachments: undefined }),
      serverId: "server-1",
      tabId: "tab-1",
      cwd: "/repo",
    });

    expect(timeline?.streamItems).toEqual([]);
    expect(timeline?.turnPresentation.isActive).toBe(true);
  });

  it("shows no timeline before a prompt is sent, after it fails, or on another host", () => {
    const base = { serverId: "server-1", tabId: "tab-1", cwd: "/repo" };

    expect(resolveDraftTimeline({ ...base, pending: undefined })).toBeNull();
    expect(
      resolveDraftTimeline({ ...base, pending: pendingAttempt({ lifecycle: "abandoned" }) }),
    ).toBeNull();
    expect(
      resolveDraftTimeline({ ...base, pending: pendingAttempt({ serverId: "server-2" }) }),
    ).toBeNull();
    expect(resolveDraftTimeline({ ...base, cwd: null, pending: pendingAttempt() })).toBeNull();
  });
});
