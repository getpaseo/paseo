import { describe, expect, it } from "vitest";
import type { ComposerAttachment } from "@/attachments/types";
import { splitComposerAttachmentsForSubmit } from "./submit";

describe("splitComposerAttachmentsForSubmit", () => {
  it("serializes agent context as a daemon-local reference", () => {
    const attachment: ComposerAttachment = {
      kind: "agent_context",
      source: {
        serverId: "server-a",
        agentId: "agent-source",
        title: "Investigate auth race",
        workspaceLabel: "Paseo",
        provider: "codex",
      },
    };

    expect(splitComposerAttachmentsForSubmit([attachment])).toEqual({
      images: [],
      attachments: [
        {
          type: "agent_context",
          agentId: "agent-source",
          title: "Investigate auth race",
        },
      ],
    });
  });

  it("serializes a prepared encrypted cross-host transfer", () => {
    const attachment: ComposerAttachment = {
      kind: "agent_context",
      source: { serverId: "source", agentId: "agent-source", title: "Source" },
      crossHost: { destinationServerId: "destination", mode: "secure" },
      transfer: {
        version: 1,
        destinationServerId: "destination",
        sourcePublicKeyB64: "source-key",
        ciphertextB64: "ciphertext",
      },
    };

    expect(splitComposerAttachmentsForSubmit([attachment]).attachments).toEqual([
      {
        type: "agent_context",
        agentId: "agent-source",
        title: "Source",
        transfer: attachment.transfer,
      },
    ]);
  });

  it("rejects an unprepared cross-host reference", () => {
    const attachment: ComposerAttachment = {
      kind: "agent_context",
      source: { serverId: "source", agentId: "agent-source", title: "Source" },
      crossHost: { destinationServerId: "destination", mode: "secure" },
    };

    expect(() => splitComposerAttachmentsForSubmit([attachment])).toThrow(
      "Cross-host agent context must be prepared before submission.",
    );
  });
});
