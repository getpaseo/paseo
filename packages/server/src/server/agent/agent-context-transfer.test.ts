import { generateKeyPair } from "@getpaseo/relay/e2ee";
import { describe, expect, it } from "vitest";
import {
  AGENT_CONTEXT_TRANSFER_ATTACHMENT_MAX_BYTES,
  AgentContextTransferError,
  createAgentContextTransferCrypto,
} from "./agent-context-transfer.js";

function chatHistory(text: string) {
  return {
    type: "text" as const,
    mimeType: "text/plain" as const,
    contextKind: "chat_history" as const,
    title: "Chat history",
    text,
  };
}

describe("agent context transfer crypto", () => {
  it("seals a curated attachment for one destination daemon", () => {
    const source = createAgentContextTransferCrypto({
      serverId: "source-host",
      keyPair: generateKeyPair(),
      now: () => new Date("2026-08-23T00:00:00.000Z"),
    });
    const destination = createAgentContextTransferCrypto({
      serverId: "destination-host",
      keyPair: generateKeyPair(),
    });
    const attachment = chatHistory("[User] Diagnose the session importer.");

    const envelope = source.seal({
      destination: destination.getRecipient(),
      sourceAgentId: "source-agent",
      attachment,
    });

    expect(envelope).toMatchObject({
      version: 1,
      destinationServerId: "destination-host",
      sourcePublicKeyB64: source.getRecipient().publicKeyB64,
    });
    expect(JSON.stringify(envelope)).not.toContain("Diagnose the session importer");
    expect(
      destination.open({
        envelope,
        sourceAgentId: "source-agent",
        maxBytes: AGENT_CONTEXT_TRANSFER_ATTACHMENT_MAX_BYTES,
      }),
    ).toEqual(attachment);
  });

  it("rejects an envelope on a daemon other than its recipient", () => {
    const source = createAgentContextTransferCrypto({
      serverId: "source-host",
      keyPair: generateKeyPair(),
    });
    const destination = createAgentContextTransferCrypto({
      serverId: "destination-host",
      keyPair: generateKeyPair(),
    });
    const other = createAgentContextTransferCrypto({
      serverId: "other-host",
      keyPair: generateKeyPair(),
    });
    const envelope = source.seal({
      destination: destination.getRecipient(),
      sourceAgentId: "source-agent",
      attachment: chatHistory("Private context"),
    });

    expect(() =>
      other.open({
        envelope,
        sourceAgentId: "source-agent",
        maxBytes: AGENT_CONTEXT_TRANSFER_ATTACHMENT_MAX_BYTES,
      }),
    ).toThrow("encrypted for another host");
  });

  it("rejects ciphertext modified after export", () => {
    const source = createAgentContextTransferCrypto({
      serverId: "source-host",
      keyPair: generateKeyPair(),
    });
    const destination = createAgentContextTransferCrypto({
      serverId: "destination-host",
      keyPair: generateKeyPair(),
    });
    const envelope = source.seal({
      destination: destination.getRecipient(),
      sourceAgentId: "source-agent",
      attachment: chatHistory("Private context"),
    });
    const replacement = envelope.ciphertextB64[0] === "A" ? "B" : "A";
    const tampered = {
      ...envelope,
      ciphertextB64: replacement + envelope.ciphertextB64.slice(1),
    };

    expect(() =>
      destination.open({
        envelope: tampered,
        sourceAgentId: "source-agent",
        maxBytes: AGENT_CONTEXT_TRANSFER_ATTACHMENT_MAX_BYTES,
      }),
    ).toThrow(AgentContextTransferError);
  });

  it("enforces the destination prompt budget after decryption", () => {
    const source = createAgentContextTransferCrypto({
      serverId: "source-host",
      keyPair: generateKeyPair(),
    });
    const destination = createAgentContextTransferCrypto({
      serverId: "destination-host",
      keyPair: generateKeyPair(),
    });
    const envelope = source.seal({
      destination: destination.getRecipient(),
      sourceAgentId: "source-agent",
      attachment: chatHistory("x".repeat(4_096)),
    });

    expect(() =>
      destination.open({ envelope, sourceAgentId: "source-agent", maxBytes: 1_024 }),
    ).toThrow("exceeds this prompt's attachment budget");
  });

  it("binds the source agent identity inside the encrypted capsule", () => {
    const source = createAgentContextTransferCrypto({
      serverId: "source-host",
      keyPair: generateKeyPair(),
    });
    const destination = createAgentContextTransferCrypto({
      serverId: "destination-host",
      keyPair: generateKeyPair(),
    });
    const envelope = source.seal({
      destination: destination.getRecipient(),
      sourceAgentId: "source-agent",
      attachment: chatHistory("Private context"),
    });

    expect(() =>
      destination.open({
        envelope,
        sourceAgentId: "different-agent",
        maxBytes: AGENT_CONTEXT_TRANSFER_ATTACHMENT_MAX_BYTES,
      }),
    ).toThrow("source identity does not match");
  });
});
