import { describe, expect, it, vi } from "vitest";
import type { AgentContextSubmitRuntime } from "./agent-context-transfer";
import { prepareAgentContextAttachmentsForSubmit } from "./agent-context-transfer";
import type { AgentContextAttachment } from "./types";

function crossHostAttachment(mode: "secure" | "compatibility"): AgentContextAttachment {
  const crossHost =
    mode === "secure"
      ? ({ destinationServerId: "destination", mode } as const)
      : ({ destinationServerId: "destination", mode, userConfirmed: true } as const);
  return {
    kind: "agent_context",
    source: { serverId: "source", agentId: "agent-1", title: "Private investigation" },
    crossHost,
  };
}

function runtime(input: {
  sourceFeatures: { agentContextTransfer?: boolean; agentForkContext?: boolean };
  destinationFeatures: { agentContextTransfer?: boolean };
  getRecipient?: ReturnType<typeof vi.fn>;
  exportTransfer?: ReturnType<typeof vi.fn>;
  buildForkContext?: ReturnType<typeof vi.fn>;
}): AgentContextSubmitRuntime {
  const sourceClient = {
    getAgentContextTransferRecipient: vi.fn(),
    exportAgentContextTransfer: input.exportTransfer ?? vi.fn(),
    buildAgentForkContext: input.buildForkContext ?? vi.fn(),
  };
  const destinationClient = {
    getAgentContextTransferRecipient: input.getRecipient ?? vi.fn(),
    exportAgentContextTransfer: vi.fn(),
    buildAgentForkContext: vi.fn(),
  };
  return {
    getClient: (serverId) => {
      if (serverId === "source") return sourceClient;
      if (serverId === "destination") return destinationClient;
      return null;
    },
    getFeatures: (serverId) =>
      serverId === "source" ? input.sourceFeatures : input.destinationFeatures,
  } as AgentContextSubmitRuntime;
}

describe("prepareAgentContextAttachmentsForSubmit", () => {
  it("relays only ciphertext in secure mode", async () => {
    const getRecipient = vi.fn().mockResolvedValue({
      serverId: "destination",
      publicKeyB64: "destination-key",
    });
    const transfer = {
      version: 1 as const,
      destinationServerId: "destination",
      sourcePublicKeyB64: "source-key",
      ciphertextB64: "opaque-ciphertext",
    };
    const exportTransfer = vi.fn().mockResolvedValue(transfer);
    const prepared = await prepareAgentContextAttachmentsForSubmit({
      attachments: [crossHostAttachment("secure")],
      destinationServerId: "destination",
      runtime: runtime({
        sourceFeatures: { agentContextTransfer: true },
        destinationFeatures: { agentContextTransfer: true },
        getRecipient,
        exportTransfer,
      }),
    });

    expect(getRecipient).toHaveBeenCalledOnce();
    expect(exportTransfer).toHaveBeenCalledWith({
      agentId: "agent-1",
      destination: { serverId: "destination", publicKeyB64: "destination-key" },
    });
    expect(prepared[0]).toMatchObject({ kind: "agent_context", transfer });
    expect(JSON.stringify(prepared)).not.toContain("transcript body");
  });

  it("uses source-curated readable text only for an explicitly selected compatibility mode", async () => {
    const buildForkContext = vi.fn().mockResolvedValue({
      requestId: "request-1",
      agentId: "agent-1",
      attachment: {
        type: "text",
        mimeType: "text/plain",
        contextKind: "chat_history",
        text: "curated transcript body",
      },
      itemCount: 2,
      boundaryMessageId: "message-2",
      boundaryCursor: null,
      error: null,
    });
    const original = crossHostAttachment("compatibility");
    const prepared = await prepareAgentContextAttachmentsForSubmit({
      attachments: [original],
      destinationServerId: "destination",
      runtime: runtime({
        sourceFeatures: { agentForkContext: true },
        destinationFeatures: {},
        buildForkContext,
      }),
    });

    expect(prepared[0]).toMatchObject({
      kind: "chat_history",
      attachment: { text: "curated transcript body" },
    });
    expect(JSON.stringify(original)).not.toContain("curated transcript body");
  });

  it("does not silently downgrade a secure selection when capabilities change", async () => {
    await expect(
      prepareAgentContextAttachmentsForSubmit({
        attachments: [crossHostAttachment("secure")],
        destinationServerId: "destination",
        runtime: runtime({
          sourceFeatures: { agentContextTransfer: true, agentForkContext: true },
          destinationFeatures: {},
        }),
      }),
    ).rejects.toThrow("Reattach the agent to choose compatibility transfer");
  });

  it("rejects compatibility state without the explicit confirmation marker", async () => {
    const unconfirmed = {
      kind: "agent_context",
      source: { serverId: "source", agentId: "agent-1", title: "Source" },
      crossHost: { destinationServerId: "destination", mode: "compatibility" },
    } as unknown as AgentContextAttachment;

    await expect(
      prepareAgentContextAttachmentsForSubmit({
        attachments: [unconfirmed],
        destinationServerId: "destination",
        runtime: runtime({
          sourceFeatures: { agentForkContext: true },
          destinationFeatures: {},
        }),
      }),
    ).rejects.toThrow("Compatibility transfer requires explicit confirmation");
  });
});
