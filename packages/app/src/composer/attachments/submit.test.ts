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
});
